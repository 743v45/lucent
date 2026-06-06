/**
 * AgentProxy 服务器入口
 *
 * 整合代理服务器 + Web UI 服务
 * 路由、日志管理、SSE 广播等已拆分到对应模块
 */

import express from 'express';
import compression from 'compression';
import { createServer as createHttpServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import open from 'open';
import * as Config from './config.js';
import * as LogWriter from './services/log-writer.js';
import * as SseBroadcaster from './services/sse-broadcaster.js';
import { mountRoutes } from './routes/index.js';
import { startProxyServer } from './proxy.js';
import { setupInterceptor } from './interceptor.js';
import type { ProxyStatus } from './types.js';
import type { ResolvedConfig } from './config.js';
import createDebug from 'debug';
const dbg = createDebug('agentproxy:server');

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ==================== 运行时状态 ====================

let resolvedConfig!: ResolvedConfig;
let proxyEnabled = false;
let proxyServer: Awaited<ReturnType<typeof startProxyServer>> | null = null;

// ==================== Express 应用 ====================

const app = express();
app.use(compression());
app.use(express.json());

// 静态文件服务
app.use(express.static(join(__dirname, '../dist')));
app.use(express.static(join(__dirname, '../public')));

// 挂载所有 API 路由
mountRoutes(app, {
  proxyEnabled: { get value() { return proxyEnabled; }, set value(v) { proxyEnabled = v; } },
  getLogFile: () => LogWriter.getCurrentLogFile(),
  resolvedConfig: { get logDir() { return resolvedConfig.logDir; }, get heartbeatIntervalMs() { return resolvedConfig.heartbeatIntervalMs; } },
  onLogsEnable: () => { /* 日志文件已在 LogWriter.init 中初始化 */ },
});

// ==================== HTTP 服务器 ====================

const server = createHttpServer(app);

// ==================== 启动 ====================

export async function startServer(): Promise<void> {
  Config.loadConfig();
  resolvedConfig = Config.resolveEffectiveConfig();

  // 初始化日志服务
  LogWriter.init(resolvedConfig);
  LogWriter.cleanupOldLogs();

  // 启动代理服务器
  const proxyPort = resolvedConfig.proxyPort;
  const host = resolvedConfig.host;
  try {
    proxyServer = await startProxyServer({ port: proxyPort, host });
    dbg('代理服务器已启动: port=%d host=%s', proxyPort, host);
  } catch (error) {
    dbg('代理服务器启动失败: %O', error);
    throw error;
  }

  // 设置拦截器
  try {
    setupInterceptor();
    dbg('拦截器已启动');
  } catch (error) {
    dbg('拦截器启动失败: %O', error);
  }

  // 启动 Web 服务器
  const webPort = resolvedConfig.webPort;
  return new Promise<void>((resolve, reject) => {
    server.listen(webPort, host, () => {
      console.log(`[AgentProxy] Web UI: http://${host}:${webPort}`);
      console.log(`[AgentProxy] 代理端口: ${proxyPort}`);
      console.log(`[AgentProxy] 日志目录: ${resolvedConfig.logDir}`);
      console.log('[AgentProxy] ============================');
      console.log('[AgentProxy] 接入方式 (设置环境变量):');
      console.log(`[AgentProxy]   Anthropic:  export ANTHROPIC_BASE_URL=http://${host}:${proxyPort}`);
      console.log(`[AgentProxy]   OpenAI:     export OPENAI_BASE_URL=http://${host}:${proxyPort}`);
      console.log('[AgentProxy] ============================');

      open(`http://${host}:${webPort}`).catch(err => {
        dbg('无法自动打开浏览器: %s', err.message);
      });

      resolve();
    });

    server.on('error', error => {
      dbg('服务器错误: %O', error);
      reject(error);
    });
  });
}

export function getServerStatus(): ProxyStatus {
  return {
    enabled: proxyEnabled,
    running: true,
    host: resolvedConfig.host,
    webPort: resolvedConfig.webPort,
    proxyPort: resolvedConfig.proxyPort,
    logFile: LogWriter.getCurrentLogFile(),
  };
}

export function shutdownServer(): void {
  console.log('[AgentProxy] 关闭服务器...');

  if (proxyServer) {
    proxyServer.stop().catch(err => dbg('关闭代理服务器失败: %O', err));
  }

  SseBroadcaster.closeAllClients();
  server.close();
}

// ==================== 直接运行 ====================

if (import.meta.url === `file://${process.argv[1]}`) {
  startServer().catch(error => {
    dbg('启动失败: %O', error);
    process.exit(1);
  });

  process.on('SIGINT', () => {
    console.log('[AgentProxy] 收到 SIGINT 信号，正在关闭...');
    shutdownServer();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    console.log('[AgentProxy] 收到 SIGTERM 信号，正在关闭...');
    shutdownServer();
    process.exit(0);
  });
}
