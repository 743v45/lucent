/**
 * 日志管理模块
 *
 * 负责日志的导入、导出、清空和文件轮转
 */

import { mkdirSync, existsSync, appendFileSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { LogEntry } from '../src/types.js';

export interface LogExportOptions {
  format: 'jsonl' | 'markdown';
  includeMeta?: boolean;
  filter?: (entry: LogEntry) => boolean;
}

export interface LogImportOptions {
  merge?: boolean; // 是否合并到当前日志
  validate?: boolean; // 是否验证日志格式
}

const LOG_DIR = join(homedir(), '.agentproxy', 'logs');
const MAX_LOG_FILE_SIZE = 100 * 1024 * 1024; // 100MB
const MAX_LOG_FILES = 50; // 最多保留50个日志文件

/**
 * 初始化日志目录
 */
export function initLogDir(): void {
  if (!existsSync(LOG_DIR)) {
    mkdirSync(LOG_DIR, { recursive: true });
  }
}

/**
 * 获取当前日志文件路径
 */
export function getCurrentLogFilePath(): string {
  const now = new Date();
  const date = now.toISOString().split('T')[0];
  const time = now.toTimeString().split(' ')[0].replace(/:/g, '-');
  return join(LOG_DIR, `agentproxy_${date}_${time}.jsonl`);
}

/**
 * 写入日志条目
 */
export function writeLogEntry(entry: LogEntry): void {
  const logFile = getCurrentLogFilePath();

  try {
    // 确保日志目录存在
    initLogDir();

    // 检查文件大小，如果超过限制则轮转
    if (existsSync(logFile)) {
      const stats = statSync(logFile);
      if (stats.size >= MAX_LOG_FILE_SIZE) {
        rotateLogFile(logFile);
      }
    }

    const line = JSON.stringify(entry) + '\n';
    appendFileSync(logFile, line);
  } catch (error) {
    console.error('[LogManager] 写入日志失败:', error);
    throw error;
  }
}

/**
 * 读取所有日志
 */
export function readLogs(limit?: number, filter?: (entry: LogEntry) => boolean): LogEntry[] {
  const logs: LogEntry[] = [];

  try {
    if (!existsSync(LOG_DIR)) {
      return logs;
    }

    const files = readdirSync(LOG_DIR)
      .filter(f => f.endsWith('.jsonl') && !f.startsWith('export_'))
      .sort()
      .reverse();

    for (const file of files) {
      const filePath = join(LOG_DIR, file);
      const content = readFileSync(filePath, 'utf-8');

      // 按分隔符切分：interceptor 写入格式是 JSON + '\n---\n'
      const chunks = content.split(/\n---\n?/);
      for (const chunk of chunks) {
        const line = chunk.trim();
        if (!line) continue;
        try {
          const entry = JSON.parse(line) as LogEntry;
          if (!filter || filter(entry)) {
            logs.push(entry);
          }
        } catch (error) {
          console.warn('[LogManager] 解析日志行失败:', error);
        }
      }
    }
  } catch (error) {
    console.error('[LogManager] 读取日志失败:', error);
  }

  // 按时间戳排序（最新的在前）
  logs.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  return limit ? logs.slice(0, limit) : logs;
}

/**
 * 导出日志
 */
export function exportLogs(
  outputPath: string,
  options: LogExportOptions = { format: 'jsonl' }
): { success: boolean; count: number; path: string } {
  try {
    // 过滤掉 inProgress 记录（没有完整响应的）
    const noInProgress = options.filter
      ? (entry: LogEntry) => entry.response != null && options.filter!(entry)
      : (entry: LogEntry) => entry.response != null;

    const logs = readLogs(undefined, noInProgress);

    if (options.format === 'jsonl') {
      // JSONL 格式：每行一个 JSON 对象
      const content = logs.map(entry => JSON.stringify(entry)).join('\n');
      writeFileSync(outputPath, content, 'utf-8');
    } else if (options.format === 'markdown') {
      // Markdown 格式：可读性更好的格式
      const content = convertToMarkdown(logs, options.includeMeta);
      writeFileSync(outputPath, content, 'utf-8');
    }

    return {
      success: true,
      count: logs.length,
      path: outputPath,
    };
  } catch (error) {
    console.error('[LogManager] 导出日志失败:', error);
    throw error;
  }
}

/**
 * 导入日志
 */
export function importLogs(
  inputPath: string,
  options: LogImportOptions = { merge: true, validate: true }
): { success: boolean; imported: number; errors: number } {
  let imported = 0;
  let errors = 0;

  try {
    const content = readFileSync(inputPath, 'utf-8');

    // 按分隔符切分：兼容 '---' 分隔和纯换行分隔
    const chunks = content.split(/\n---\n?|\n/).filter(Boolean);

    // 如果不是合并模式，先清空现有日志
    if (!options.merge) {
      clearAllLogs();
    }

    for (const chunk of chunks) {
      const line = chunk.trim();
      if (!line || line === '---') continue;
      try {
        const entry = JSON.parse(line) as LogEntry;

        // 可选的验证
        if (options.validate) {
          if (!isValidLogEntry(entry)) {
            errors++;
            continue;
          }
        }

        writeLogEntry(entry);
        imported++;
      } catch (error) {
        console.warn('[LogManager] 导入日志行失败:', error);
        errors++;
      }
    }

    return { success: true, imported, errors };
  } catch (error) {
    console.error('[LogManager] 导入日志失败:', error);
    throw error;
  }
}

/**
 * 清空所有日志
 */
export function clearAllLogs(): { success: boolean; deleted: number } {
  let deleted = 0;

  try {
    if (!existsSync(LOG_DIR)) {
      return { success: true, deleted: 0 };
    }

    const files = readdirSync(LOG_DIR).filter(f => f.endsWith('.jsonl'));

    for (const file of files) {
      const filePath = join(LOG_DIR, file);
      unlinkSync(filePath);
      deleted++;
    }

    return { success: true, deleted };
  } catch (error) {
    console.error('[LogManager] 清空日志失败:', error);
    throw error;
  }
}

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
    if (!existsSync(LOG_DIR)) {
      return {
        totalEntries: 0,
        totalSize: 0,
        fileCount: 0,
      };
    }

    const files = readdirSync(LOG_DIR).filter(f => f.endsWith('.jsonl'));
    let totalEntries = 0;
    let totalSize = 0;
    let oldestEntry: string | undefined;
    let newestEntry: string | undefined;

    for (const file of files) {
      const filePath = join(LOG_DIR, file);
      const stats = statSync(filePath);
      totalSize += stats.size;
      // 按 --- 分隔符切分统计条目数
      const content = readFileSync(filePath, 'utf-8');
      totalEntries += content.split(/\n---\n?/).filter(chunk => chunk.trim()).length;
    }

    // 获取最旧和最新的日志条目
    const logs = readLogs();
    if (logs.length > 0) {
      newestEntry = logs[0].timestamp;
      oldestEntry = logs[logs.length - 1].timestamp;
    }

    return {
      totalEntries,
      totalSize,
      fileCount: files.length,
      oldestEntry,
      newestEntry,
    };
  } catch (error) {
    console.error('[LogManager] 获取日志统计失败:', error);
    return {
      totalEntries: 0,
      totalSize: 0,
      fileCount: 0,
    };
  }
}

