/**
 * Lucent 服务器入口
 *
 * 整合代理服务器 + Web UI 服务
 * 路由、日志管理、SSE 广播等已拆分到对应模块
 */

import express from 'express';
import type { Request, Response } from 'express';
import compression from 'compression';
import { createServer as createHttpServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import * as Config from './config.js';
import * as LogWriter from './services/log-writer.js';
import * as LogReader from './services/log-reader.js';
import { mountRoutes } from './routes/index.js';
import { startProxyServer } from './proxy.js';
import { setupInterceptor, drainPendingSSETasks } from './interceptor.js';
import { drainWriteQueue } from './services/log-writer.js';
import { closeDb } from './services/db-instance.js';
import { startTempCleanupTimer, stopTempCleanupTimer } from './services/temp-cleanup-scheduler.js';
import { isSseDebugEnabled } from './sse-extractor.js';
import './endpoint-handlers.js'; // 注册端点类型处理器
import type { ProxyStatus } from './types.js';
import type { ResolvedConfig } from './config.js';
import createDebug from 'debug';
const dbg = createDebug('lucent:server');

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ==================== 运行时状态 ====================

let resolvedConfig!: ResolvedConfig;
let proxyEnabled = false;
let proxyServer: Awaited<ReturnType<typeof startProxyServer>> | null = null;
// 保留期清理定时器（定期 DELETE 旧行 + VACUUM；shutdown 时清掉）
let retentionTimer: NodeJS.Timeout | null = null;
// 临时日志清理定时器已封装到 temp-cleanup-scheduler（按 logMode 自适应启停），无 module-level 变量

// ==================== Express 应用 ====================

/**
 * compression 过滤器：SSE（text/event-stream）强制不压缩（Bug #13）。
 *
 * 默认 compression.filter 用 compressible 判定，text/event-stream 被判为可压缩 → SSE 分块写入
 * 被 zlib 缓冲，实时推送退化成成批到达、心跳长时间收不到。这里在默认判定前短路 SSE → false，
 * 其余 Content-Type 仍走默认口径。导出以便单测。
 */
export function sseAwareCompressionFilter(req: Request, res: Response): boolean {
  const ct = String(res.getHeader('Content-Type') || '');
  if (ct.includes('text/event-stream')) return false;
  return compression.filter(req, res);
}

const app = express();
app.use(compression({ filter: sseAwareCompressionFilter }));
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
  await LogWriter.cleanupOldLogs();

  // 定期保留期清理（决策④：DELETE 旧行 + VACUUM）。启动时已清一次；长驻进程靠这个定时
  // 兜底（每 24h）。unref：不阻止进程退出（shutdown 时显式 clearInterval）。
  const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;
  retentionTimer = setInterval(() => {
    try { LogWriter.cleanupOldLogs(); } catch (err) { dbg('定时保留期清理失败: %O', err); }
  }, RETENTION_INTERVAL_MS);
  retentionTimer.unref();

  // 临时日志过期清理定时器（按 logMode 自适应启停）：启动清一次 + 周期清理；
  // temporary 常驻 / off·archive 存量清完自停 / 切回 temporary 由 /api/recording 重启。
  startTempCleanupTimer();

  // 启动代理服务器
  const proxyPort = resolvedConfig.proxyPort;
  const host = resolvedConfig.host;
  try {
    proxyServer = await startProxyServer({ port: proxyPort, host });
  } catch (error: any) {
    console.error('[Lucent] 代理服务器启动失败:', error.message);
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
      // 聚合启动信息
      const lines: string[] = [
        `Web UI:  http://${host}:${webPort}`,
        `Proxy:   http://${host}:${proxyPort}`,
        `Logs:    ${resolvedConfig.logDir}`,
      ];

      if (isSseDebugEnabled()) {
        lines.push(`SSE Debug: ON → /tmp/lucent-sse-debug/`);
      }

      // 供应商接入指令
      for (const p of resolvedConfig.providers) {
        const prefix = p.presetName ? '' : 'custom/';
        const cmds: string[] = [];
        if (p.endpoints['anthropic-messages'])
          cmds.push(`ANTHROPIC_BASE_URL=http://${host}:${proxyPort}/${prefix}${p.name}`);
        if (p.endpoints['openai-chat'] || p.endpoints['openai-responses'])
          cmds.push(`OPENAI_BASE_URL=http://${host}:${proxyPort}/${prefix}${p.name}/v1`);
        if (cmds.length > 0)
          lines.push(``, `${p.name}:`, ...cmds.map(c => `  export ${c}`));
      }

      console.log(`\n[Lucent]${lines.map(l => l ? ` ${l}` : '').join('\n')}\n`);

      resolve();
    });

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`[Lucent] ⚠️ Web UI 端口 ${webPort} 已被占用，请检查是否有其他 Lucent 实例正在运行`);
        console.error(`[Lucent]   提示: lsof -i :${webPort} 或 kill $(lsof -ti :${webPort})`);
      } else {
        console.error('[Lucent] Web 服务器错误:', err.message);
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
  console.log('[Lucent] 关闭服务器...');

  // 停掉保留期清理定时器
  if (retentionTimer) { clearInterval(retentionTimer); retentionTimer = null; }
  // 停掉临时日志清理定时器（temp-cleanup-scheduler）
  stopTempCleanupTimer();

  // 先停代理入口：拒绝新请求、等在途请求完成（其日志会经 writeLogEntry 入写队列）。
  // 必须在 closeDb 之前（Bug #4）：否则在途请求完成后走 insertLog(getDb())，此时 DB 已关，
  // getDb() 抛错被 enqueue 吞掉 → 日志丢失。
  if (proxyServer) {
    await proxyServer.stop().catch(err => dbg('关闭代理服务器失败: %O', err));
    proxyServer = null;
  }

  // 等待后台 SSE 任务完成（它们会把最终日志入写队列），确保数据不丢失
  await drainPendingSSETasks();

  // 等待所有挂起的日志写入完成
  await drainWriteQueue();
  // 关闭数据库（WAL checkpoint 落盘）
  closeDb();

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
  startServer().catch(async (error) => {
    console.error('[Lucent] 启动失败:', error.message);
    // 启动失败（如端口占用）也要优雅收尾：drainWriteQueue + closeDb(wal_checkpoint(TRUNCATE))。
    // 否则本轮已执行的初始化/清理写入堆在 WAL 不落盘，反复启动会把 WAL 撑爆。
    await shutdownServer();
    process.exit(1);
  });

  // 正常信号处理
  process.on('SIGINT', async () => {
    console.log('[Lucent] 收到 SIGINT 信号，正在关闭...');
    await shutdownServer();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('[Lucent] 收到 SIGTERM 信号，正在关闭...');
    await shutdownServer();
    process.exit(0);
  });

  // 异常退出处理
  process.on('uncaughtException', async (error) => {
    console.error('[Lucent] 未捕获异常，正在关闭...');
    dbg('uncaughtException: %O', error);
    await shutdownServer();
    process.exit(1);
  });

  process.on('unhandledRejection', async (reason, promise) => {
    console.error('[Lucent] 未处理的 Promise rejection，正在关闭...');
    dbg('unhandledRejection at %O: %O', promise, reason);
    await shutdownServer();
    process.exit(1);
  });
}
