/**
 * SSE 客户端总线：被 /api/logs/stream 路由（注册/注销）与 LogWriter（广播）共享。
 *
 * 接通实时推送：日志落库后向所有已连接前端推送 `event: log`，前端 EventSource
 * 收到后经 formatLog 入列表。写入失败 / 持续背压 / 连接超上限的客户端自动剔除。
 *
 * 安全要点：
 * - 所有 res.write 统一收敛到 writeSse（try/catch），避免坏连接裸 write 抛错冒泡为
 *   uncaughtException 拖垮整个进程（server/index.ts 的 uncaughtException 会 process.exit(1)）。
 * - write 返回 false（背压）持续累积达阈值即剔除，防止慢客户端内部缓冲无限堆积。
 */
import type { Response } from 'express';
import type { LogEntry } from './types.js';
import createDebug from 'debug';

const dbg = createDebug('lucent:sse-bus');

/** SSE 客户端连接数上限（防慢客户端堆积 + DoS；超限由 stream 路由回 503） */
export const MAX_SSE_CLIENTS = 50;
/** 连续背压次数达到阈值即剔除客户端（防慢客户端内部缓冲无限堆积） */
const MAX_BACKPRESSURE_STREAK = 3;

/** 已连接的 SSE 客户端集合 */
const clients = new Set<Response>();
/** 每个客户端连续背压次数（write 返回 false 累加；成功写入清零；剔除时移除） */
const backpressure = new Map<Response, number>();

/**
 * 单点写入：try/catch 包裹 + 背压检测。
 * @returns false 表示客户端已不可用（写抛错或持续背压达阈值），调用方应剔除 + destroy
 */
export function writeSse(res: Response, payload: string): boolean {
  try {
    const ok = res.write(payload);
    if (ok) {
      backpressure.set(res, 0);
      return true;
    }
    // 背压：缓冲已过 highWaterMark，记录连续次数，超阈值即让调用方剔除
    const streak = (backpressure.get(res) ?? 0) + 1;
    backpressure.set(res, streak);
    dbg('SSE 背压 streak=%d/%d', streak, MAX_BACKPRESSURE_STREAK);
    return streak < MAX_BACKPRESSURE_STREAK;
  } catch (err) {
    dbg('SSE 写入失败: %O', err);
    return false;
  }
}

/**
 * 统一清理：清心跳定时器 + 注销广播集合 + 清背压状态 + destroy。
 * 幂等（close/error/心跳异常三处都可能触发，重复调用安全）。
 */
export function destroySseClient(res: Response, heartbeat?: NodeJS.Timeout): void {
  if (heartbeat) clearInterval(heartbeat);
  const removed = clients.delete(res);
  backpressure.delete(res);
  // typeof 守卫：测试 mock / 已销毁的 res 可能没有 destroy
  if (typeof res.destroy === 'function') {
    try {
      res.destroy();
    } catch {
      /* 已销毁，忽略 */
    }
  }
  if (removed) dbg('SSE 客户端销毁 (total=%d)', clients.size);
}

export function registerSseClient(res: Response): boolean {
  if (clients.size >= MAX_SSE_CLIENTS) {
    dbg('SSE 客户端拒绝（超上限 %d，current=%d）', MAX_SSE_CLIENTS, clients.size);
    return false;
  }
  clients.add(res);
  dbg('SSE 客户端注册 (total=%d)', clients.size);
  return true;
}

export function unregisterSseClient(res: Response): void {
  clients.delete(res);
  backpressure.delete(res);
  dbg('SSE 客户端注销 (total=%d)', clients.size);
}

/** 当前已连接的 SSE 客户端数（stream 路由判断上限 / 测试观测清理用） */
export function getSseClientCount(): number {
  return clients.size;
}

/** 向所有已连接客户端广播一条新日志。写失败 / 持续背压的客户端自动剔除。 */
export function broadcastLog(log: LogEntry): void {
  if (clients.size === 0) return;
  const payload = `event: log\ndata: ${JSON.stringify(log)}\n\n`;
  // 拷贝一份迭代：循环中可能变更 clients（剔除）
  for (const res of [...clients]) {
    if (!writeSse(res, payload)) {
      destroySseClient(res);
    }
  }
}
