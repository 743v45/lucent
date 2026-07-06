/**
 * 测试工具模块
 *
 * 提供加载mock数据和测试辅助函数
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import type { LogEntry, FilterOptions } from '../src/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * 加载mock日志数据
 */
export function loadMockData(filename: string = 'mock-log-data.jsonl'): LogEntry[] {
  const filePath = join(__dirname, filename);

  try {
    const content = readFileSync(filePath, 'utf-8');
    return parseMockLogData(content);
  } catch (error) {
    console.error(`[TestUtils] 加载mock数据失败: ${error}`);
    return [];
  }
}

/**
 * 解析mock日志数据（JSONL格式，用---分隔）
 *
 * 真实日志格式：每个Agent有两条记录（inProgress + complete），用---分隔
 * 我们只需要完整的记录（有response的）
 */
export function parseMockLogData(content: string): LogEntry[] {
  const entries: LogEntry[] = [];

  // 按分隔符切分（---前后可能有换行）
  const chunks = content.split(/\n---\n/);

  for (const chunk of chunks) {
    const lines = chunk.trim().split('\n').filter(Boolean);
    if (lines.length === 0) continue;

    // 解析每一行，选择有完整响应的（非inProgress）
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as LogEntry;
        // 只添加有完整响应的记录（response 不为 null）
        if (entry.response && entry.response.status !== null) {
          entries.push(entry);
        }
      } catch (error) {
        console.warn('[TestUtils] 解析日志行失败:', error);
      }
    }
  }

  return entries;
}

/**
 * 过滤日志数据
 */
export function filterLogs(logs: LogEntry[], options: FilterOptions): LogEntry[] {
  let filtered = [...logs];

  // 按Agent类型过滤
  if (options.agentType && options.agentType !== 'all') {
    filtered = filtered.filter(log => log.agentType === options.agentType);
  }

  // 按Provider过滤
  if (options.provider && options.provider !== 'all') {
    filtered = filtered.filter(log => log.metadata.provider === options.provider);
  }

  // 按日期范围过滤
  if (options.dateRange) {
    const [start, end] = options.dateRange;
    filtered = filtered.filter(log => {
      const timestamp = new Date(log.timestamp);
      return timestamp >= start && timestamp <= end;
    });
  }

  // 按搜索查询过滤
  if (options.searchQuery) {
    const query = options.searchQuery.toLowerCase();
    filtered = filtered.filter(log => {
      // 搜索ID
      if (log.id.toLowerCase().includes(query)) return true;

      // 搜索请求URL
      if (log.request.url.toLowerCase().includes(query)) return true;

      // 搜索响应body（如果是文本）
      if (typeof log.response?.body === 'object') {
        const bodyStr = JSON.stringify(log.response.body).toLowerCase();
        if (bodyStr.includes(query)) return true;
      }

      return false;
    });
  }

  return filtered;
}

/**
 * 获取唯一的Agent ID列表
 */
export function getUniqueAgentIds(logs: LogEntry[]): string[] {
  const ids = new Set<string>();
  for (const log of logs) {
    ids.add(log.id);
  }
  return Array.from(ids).sort();
}

/**
 * 按Agent ID分组日志
 */
export function groupLogsByAgent(logs: LogEntry[]): Map<string, LogEntry[]> {
  const groups = new Map<string, LogEntry[]>();

  for (const log of logs) {
    const existing = groups.get(log.id) || [];
    existing.push(log);
    groups.set(log.id, existing);
  }

  return groups;
}

/**
 * 获取Agent类型统计
 */
export function getAgentTypeStats(logs: LogEntry[]): {
  main: number;
  sub: number;
} {
  const stats = {
    main: 0,
    sub: 0,
  };

  for (const log of logs) {
    if (log.agentType === 'main') {
      stats.main++;
    } else if (log.agentType === 'sub') {
      stats.sub++;
    }
  }

  return stats;
}

/**
 * 获取错误日志
 */
export function getErrorLogs(logs: LogEntry[]): LogEntry[] {
  return logs.filter(log => {
    // 排除 inProgress 的记录（response 为 null）
    if (!log.response || log.response.status === null) {
      return false;
    }
    // 只包含有错误字段或状态码非200的记录
    return !!(log.error || log.response.status !== 200);
  });
}

/**
 * 获取Token使用统计
 */
export function getTokenUsageStats(logs: LogEntry[]): {
  totalInput: number;
  totalOutput: number;
  totalCacheRead: number;
  totalCacheCreate: number;
  averageInput: number;
  averageOutput: number;
} {
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheCreate = 0;
  let count = 0;

  for (const log of logs) {
    if (log.tokenUsage) {
      totalInput += log.tokenUsage.input_tokens || 0;
      totalOutput += log.tokenUsage.output_tokens || 0;
      totalCacheRead += log.tokenUsage.cache_read_tokens || 0;
      totalCacheCreate += log.tokenUsage.cache_creation_tokens || 0;
      count++;
    }
  }

  return {
    totalInput,
    totalOutput,
    totalCacheRead,
    totalCacheCreate,
    averageInput: count > 0 ? Math.round(totalInput / count) : 0,
    averageOutput: count > 0 ? Math.round(totalOutput / count) : 0,
  };
}

/**
 * 获取KV-Cache统计
 */
