/**
 * 日志写入服务（SQLite 后端）
 *
 * 决策③：SQLite 上线即唯一存储，无双写。init 时由 db-instance 开库 + 一次性迁移现有 JSONL，
 * 之后 writeLogEntry 直接 insertLog 进 SQLite（事务原子），不再 appendFile / 轮转。
 *
 * 仍走异步写入队列：串行化写入保证顺序、背压防 OOM、不阻塞代理热路径（interceptor 不 await 也安全）。
 * better-sqlite3 是同步 API，单条 insertLog 仅几十 µs，包在队列 microtask 里执行。
 */

import { insertLog, deleteOldLogs, vacuum } from './db.js';
import { initDb, getDb } from './db-instance.js';
import { invalidateCache as invalidateReaderCache } from './log-reader.js';
import type { RawLogEntry } from '../types.js';
import type { ResolvedConfig } from '../config.js';
import createDebug from 'debug';
const dbg = createDebug('lucent:log-writer');

// ==================== 状态 ====================

let resolvedConfig: ResolvedConfig;

/** 异步写入队列：串行化写入，保证顺序、消除竞态 */
let writeQueue: Promise<void> = Promise.resolve();

/** 写入队列长度上限：高频时拒绝新条目入队，防止 OOM */
const WRITE_QUEUE_MAX_LENGTH = 10000;
let writeQueueLength = 0;
let droppedCount = 0;
let failedCount = 0;

/** drainWriteQueue 超时（毫秒）：与 interceptor 的 drainPendingSSETasks 风格一致 */
const DRAIN_TIMEOUT_MS = 5000;

// ==================== 初始化 ====================

/**
 * 初始化：开库 + 建表 + 一次性迁移现有 JSONL（幂等）。
 * 迁移结果记 debug；之后 live 读写只走 SQLite。
 */
export function init(resolvedCfg: ResolvedConfig): void {
  resolvedConfig = resolvedCfg;
  const mig = initDb(resolvedCfg.dbPath, resolvedCfg.logDir);
  dbg('init: dbPath=%s 迁移 imported=%d skipped=%d errors=%d files=%d',
    resolvedCfg.dbPath, mig.imported, mig.skipped, mig.errors, mig.files);
}

/**
 * 当前存储路径（SQLite 单库）。供状态展示用。
 */
export function getCurrentLogFile(): string | null {
  return resolvedConfig?.dbPath ?? null;
}

// ==================== 写入 ====================

/**
 * 将一个任务串行追加到写入队列（保证互斥）
 */
function enqueue(task: () => void): void {
  writeQueueLength++;
  writeQueue = writeQueue
    .then(async () => {
      try {
        await task();
      } catch (error) {
        failedCount++;
        dbg('队列任务失败 (failedCount=%d): %O', failedCount, error);
      }
    })
    .finally(() => {
      writeQueueLength--;
    });
}

/**
 * 写入日志条目（异步，通过队列串行化保证顺序；事务原子，三表一致）
 *
 * 跳过无响应条目（response=null，错误路径）：原 JSONL 路径会写入但 readLogs 过滤掉，
 * SQLite 路径直接不写——DB 只存完整条目，读路径无需再过滤，也不浪费行。
 */
export function writeLogEntry(entry: RawLogEntry): void {
  if (entry.response == null) {
    dbg('跳过无响应条目 id=%s（不写入）', entry.id);
    return;
  }
  // 背压：队列超限时拒绝新条目入队（FIFO 保护已排队写入，防止 OOM）
  if (writeQueueLength >= WRITE_QUEUE_MAX_LENGTH) {
    droppedCount++;
    dbg('写入队列背压: 丢弃新条目 (length=%d droppedCount=%d)', writeQueueLength, droppedCount);
    return;
  }
  enqueue(() => {
    insertLog(getDb(), entry);
  });
}

/**
 * 等待所有挂起的写入完成（带超时，shutdown 时 IO hang 不会永久阻塞）
 */
export async function drainWriteQueue(): Promise<void> {
  let timedOut = false;
  const timer = new Promise<void>(resolve => {
    setTimeout(() => {
      timedOut = true;
      resolve();
    }, DRAIN_TIMEOUT_MS);
  });

  await Promise.race([writeQueue, timer]);

  if (timedOut) {
    dbg('drainWriteQueue 超时 %dms，放弃等待挂起写入继续退出', DRAIN_TIMEOUT_MS);
  }
}

// ==================== 保留期清理 ====================

/**
 * 清理过期日志：DELETE 早于保留期的行（级联 log_bodies + FTS），再 VACUUM 回收空间。
 * 决策④：保留期默认 3 天，env LUCENT_LOG_RETENTION_DAYS 可调。
 */
export function cleanupOldLogs(): void {
  const retentionDays = resolvedConfig.logRetentionDays;
  const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const cutoffISO = new Date(cutoffMs).toISOString();
  const n = deleteOldLogs(getDb(), cutoffISO);
  if (n > 0) {
    vacuum(getDb());
    // 旧日志已删，顺带丢掉读路径按 id 记忆的提取结果（id 不复用，残留只占内存，
    // 2000 FIFO 上限也兜得住；清一下更干净）。
    invalidateReaderCache();
    dbg('清理过期日志: 删除 %d 行 (retention=%d天)', n, retentionDays);
  }
}
