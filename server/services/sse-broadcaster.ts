/**
 * SSE 广播服务
 *
 * 管理 SSE 客户端连接和日志广播
 * 从 index.ts 提取而来
 */

import type { LogEntry } from '../types.js';
import createDebug from 'debug';
const dbgSse = createDebug('agentproxy:server:sse');

// ==================== SSE 客户端管理 ====================

const sseClients = new Set<any>(); // Express Response 对象

/**
 * 获取 SSE 客户端数量
 */
export function getClientCount(): number {
  return sseClients.size;
}

/**
 * 注册 SSE 客户端
 */
export function addClient(res: any): void {
  sseClients.add(res);
  dbgSse('SSE 客户端连接, 总数: %d', sseClients.size);
}

/**
 * 移除 SSE 客户端
 */
export function removeClient(res: any): void {
  sseClients.delete(res);
  dbgSse('SSE 客户端断开, 总数: %d', sseClients.size);
}

/**
 * 广播日志条目到所有 SSE 客户端
 */
export function broadcastLogEntry(entry: LogEntry): void {
  dbgSse('广播日志: id=%s clients=%d', entry.id, sseClients.size);
  sseClients.forEach((res: any) => {
    try {
      res.write(`event: log\ndata: ${JSON.stringify(entry)}\n\n`);
    } catch {
      sseClients.delete(res);
    }
  });
}

/**
 * 关闭所有 SSE 连接
 */
export function closeAllClients(): void {
  sseClients.forEach((res: any) => {
    try { res.end(); } catch {}
  });
  sseClients.clear();
}
