#!/usr/bin/env node
/**
 * AgentProxy CLI
 */

import { Command } from 'commander';
import { spawn } from 'child_process';
import { open } from 'open';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const program = new Command();

program
  .name('agentproxy')
  .description('AI Agent 代理服务器')
  .version('0.1.0');

program
  .command('start')
  .description('启动代理服务器和 Web UI')
  .option('-p, --port <number>', 'Web UI 端口', '7049')
  .option('--no-open', '不自动打开浏览器')
  .action((options) => {
    const serverPath = join(__dirname, '../server/index.js');

    console.log('[AgentProxy] 正在启动...');

    const child = spawn('node', [serverPath], {
      stdio: 'inherit',
      env: { ...process.env },
    });

    child.on('error', (err) => {
      console.error('[AgentProxy] 启动失败:', err.message);
      process.exit(1);
    });

    // 等待服务器启动
    setTimeout(() => {
      if (options.open !== false) {
        open(`http://127.0.0.1:${options.port}`).catch(err => {
          console.warn('[AgentProxy] 无法自动打开浏览器:', err.message);
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
    console.log('[AgentProxy] stop 功能待实现');
    console.log('[AgentProxy] 提示: 使用 Ctrl+C 停止运行中的服务器');
  });

program
  .command('status')
  .description('查看代理状态')
  .action(async () => {
    try {
      const response = await fetch('http://127.0.0.1:7049/api/status');
      const status = await response.json();

      console.log('[AgentProxy] 状态:');
      console.log(`  - 运行中: ${status.running ? '是' : '否'}`);
      console.log(`  - 代理启用: ${status.enabled ? '是' : '否'}`);
      console.log(`  - Web UI: http://127.0.0.1:${status.webPort}`);
      console.log(`  - 代理端口: ${status.proxyPort}`);
      if (status.logFile) {
        console.log(`  - 日志文件: ${status.logFile}`);
      }
    } catch {
      console.log('[AgentProxy] 服务器未运行');
    }
  });

program
  .command('logs')
  .description('查看日志')
  .option('-n, --number <num>', '显示条数', '10')
  .action(async (options) => {
    try {
      const response = await fetch(`http://127.0.0.1:7049/api/logs?limit=${options.number}`);
      const data = await response.json();

      console.log(`[AgentProxy] 最近 ${data.logs.length} 条记录:\n`);

      for (const log of data.logs) {
        const time = new Date(log.timestamp).toLocaleTimeString('zh-CN');
        const type = log.agentType === 'main' ? '[Main]' : '[Sub]';
        const model = log.metadata.model || 'Unknown';
        const duration = log.duration ? `${log.duration}ms` : 'pending';

        console.log(`  ${time} ${type} ${model} (${duration})`);
      }
    } catch {
      console.log('[AgentProxy] 无法获取日志，服务器可能未运行');
    }
  });

program.parse();
