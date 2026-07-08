/**
 * 日志管理模块（SQLite 后端）
 *
 * 负责日志的导入、导出、清空、统计与保留期清理，全部走 SQLite（db-instance 句柄）。
 * 旧的 JSONL readLogs/appendFile/轮转/清理重复实现已移除——存储 I/O 收敛到 services/，
 * 消解原 TODO 里「log-manager 与 log-writer 职责重复」的问题。
 *
 * 导出格式仍保留 JSONL / Markdown（导出产物，非 live 存储）。
 */

import { writeFileSync, readFileSync, statSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { LogEntry } from './types.js';
import { resolveEffectiveConfig } from './config.js';
import { listLogs, fetchBodies, getStats, clearAllLogs as dbClearAll, deleteOldLogs, vacuum, insertLogsBatch } from './services/db.js';
import { getDb } from './services/db-instance.js';
import { reconstructEntry } from './services/log-reader.js';
import createDebug from 'debug';
const log = createDebug('lucent:log-manager');

export interface LogExportOptions {
  format: 'jsonl' | 'markdown';
  includeMeta?: boolean;
}

export interface LogImportOptions {
  merge?: boolean; // 是否合并到现有（默认 true）；false 则先清空
  validate?: boolean; // 是否校验条目基本字段
}

/** 解析后的配置缓存（避免每次调用重复 resolve） */
function cfg() {
  return resolveEffectiveConfig();
}

/** 获取有效的日志目录（导出产物落这里） */
function getEffectiveLogDir(): string {
  return cfg().logDir;
}

// ==================== 统计 ====================

/**
 * 获取日志统计信息
 */
export function getLogStats(): {
  totalEntries: number;
  totalSize: number;
  fileCount: number;
  oldestEntry?: string;
  newestEntry?: string;
} {
  try {
    const db = getDb();
    const s = getStats(db);
    // 库体积：主库 + wal + shm
    const dbPath = cfg().dbPath;
    let totalSize = 0;
    for (const ext of ['', '-wal', '-shm']) {
      try {
        totalSize += statSync(dbPath + ext).size;
      } catch { /* 文件可能不存在（已 checkpoint） */ }
    }
    return {
      totalEntries: s.count,
      totalSize,
      fileCount: 1, // SQLite 单库
      oldestEntry: s.oldest ?? undefined,
      newestEntry: s.newest ?? undefined,
    };
  } catch (error) {
    log('获取日志统计失败: %O', error);
    return { totalEntries: 0, totalSize: 0, fileCount: 0 };
  }
}

// ==================== 导出 ====================

/** 取全部日志（重建为 LogEntry），供导出用 */
function loadAllLogs(): LogEntry[] {
  const db = getDb();
  const { logs: rows } = listLogs(db, { limit: Number.MAX_SAFE_INTEGER, offset: 0 });
  const bodies = fetchBodies(db, rows.map(r => r.rowid));
  const out: LogEntry[] = [];
  for (const r of rows) {
    const b = bodies.get(r.rowid);
    if (!b) continue;
    out.push(reconstructEntry(r, b.request, b.response));
  }
  return out;
}

/**
 * 导出日志到文件（JSONL / Markdown）
 */
export function exportLogs(
  outputPath: string,
  options: LogExportOptions = { format: 'jsonl' },
): { success: boolean; count: number; path: string } {
  try {
    const logs = loadAllLogs();
    // 确保输出目录存在
    mkdirSync(dirname(outputPath), { recursive: true });

    if (options.format === 'jsonl') {
      const content = logs.map(entry => JSON.stringify(entry)).join('\n');
      writeFileSync(outputPath, content, 'utf-8');
    } else {
      const content = convertToMarkdown(logs, options.includeMeta);
      writeFileSync(outputPath, content, 'utf-8');
    }

    log('导出日志: %d 条 -> %s (format=%s)', logs.length, outputPath, options.format);
    return { success: true, count: logs.length, path: outputPath };
  } catch (error) {
    log('导出日志失败: %O', error);
    throw error;
  }
}

// ==================== 导入 ====================

/** 轻量校验：必需字段存在 */
function isValidEntry(entry: unknown): entry is LogEntry {
  if (!entry || typeof entry !== 'object') return false;
  const e = entry as Record<string, unknown>;
  return typeof e.id === 'string' && typeof e.timestamp === 'string';
}

/**
 * 从 JSONL 文件导入日志（幂等：按 id 跳过已存在）
 */
export function importLogs(
  inputPath: string,
  options: LogImportOptions = { merge: true, validate: true },
): { success: boolean; imported: number; errors: number } {
  let imported = 0;
  let errors = 0;

  try {
    const db = getDb();
    const content = readFileSync(inputPath, 'utf-8');
    // 兼容纯换行分隔与旧 '\n---\n' 分隔
    const chunks = content.split(/\n---\n?|\n/).filter(l => l.trim() && l.trim() !== '---');

    // 非 merge 模式先清空
    if (!options.merge) {
      dbClearAll(db);
    }

    const entries: LogEntry[] = [];
    for (const chunk of chunks) {
      const line = chunk.trim();
      if (!line) continue;
      try {
        const entry = JSON.parse(line);
        if (options.validate && !isValidEntry(entry)) { errors++; continue; }
        entries.push(entry);
      } catch {
        errors++;
      }
    }

    const r = insertLogsBatch(db, entries as unknown as Parameters<typeof insertLogsBatch>[1]);
    imported = r.imported;
    errors += r.errors;
    // r.skipped = id 已存在（merge 模式下正常）

    log('导入日志: imported=%d errors=%d from=%s', imported, errors, inputPath);
    return { success: true, imported, errors };
  } catch (error) {
    log('导入日志失败: %O', error);
    throw error;
  }
}

// ==================== 清空 / 清理 ====================

/**
 * 清空所有日志（DELETE + VACUUM）
 */
export function clearAllLogs(): { success: boolean; deleted: number } {
  try {
    const n = dbClearAll(getDb());
    log('清空日志: deleted=%d', n);
    return { success: true, deleted: n };
  } catch (error) {
    log('清空日志失败: %O', error);
    throw error;
  }
}

/**
 * 清理过期日志（DELETE 旧行 + VACUUM）。决策④：保留期默认 30 天，env 可调。
 */
export function cleanupOldLogs(): { deleted: number } {
  try {
    const retentionDays = cfg().logRetentionDays;
    const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const cutoffISO = new Date(cutoffMs).toISOString();
    const n = deleteOldLogs(getDb(), cutoffISO);
    if (n > 0) vacuum(getDb());
    log('清理旧日志: deleted=%d (retention=%d天)', n, retentionDays);
    return { deleted: n };
  } catch (error) {
    log('清理旧日志失败: %O', error);
    return { deleted: 0 };
  }
}

// ==================== Markdown 导出 ====================

/**
 * 转换为 Markdown 格式
 */
export function convertToMarkdown(logs: LogEntry[], includeMeta?: boolean): string {
  const lines: string[] = [];

  lines.push('# Lucent 日志报告\n');
  lines.push(`生成时间: ${new Date().toISOString()}\n`);
  lines.push(`总条目数: ${logs.length}\n\n`);
  lines.push('---\n\n');

  for (const log of logs) {
    lines.push(`## ${log.id}\n`);
    lines.push(`**时间**: ${log.timestamp}\n`);
    lines.push(`**Agent 类型**: ${log.agentType}\n`);
    lines.push(`**模型**: ${log.metadata.model}\n`);
    lines.push(`**耗时**: ${log.duration}ms\n`);

    if (log.tokenUsage) {
      lines.push(`**Token 使用**:\n`);
      lines.push(`  - Input: ${log.tokenUsage.input_tokens}\n`);
      lines.push(`  - Output: ${log.tokenUsage.output_tokens}\n`);
      if (log.tokenUsage.cache_read_tokens) {
        lines.push(`  - Cache Read: ${log.tokenUsage.cache_read_tokens}\n`);
      }
      if (log.tokenUsage.cache_creation_tokens) {
        lines.push(`  - Cache Write: ${log.tokenUsage.cache_creation_tokens}\n`);
      }
    }

    if (includeMeta && log.metadata) {
      lines.push(`**元数据**:\n`);
      lines.push(`  - Provider: ${log.metadata.provider}\n`);
      lines.push(`  - Stream: ${log.metadata.stream}\n`);
    }

    if (log.error) {
      lines.push(`**错误**: ${log.error}\n`);
    }

    lines.push('\n---\n\n');
  }

  return lines.join('');
}

/**
 * 获取日志目录路径（导出产物落点）
 */
export function getLogDir(): string {
  return getEffectiveLogDir();
}