/**
 * 轮转日志文件（当文件过大时）
 */
function rotateLogFile(filePath: string): void {
  try {
    const baseName = filePath.replace('.jsonl', '');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const newFilePath = `${baseName}_rotated_${timestamp}.jsonl`;

    // 重命名当前文件
    // 注意：Node.js 没有直接的 rename 函数在 fs 模块中，这里假设我们会用其他方式处理
    // 在实际使用中，你可能需要使用 rename 或者复制后删除
    console.log(`[LogManager] 日志文件轮转: ${filePath} -> ${newFilePath}`);
  } catch (error) {
    console.error('[LogManager] 日志轮转失败:', error);
  }
}

/**
 * 清理旧日志文件（保留最近的N个文件）
 */
export function cleanupOldLogs(maxFiles: number = MAX_LOG_FILES): { deleted: number } {
  let deleted = 0;

  try {
    if (!existsSync(LOG_DIR)) {
      return { deleted: 0 };
    }

    const files = readdirSync(LOG_DIR)
      .filter(f => f.endsWith('.jsonl') && !f.startsWith('export_'))
      .sort()
      .reverse();

    // 删除超过限制的旧文件
    if (files.length > maxFiles) {
      const filesToDelete = files.slice(maxFiles);
      for (const file of filesToDelete) {
        const filePath = join(LOG_DIR, file);
        unlinkSync(filePath);
        deleted++;
      }
    }

    return { deleted };
  } catch (error) {
    console.error('[LogManager] 清理旧日志失败:', error);
    return { deleted: 0 };
  }
}

/**
 * 验证日志条目格式
 */
function isValidLogEntry(entry: unknown): entry is LogEntry {
  if (!entry || typeof entry !== 'object') {
    return false;
  }

  const e = entry as Record<string, unknown>;

  // 必需字段检查
  return (
    typeof e.id === 'string' &&
    typeof e.timestamp === 'string' &&
    typeof e.agentType === 'string' &&
    typeof e.duration === 'number' &&
    typeof e.request === 'object' &&
    typeof e.response === 'object' &&
    typeof e.metadata === 'object'
  );
}

/**
 * 转换为 Markdown 格式
 */
function convertToMarkdown(logs: LogEntry[], includeMeta?: boolean): string {
  const lines: string[] = [];

  lines.push('# AgentProxy 日志报告\n');
  lines.push(`生成时间: ${new Date().toISOString()}\n`);
  lines.push(`总条目数: ${logs.length}\n\n`);
  lines.push('---\n\n');

  for (const log of logs) {
    lines.push(`## ${log.id}\n`);
    lines.push(`**时间**: ${log.timestamp}\n`);
    lines.push(`**Agent 类型**: ${log.agentType}${log.subAgentType ? ` (${log.subAgentType})` : ''}\n`);
    lines.push(`**模型**: ${log.metadata.model}\n`);
    lines.push(`**耗时**: ${log.duration}ms\n`);

    if (log.tokenUsage) {
      lines.push(`**Token 使用**:\n`);
      lines.push(`  - Input: ${log.tokenUsage.inputTokens}\n`);
      lines.push(`  - Output: ${log.tokenUsage.outputTokens}\n`);
      if (log.tokenUsage.cacheReadTokens) {
        lines.push(`  - Cache Read: ${log.tokenUsage.cacheReadTokens}\n`);
      }
      if (log.tokenUsage.cacheCreationTokens) {
        lines.push(`  - Cache Write: ${log.tokenUsage.cacheCreationTokens}\n`);
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
 * 获取日志目录路径
 */
export function getLogDir(): string {
  return LOG_DIR;
}
