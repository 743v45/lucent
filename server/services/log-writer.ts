/**
 * 日志写入服务
 *
 * 统一管理日志文件的初始化、轮转、清理和写入
 * 使用异步 I/O + 写入队列，不阻塞事件循环
 */

import { appendFile, rename, stat, unlink, readdir } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { RawLogEntry } from '../types.js';
import type { ResolvedConfig } from '../config.js';
import createDebug from 'debug';
const dbg = createDebug('lucent:log-writer');

// ==================== 状态 ====================

let resolvedConfig: ResolvedConfig;
let currentLogFile: string | null = null;

/** 异步写入队列：串行化写入与轮转，保证顺序、消除竞态 */
let writeQueue: Promise<void> = Promise.resolve();

/** 写入队列长度上限：高频时拒绝新条目入队，防止 OOM */
const WRITE_QUEUE_MAX_LENGTH = 10000;
let writeQueueLength = 0;
let droppedCount = 0;
let failedCount = 0;

/** drainWriteQueue 超时（毫秒）：与 interceptor 的 drainPendingSSETasks 风格一致 */
const DRAIN_TIMEOUT_MS = 5000;

// ==================== 初始化 ====================

export function init(resolvedCfg: ResolvedConfig): void {
  resolvedConfig = resolvedCfg;
  initLogDir();
  currentLogFile = generateLogFilePath();
}

/**
 * 获取当前日志文件路径
 */
export function getCurrentLogFile(): string | null {
  return currentLogFile;
}

// ==================== 日志目录 ====================

function initLogDir(): void {
  if (!existsSync(resolvedConfig.logDir)) {
    mkdirSync(resolvedConfig.logDir, { recursive: true });
  }
}

// ==================== 日志文件路径 ====================

function generateLogFilePath(): string {
  const now = new Date();
  const date = now.toISOString().split('T')[0];
  const time = now.toTimeString().split(' ')[0].replace(/:/g, '-');
  return join(resolvedConfig.logDir, `lucent_${date}_${time}.jsonl`);
}

// ==================== 写入 ====================

/**
 * 将一个异步任务串行追加到写入队列（写入 / 轮转共用，保证互斥）
 */
function enqueue(task: () => Promise<void>): void {
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
 * 写入日志条目（异步，通过队列串行化保证顺序）
 */
export function writeLogEntry(entry: RawLogEntry): void {
  if (!currentLogFile) {
    initLogDir();
    currentLogFile = generateLogFilePath();
  }

  // 标准 JSONL：一条日志 = 一行 JSON + '\n'。
  // JSON.stringify 已保证字符串值内不含裸换行，分隔符即真实换行，
  // 无需（也不可）叠加任何二次转义层。
  const line = JSON.stringify(entry) + '\n';
  const file = currentLogFile;

  // 背压：队列超限时拒绝新条目入队（FIFO 保护已排队写入，防止 OOM）
  if (writeQueueLength >= WRITE_QUEUE_MAX_LENGTH) {
    droppedCount++;
    dbg('写入队列背压: 丢弃新条目 (length=%d droppedCount=%d)', writeQueueLength, droppedCount);
    return;
  }

  enqueue(async () => {
    await appendFile(file, line);
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

// ==================== 轮转 ====================

/**
 * 检查并轮转日志文件（当文件超过大小限制时）
 *
 * 注意：判定+切换+重命名放进与写入同一个 writeQueue 串行执行，
 * 消除与写入的竞态。interceptor 不 await 也安全。
 */
export function checkAndRotateLogFile(): void {
  if (!currentLogFile) return;

  const oldFile = currentLogFile;

  enqueue(async () => {
    if (!existsSync(oldFile)) return;
    const stats_ = await stat(oldFile);
    if (stats_.size < resolvedConfig.maxLogFileSize) return;

    // 真正归档旧文件（重命名），避免旧文件无限增长
    const rotatedPath = oldFile.replace(/\.jsonl$/, `_rotated_${Date.now()}.jsonl`);
    try {
      await rename(oldFile, rotatedPath);
      dbg('日志文件达到大小限制，已归档: %s -> %s', oldFile, rotatedPath);
    } catch (error) {
      // rename 失败不崩：保留旧文件继续追加（最坏情况是单文件超限），更新指针避免下次重复尝试
      dbg('日志轮转 rename 失败（保留原文件继续写入）: %O', error);
    }

    // 无论 rename 成功与否，都切换到新文件，避免一直写同一个超限文件
    currentLogFile = generateLogFilePath();
    dbg('日志轮转: 新文件=%s', currentLogFile);
  });
}

// ==================== 清理 ====================

/**
 * 清理过期日志文件
 */
export async function cleanupOldLogs(): Promise<void> {
  try {
    if (!existsSync(resolvedConfig.logDir)) return;

    const now = Date.now();
    const maxAge = resolvedConfig.logRetentionDays * 24 * 60 * 60 * 1000;

    const files = await readdir(resolvedConfig.logDir);
    const jsonlFiles = files.filter(f => f.endsWith('.jsonl'));

    for (const file of jsonlFiles) {
      const filePath = join(resolvedConfig.logDir, file);
      try {
        const stats_ = await stat(filePath);
        const age = now - stats_.mtimeMs;

        if (age > maxAge) {
          await unlink(filePath);
          dbg('删除过期日志: %s', file);
        }
      } catch (error) {
        dbg('删除日志文件失败: %s %O', file, error);
      }
    }
  } catch (error) {
    dbg('清理日志失败: %O', error);
  }
}
