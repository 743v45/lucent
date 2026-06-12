/**
 * 日志写入服务
 *
 * 统一管理日志文件的初始化、轮转、清理和写入
 * 使用异步 I/O + 写入队列，不阻塞事件循环
 */

import { appendFile, mkdir, stat, unlink, readdir } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { LOG_ENTRY_SEPARATOR, escapeLogContent } from '../constants.js';
import type { RawLogEntry } from '../types.js';
import type { ResolvedConfig } from '../config.js';
import createDebug from 'debug';
const dbg = createDebug('lucent:log-writer');

// ==================== 状态 ====================

let resolvedConfig: ResolvedConfig;
let currentLogFile: string | null = null;

/** 异步写入队列：串行化写入，保证顺序 */
let writeQueue: Promise<void> = Promise.resolve();

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
 * 写入日志条目（异步，通过队列串行化保证顺序）
 */
export function writeLogEntry(entry: RawLogEntry): void {
  if (!currentLogFile) {
    initLogDir();
    currentLogFile = generateLogFilePath();
  }

  const line = escapeLogContent(JSON.stringify(entry)) + LOG_ENTRY_SEPARATOR;
  const file = currentLogFile;

  writeQueue = writeQueue.then(async () => {
    try {
      await appendFile(file, line);
    } catch (error) {
      dbg('写入日志失败: %O', error);
    }
  });
}

/**
 * 等待所有挂起的写入完成
 */
export async function drainWriteQueue(): Promise<void> {
  await writeQueue;
}

// ==================== 轮转 ====================

/**
 * 检查并轮转日志文件（当文件超过大小限制时）
 */
export async function checkAndRotateLogFile(): Promise<void> {
  if (!currentLogFile || !existsSync(currentLogFile)) return;

  try {
    const stats_ = await stat(currentLogFile);
    if (stats_.size >= resolvedConfig.maxLogFileSize) {
      // 等待挂起写入完成后再轮转
      await drainWriteQueue();
      dbg('日志文件达到大小限制，轮转中...');
      currentLogFile = generateLogFilePath();
      dbg('日志轮转: 新文件=%s', currentLogFile);
    }
  } catch (error) {
    dbg('检查日志文件大小失败: %O', error);
  }
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