export function getKVCacheStats(logs: LogEntry[]): {
  totalCached: number;
  averageHitRate: number;
  withCache: number;
  withoutCache: number;
} {
  let totalCached = 0;
  let totalHitRate = 0;
  let withCache = 0;

  for (const log of logs) {
    if (log.kvCache) {
      withCache++;
      totalCached += log.kvCache.totalCachedTokens || 0;
      totalHitRate += log.kvCache.hitRate || 0;
    }
  }

  return {
    totalCached,
    averageHitRate: withCache > 0 ? Math.round((totalHitRate / withCache) * 100) / 100 : 0,
    withCache,
    withoutCache: logs.length - withCache,
  };
}

/**
 * 格式化日志为可读文本（用于调试）
 */
export function formatLogForDebug(log: LogEntry): string {
  const lines: string[] = [];

  lines.push(`📝 Log ID: ${log.id}`);
  lines.push(`🕐 Timestamp: ${log.timestamp}`);
  lines.push(`🤖 Agent: ${log.agentType}`);
  lines.push(`⏱️ Duration: ${log.duration}ms`);
  lines.push(`📦 Model: ${log.metadata.model}`);
  lines.push(`🔌 Provider: ${log.metadata.provider}`);
  lines.push(`🌊 Stream: ${log.metadata.stream}`);

  if (log.tokenUsage) {
    lines.push(`📊 Token Usage:`);
    lines.push(`   - Input: ${log.tokenUsage.input_tokens}`);
    lines.push(`   - Output: ${log.tokenUsage.output_tokens}`);
    if (log.tokenUsage.cache_read_tokens) {
      lines.push(`   - Cache Read: ${log.tokenUsage.cache_read_tokens}`);
    }
    if (log.tokenUsage.cache_creation_tokens) {
      lines.push(`   - Cache Create: ${log.tokenUsage.cache_creation_tokens}`);
    }
  }

  if (log.kvCache) {
    lines.push(`💾 KV-Cache:`);
    lines.push(`   - Hit Rate: ${(log.kvCache.hitRate || 0) * 100}%`);
    lines.push(`   - Total Cached: ${log.kvCache.totalCachedTokens || 0}`);
  }

  if (log.error) {
    lines.push(`❌ Error: ${log.error}`);
  }

  lines.push(`🔗 Request: ${log.request.method} ${log.request.url}`);

  if (log.response && log.response.status) {
    lines.push(`📤 Response: ${log.response.status} ${log.response.statusText}`);
  } else {
    lines.push(`📤 Response: (pending)`);
  }

  return lines.join('\n');
}

/**
 * 打印日志摘要（用于测试输出）
 */
export function printLogSummary(logs: LogEntry[]): void {
  console.log('=== Mock日志数据摘要 ===\n');

  const agentStats = getAgentTypeStats(logs);
  const tokenStats = getTokenUsageStats(logs);
  const cacheStats = getKVCacheStats(logs);
  const errorLogs = getErrorLogs(logs);

  console.log(`📊 总记录数: ${logs.length}`);
  console.log(`🤖 主Agent: ${agentStats.main}`);
  console.log(`🔧 子Agent: ${agentStats.sub}`);

  console.log(`\n📊 Token使用:`);
  console.log(`   - 总输入: ${tokenStats.totalInput}`);
  console.log(`   - 总输出: ${tokenStats.totalOutput}`);
  console.log(`   - 平均输入: ${tokenStats.averageInput}`);
  console.log(`   - 平均输出: ${tokenStats.averageOutput}`);

  console.log(`\n💾 KV-Cache:`);
  console.log(`   - 有缓存: ${cacheStats.withCache}`);
  console.log(`   - 无缓存: ${cacheStats.withoutCache}`);
  console.log(`   - 平均命中率: ${(cacheStats.averageHitRate * 100).toFixed(1)}%`);

  if (errorLogs.length > 0) {
    console.log(`\n❌ 错误记录: ${errorLogs.length}`);
    for (const log of errorLogs) {
      console.log(`   - ${log.id}: ${log.error || log.response.statusText}`);
    }
  }

  console.log('\n========================\n');
}

/**
 * 验证日志条目的完整性
 */
export function validateLogEntry(entry: unknown): entry is LogEntry {
  if (!entry || typeof entry !== 'object') {
    return false;
  }

  const e = entry as Record<string, unknown>;

  // 必需字段检查
  return (
    typeof e.id === 'string' &&
    typeof e.timestamp === 'string' &&
    typeof e.request === 'object' &&
    typeof e.response === 'object' &&
    typeof e.agentType === 'string' &&
    typeof e.duration === 'number' &&
    typeof e.metadata === 'object'
  );
}

/**
 * 创建测试用的单个日志条目
 */
export function createMockLogEntry(overrides: Partial<LogEntry> = {}): LogEntry {
  const timestamp = new Date().toISOString();
  const id = `${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;

  return {
    id,
    timestamp,
    request: {
      method: 'POST',
      url: 'https://api.anthropic.com/v1/messages',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer sk-test',
      },
      body: {
        model: 'claude-3-5-sonnet-20241022',
        messages: [{ role: 'user', content: 'Test message' }],
        max_tokens: 1000,
      },
    },
    response: {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/json' },
      body: {
        id: `msg_${id}`,
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Test response' }],
        stop_reason: 'end_turn',
      },
    },
    agentType: 'main',
    duration: 1000,
    metadata: {
      model: 'claude-3-5-sonnet-20241022',
      provider: 'claude',
      stream: false,
    },
    ...overrides,
  };
}
