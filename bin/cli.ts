#!/usr/bin/env node
/**
 * Lucent CLI
 */

import { Command } from 'commander';
import { spawn } from 'child_process';
import open from 'open';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DEFAULT_WEB_PORT, DEFAULT_SERVER_HOST } from '../server/constants.js';
import { runCommand } from './query.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const program = new Command();

program
  .name('lucent')
  .description('AI Agent 代理服务器')
  .version(JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf-8')).version);

program
  .command('start')
  .description('启动代理服务器和 Web UI')
  .option('-p, --port <number>', 'Web UI 端口')
  .option('--proxy-port <number>', '代理服务器端口')
  .option('--host <host>', '服务器监听地址')
  .option('--log-dir <path>', '日志存储目录')
  .option('--open', '启动后自动打开浏览器')
  .action((options) => {
    const serverPath = join(__dirname, '../server/index.ts');

    // 构建环境变量，传递给子进程
    const envOverrides: Record<string, string> = {};
    if (options.host)       envOverrides.LUCENT_HOST        = options.host;
    if (options.port)       envOverrides.LUCENT_WEB_PORT    = String(options.port);
    if (options.proxyPort)  envOverrides.LUCENT_PROXY_PORT  = String(options.proxyPort);
    if (options.logDir)     envOverrides.LUCENT_LOG_DIR     = options.logDir;

    console.log('[Lucent] 正在启动...');

    // 用 tsx 运行 TS 入口（后端无编译产物，与 `npm start` 同源）
    const child = spawn(process.execPath, ['--import', 'tsx', serverPath], {
      stdio: 'inherit',
      env: { ...process.env, ...envOverrides },
    });

    child.on('error', (err) => {
      console.error('[Lucent] 启动失败:', err.message);
      process.exit(1);
    });

    // 等待服务器启动
    const openHost = options.host || DEFAULT_SERVER_HOST;
    const openPort = options.port || DEFAULT_WEB_PORT;
    if (options.open === true) {
      setTimeout(() => {
        open(`http://${openHost}:${openPort}`).catch((err: { message: string }) => {
          console.warn('[Lucent] 无法自动打开浏览器:', err.message);
        });
      }, 1000);
    }

    // 优雅退出
    process.on('SIGINT', () => {
      child.kill('SIGTERM');
      process.exit(0);
    });
  });

program
  .command('stop')
  .description('停止代理服务器')
  .action(() => {
    console.log('[Lucent] stop 功能待实现');
    console.log('[Lucent] 提示: 使用 Ctrl+C 停止运行中的服务器');
  });

program
  .command('status')
  .description('查看代理状态')
  .action(async () => {
    // 从配置文件或环境变量获取端口
    const host = process.env.LUCENT_HOST || DEFAULT_SERVER_HOST;
    const port = process.env.LUCENT_WEB_PORT
      ? parseInt(process.env.LUCENT_WEB_PORT, 10)
      : await readPortFromConfig() || DEFAULT_WEB_PORT;

    try {
      const response = await fetch(`http://${host}:${port}/api/status`);
      const status = await response.json();

      console.log('[Lucent] 状态:');
      console.log(`  - 运行中: ${status.running ? '是' : '否'}`);
      console.log(`  - 代理启用: ${status.enabled ? '是' : '否'}`);
      console.log(`  - Web UI: http://${host}:${status.webPort}`);
      console.log(`  - 代理端口: ${status.proxyPort}`);
      if (status.logFile) {
        console.log(`  - 日志文件: ${status.logFile}`);
      }
    } catch {
      console.log('[Lucent] 服务器未运行');
    }
  });

program
  .command('logs')
  .description('查看日志')
  .option('-n, --number <num>', '显示条数', '10')
  .action(async (options) => {
    const host = process.env.LUCENT_HOST || DEFAULT_SERVER_HOST;
    const port = process.env.LUCENT_WEB_PORT
      ? parseInt(process.env.LUCENT_WEB_PORT, 10)
      : await readPortFromConfig() || DEFAULT_WEB_PORT;

    try {
      const response = await fetch(`http://${host}:${port}/api/logs?limit=${options.number}`);
      const data = await response.json();

      console.log(`[Lucent] 最近 ${data.logs.length} 条记录:\n`);

      for (const log of data.logs) {
        const time = new Date(log.timestamp).toLocaleTimeString('zh-CN');
        const type = log.agentType === 'main' ? '[Main]' : '[Sub]';
        const model = log.metadata.model || 'Unknown';
        const duration = log.duration ? `${log.duration}ms` : 'pending';

        console.log(`  ${time} ${type} ${model} (${duration})`);
      }
    } catch {
      console.log('[Lucent] 无法获取日志，服务器可能未运行');
    }
  });

/**
 * 从 config.json 读取 webPort（不启动服务端）
 */
async function readPortFromConfig(): Promise<number | null> {
  try {
    const { homedir } = await import('node:os');
    const { readFileSync: rf } = await import('node:fs');
    const { join: j } = await import('node:path');
    const configPath = j(homedir(), '.lucent', 'config.json');
    const raw = rf(configPath, 'utf-8');
    const config = JSON.parse(raw);
    return config.webPort || null;
  } catch {
    return null;
  }
}

// ==================== query（给 AI 用的查询命令；逻辑在 ./query.ts） ====================

/** 给 logs/search/stats 复用的过滤选项 */
function addFilterOptions(cmd: Command): Command {
  return cmd
    .option('--provider <name>', '按供应商过滤')
    .option('--model <name>', '按模型过滤')
    .option('--agent-type <type>', 'main / sub')
    .option('--endpoint <type>', '端点协议')
    .option('--status <code>', 'HTTP 状态码')
    .option('--thread-id <id>', '会话线索 id')
    .option('--is-test', '只看测试请求')
    .option('--since <time>', '起始时间（ISO 或 7d/24h/30m）')
    .option('--until <time>', '结束时间');
}

const queryCmd = program
  .command('query')
  .description('查询日志数据（给 AI 用，直读 SQLite，默认输出 JSON，服务器无需运行）');

addFilterOptions(
  queryCmd
    .command('logs')
    .description('列出最近请求（过滤 + 游标分页）')
    .option('--db <path>', '数据库路径（默认 LUCENT_DB_PATH || ~/.lucent/lucent.db）')
    .option('--limit <n>', '条数（默认 20）', (v: string) => Number(v), 20)
    .option('--cursor <token>', '分页游标')
    .option('--fields <a,b>', '只输出指定字段（逗号分隔）')
    .option('--human', '人类可读表（默认 JSON）'),
).action((opts) => runCommand('logs', opts));

queryCmd
  .command('log <id>')
  .description('单条详情（含 request/response body，默认截断 50KB）')
  .option('--db <path>', '数据库路径')
  .option('--no-body', '不返回 body')
  .option('--max-body <bytes>', 'body 截断长度（字节）', (v: string) => Number(v), 50000)
  .option('--full-body', '不截断 body')
  .option('--human', '人类可读')
  .action((id, opts) => runCommand('log', { ...opts, id: String(id) }));

addFilterOptions(
  queryCmd
    .command('search <keyword>')
    .description('全文搜索请求/响应内容（FTS5）')
    .option('--db <path>', '数据库路径')
    .option('--limit <n>', '条数', (v: string) => Number(v), 20)
    .option('--cursor <token>', '游标')
    .option('--fields <a,b>', '字段')
    .option('--human', '人类可读'),
).action((keyword, opts) => runCommand('search', { ...opts, keyword: String(keyword) }));

addFilterOptions(
  queryCmd
    .command('stats')
    .description('统计聚合（token / 耗时 / 数量，按维度）')
    .option('--db <path>', '数据库路径')
    .option('--by <dimension>', 'provider/model/agent-type/endpoint/status/day/hour', 'model')
    .option('--human', '人类可读'),
).action((opts) => runCommand('stats', opts));

program.parse();
