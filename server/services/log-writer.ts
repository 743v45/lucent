/**
 * 日志写入服务
 *
 * 统一管理日志文件的初始化、轮转、清理和写入
 * 合并了原 index.ts 和 interceptor.ts 中的日志管理逻辑
 */

import { appendFileSync, mkdirSync, existsSync, statSync, unlinkSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { LOG_ENTRY_SEPARATOR } from '../constants.js';
import type { RawLogEntry } from '../types.js';
import type { ResolvedConfig } from '../config.js';
import createDebug from 'debug';
const dbg = createDebug('lucent:log-writer');

// ==================== 状态 ====================

let resolvedConfig: ResolvedConfig;
let currentLogFile: string | null = null;

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
 * 写入日志条目
 *
 * entry 可以携带任意 RawLogEntry 字段，包括 providerName（请求经过的供应商名）
 * 和 endpointType（使用的端点协议），由调用方（proxy.ts）传入。
 */
export function writeLogEntry(entry: RawLogEntry): void {
  if (!currentLogFile) {
    initLogDir();
    currentLogFile = generateLogFilePath();
  }

  try {
    const line = JSON.stringify(entry) + LOG_ENTRY_SEPARATOR;
    appendFileSync(currentLogFile, line);
  } catch (error) {
    dbg('写入日志失败: %O', error);
  }
}

// ==================== 轮转 ====================

/**
 * 检查并轮转日志文件（当文件超过大小限制时）
 */
export function checkAndRotateLogFile(): void {
  if (!currentLogFile || !existsSync(currentLogFile)) return;

  try {
    const stats = statSync(currentLogFile);
    if (stats.size >= resolvedConfig.maxLogFileSize) {
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
export function cleanupOldLogs(): void {
  try {
    if (!existsSync(resolvedConfig.logDir)) return;

    const now = Date.now();
    const maxAge = resolvedConfig.logRetentionDays * 24 * 60 * 60 * 1000;

    const files = readdirSync(resolvedConfig.logDir).filter(f => f.endsWith('.jsonl'));

    for (const file of files) {
      const filePath = join(resolvedConfig.logDir, file);
      try {
        const stats = statSync(filePath);
        const age = now - stats.mtimeMs;

        if (age > maxAge) {
          unlinkSync(filePath);
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
