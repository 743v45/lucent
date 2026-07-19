/**
 * SSE 客户端总线：被 /api/logs/stream 路由（注册/注销）与 LogWriter（广播）共享。
 *
 * 接通实时推送：日志落库后向所有已连接前端推送 `event: log`，前端 EventSource
 * 收到后经 formatLog 入列表。写入失败的客户端自动剔除。
 */
import type { Response } from 'express';
import type { LogEntry } from './types.js';
import createDebug from 'debug';

const dbg = createDebug('lucent:sse-bus');

/** 已连接的 SSE 客户端集合 */
const clients = new Set<Response>();

export function registerSseClient(res: Response): void {
  clients.add(res);
  dbg('SSE 客户端注册 (total=%d)', clients.size);
}

export function unregisterSseClient(res: Response): void {
  clients.delete(res);
  dbg('SSE 客户端注销 (total=%d)', clients.size);
}

/** 向所有已连接客户端广播一条新日志。写入失败的客户端自动剔除。 */
export function broadcastLog(log: LogEntry): void {
  if (clients.size === 0) return;
  const payload = `event: log\ndata: ${JSON.stringify(log)}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch (err) {
      dbg('SSE 写入失败，剔除客户端: %O', err);
      clients.delete(res);
    }
  }
}
