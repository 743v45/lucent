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
import * as LogReader from './services/log-reader.js';
import { mountRoutes } from './routes/index.js';
import { startProxyServer } from './proxy.js';
import { setupInterceptor, drainPendingSSETasks } from './interceptor.js';
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
  resolvedConfig: {
    get logDir() { return resolvedConfig.logDir; },
    heartbeatIntervalMs: 30000,
  },
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
  LogReader.init(resolvedConfig);
  LogWriter.cleanupOldLogs();

  // 启动代理服务器
  const proxyPort = resolvedConfig.proxyPort;
  const host = resolvedConfig.host;
  try {
    proxyServer = await startProxyServer({ port: proxyPort, host });
  } catch (error: any) {
    console.error('[AgentProxy] 代理服务器启动失败:', error.message);
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

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`[AgentProxy] ⚠️ Web UI 端口 ${webPort} 已被占用，请检查是否有其他 AgentProxy 实例正在运行`);
        console.error(`[AgentProxy]   提示: lsof -i :${webPort} 或 kill $(lsof -ti :${webPort})`);
      } else {
        console.error('[AgentProxy] Web 服务器错误:', err.message);
      }
      reject(err);
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

export async function shutdownServer(): Promise<void> {
  console.log('[AgentProxy] 关闭服务器...');

  // 等待后台 SSE 任务完成，确保数据不丢失
  await drainPendingSSETasks();

  if (proxyServer) {
    await proxyServer.stop().catch(err => dbg('关闭代理服务器失败: %O', err));
    proxyServer = null;
  }

  server.close();
}

// ==================== 服务联动关闭 ====================

/**
 * 当 Web server 关闭时，同步关闭 proxy server
 * 确保两个服务生命周期一致
 */
server.on('close', () => {
  dbg('Web server 已关闭，同步关闭 proxy server');
  if (proxyServer) {
    proxyServer.stop().catch(err => dbg('关闭代理服务器失败: %O', err));
    proxyServer = null;
  }
});

// ==================== 直接运行 ====================

if (import.meta.url === `file://${process.argv[1]}`) {
  startServer().catch(error => {
    console.error('[AgentProxy] 启动失败:', error.message);
    process.exit(1);
  });

  // 正常信号处理
  process.on('SIGINT', async () => {
    console.log('[AgentProxy] 收到 SIGINT 信号，正在关闭...');
    await shutdownServer();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('[AgentProxy] 收到 SIGTERM 信号，正在关闭...');
    await shutdownServer();
    process.exit(0);
  });

  // 异常退出处理
  process.on('uncaughtException', async (error) => {
    console.error('[AgentProxy] 未捕获异常，正在关闭...');
    dbg('uncaughtException: %O', error);
    await shutdownServer();
    process.exit(1);
  });

  process.on('unhandledRejection', async (reason, promise) => {
    console.error('[AgentProxy] 未处理的 Promise rejection，正在关闭...');
    dbg('unhandledRejection at %O: %O', promise, reason);
    await shutdownServer();
    process.exit(1);
  });
}
