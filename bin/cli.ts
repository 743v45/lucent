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
  .option('--no-open', '不自动打开浏览器')
  .action((options) => {
    const serverPath = join(__dirname, '../server/index.js');

    // 构建环境变量，传递给子进程
    const envOverrides: Record<string, string> = {};
    if (options.host)       envOverrides.LUCENT_HOST        = options.host;
    if (options.port)       envOverrides.LUCENT_WEB_PORT    = String(options.port);
    if (options.proxyPort)  envOverrides.LUCENT_PROXY_PORT  = String(options.proxyPort);
    if (options.logDir)     envOverrides.LUCENT_LOG_DIR     = options.logDir;

    console.log('[Lucent] 正在启动...');

    const child = spawn('node', [serverPath], {
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
    setTimeout(() => {
      if (options.open !== false) {
        open(`http://${openHost}:${openPort}`).catch((err: { message: string }) => {
          console.warn('[Lucent] 无法自动打开浏览器:', err.message);
        });
      }
    }, 1000);

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

program.parse();
