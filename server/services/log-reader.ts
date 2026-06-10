/**
 * 日志读取服务
 *
 * 从 JSONL 文件读取、归一化、过滤、分页日志
 * 从 index.ts 提取而来
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_LOG_QUERY_LIMIT,
  MAX_LOG_FILES_TO_READ,
  LOG_SPLIT_REGEX,
} from '../constants.js';
import { extractContext } from '../context-extractors.js';
import { extractCachedContent, getContextSizeForModel } from '../kvcache.js';
import type { LogEntry, LogsQuery } from '../types.js';
import type { ResolvedConfig } from '../config.js';
import createDebug from 'debug';
const dbg = createDebug('lucent:log-reader');

// ==================== 初始化 ====================

let resolvedConfig: ResolvedConfig;

export function init(resolvedCfg: ResolvedConfig): void {
  resolvedConfig = resolvedCfg;
}

// ==================== 归一化 ====================

/**
 * 将拦截器写入的扁平格式归一化为前端期望的嵌套格式
 *
 * 拦截器写入: { url, method, headers, body, response, ... }
 * 前端期望:   { request: { url, method, headers, body }, response, metadata, ... }
 */
export function normalizeLogEntry(raw: any): LogEntry {
  // 已经是嵌套格式（有 request 属性）则跳过
  if (raw.request && typeof raw.request === 'object') {
    return raw as LogEntry;
  }

  const body = raw.body || {};
  const provider = raw.apiType === 'openai-chat' || raw.apiType === 'openai-responses'
    ? 'openai'
    : raw.apiType === 'anthropic-messages' || raw.url?.includes('anthropic')
      ? 'claude'
      : 'unknown';

  return {
    id: raw.id,
    timestamp: raw.timestamp,
    request: {
      method: raw.method || 'GET',
      url: raw.url || '',
      headers: raw.headers || {},
      body,
    },
    response: raw.response ?? null,
    agentType: raw.agentType || (raw.mainAgent ? 'main' : 'sub'),
    subAgentType: raw.subAgentType,
    apiType: raw.apiType,
    clientType: raw.clientType || 'unknown',
    duration: raw.duration || 0,
    metadata: {
      model: body.model || 'unknown',
      provider,
      stream: raw.isStream ?? !!body.stream,
      error: raw.error,
    },
    tokenUsage: raw.tokenUsage ? {
      input_tokens: raw.tokenUsage.inputTokens ?? 0,
      output_tokens: raw.tokenUsage.outputTokens ?? 0,
      cache_creation_tokens: raw.tokenUsage.cacheWriteTokens,
      cache_read_tokens: raw.tokenUsage.cacheReadTokens,
    } : raw.tokenUsage,
    kvCache: raw.kvCache,
    context: raw.context,
    error: raw.error,
    isTest: raw.isTest,
  };
}

// ==================== Context 构建 ====================

/**
 * 从 request.body 构建 context 数据
 * 使用 context-extractors 统一提取多种 API 格式
 */
function buildContextFromRequest(log: LogEntry): void {
  const body = log.request?.body as any;
  const url = log.request?.url || '';

  if (!body || typeof body !== 'object') return;

  // 提取 KV-Cache 信息（命中率、缓存内容）
  // 优先用已归一化的 tokenUsage（兼容 SSE/非 SSE），fallback 到 response.body.usage
  if (!log.kvCache) {
    const tu = log.tokenUsage as any;
    const rawRespUsage = (log.response?.body as any)?.usage;
    const normalizedUsage = (tu?.input_tokens !== undefined) ? {
      input_tokens: tu.input_tokens,
      output_tokens: tu.output_tokens,
      cache_creation_input_tokens: tu.cache_creation_tokens,
      cache_read_input_tokens: tu.cache_read_tokens,
    } : rawRespUsage;
    if (normalizedUsage) {
      const cached = extractCachedContent(body, normalizedUsage);
      if (cached.totalCachedTokens > 0) {
        log.kvCache = {
          hitRate: cached.hitRate,
          cacheReadTokens: cached.cacheReadTokens,
          cacheCreateTokens: cached.cacheCreateTokens,
          totalCachedTokens: cached.totalCachedTokens,
          ...(cached.system.length ? { system: cached.system } : {}),
          ...(cached.messages.length ? { messages: cached.messages } : {}),
          ...(cached.tools.length ? { tools: cached.tools } : {}),
        };
      }
    }
  }

  // 使用统一的 context 提取器（内部会检测 API 类型）
  const extracted = extractContext(body, url);
  if (!extracted) return;

  const { systemPrompt, messages, tools } = extracted;

  // 只有有内容才构建
  if (messages.length === 0 && !systemPrompt && !tools?.length) return;

  // 统计
  const userMsgs = messages.filter((m: any) => m.role === 'user').length;
  const assistantMsgs = messages.filter((m: any) => m.role === 'assistant').length;
  const toolMsgs = messages.filter((m: any) => m.role === 'tool' || m.role === 'function').length;

  // 构建 context messages（加上 timestamp）
  const ctxMsgs = messages.map((m: any) => ({
    role: m.role,
    content: m.content,
    timestamp: log.timestamp,
    ...(m.tool_use_id ? { tool_use_id: m.tool_use_id } : {}),
    ...(m.name ? { name: m.name } : {}),
    ...(m.id ? { id: m.id } : {}),
  }));

  log.context = {
    messages: ctxMsgs,
    summary: {
      totalMessages: ctxMsgs.length,
      userMessages: userMsgs,
      assistantMessages: assistantMsgs,
      toolMessages: toolMsgs,
      systemPromptLength: systemPrompt?.length ?? 0,
      toolsCount: tools?.length ?? 0,
      duration: 0,
    },
    ...(systemPrompt ? { systemPrompt } : {}),
    ...(tools?.length ? { tools } : {}),
  };

  // 计算上下文窗口
  const usage = (log.response?.body as any)?.usage;
  if (usage && log.metadata?.model) {
    const inputTokens = usage.input_tokens ?? usage.cache_read_input_tokens ?? 0;
    const outputTokens = usage.output_tokens ?? 0;
    const contextSize = getContextSizeForModel(log.metadata.model);
    const totalTokens = inputTokens + outputTokens;
    const usedPercentage = Math.min(100, Math.round((totalTokens / contextSize) * 100));

    log.context.contextWindow = {
      totalTokens,
      contextSize,
      usedPercentage,
      remainingPercentage: 100 - usedPercentage,
    };
  }
}

// ==================== 读取 ====================

/**
 * 读取并过滤日志
 */
export function readLogs(query: LogsQuery = {}): { logs: LogEntry[]; total: number } {
  const {
    limit = DEFAULT_LOG_QUERY_LIMIT,
    offset = 0,
    agentType = 'all',
    subAgentType,
    startDate,
    endDate,
    search,
  } = query;

  let allLogs: LogEntry[] = [];

  try {
    if (!existsSync(resolvedConfig.logDir)) {
      return { logs: [], total: 0 };
    }

    const files = readdirSync(resolvedConfig.logDir)
      .filter(f => f.endsWith('.jsonl') && !f.startsWith('export_'))
      .sort()
      .reverse()
      .slice(0, MAX_LOG_FILES_TO_READ);

    for (const file of files) {
      const filePath = join(resolvedConfig.logDir, file);
      const content = readFileSync(filePath, 'utf-8');

      const chunks = content.split(LOG_SPLIT_REGEX);
      for (const chunk of chunks) {
        const line = chunk.trim();
        if (!line) continue;
        try {
          const raw = JSON.parse(line);
          allLogs.push(normalizeLogEntry(raw));
        } catch {
          // 忽略解析失败的行
        }
      }
    }
  } catch (error) {
    dbg('读取日志失败: %O', error);
    return { logs: [], total: 0 };
  }

  // 按时间戳倒序排序
  allLogs.sort((a, b) =>
    new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );

  // 按 ID 去重（同名条目可能在多个文件中出现，保留最新的）
  const seen = new Set<string>();
  allLogs = allLogs.filter(log => {
    if (seen.has(log.id)) return false;
    seen.add(log.id);
    return true;
  });

  // 过滤掉没有响应的日志（还在进行中的请求）
  allLogs = allLogs.filter(log => log.response !== null && log.response !== undefined);

  // 应用过滤器
  let filteredLogs = allLogs;

  if (agentType !== 'all') {
    filteredLogs = filteredLogs.filter(log => log.agentType === agentType);
  }

  if (subAgentType) {
    filteredLogs = filteredLogs.filter(log => log.subAgentType === subAgentType);
  }

  if (startDate) {
    const start = new Date(startDate).getTime();
    filteredLogs = filteredLogs.filter(log => new Date(log.timestamp).getTime() >= start);
  }

  if (endDate) {
    const end = new Date(endDate).getTime();
    filteredLogs = filteredLogs.filter(log => new Date(log.timestamp).getTime() <= end);
  }

  if (search) {
    const searchLower = search.toLowerCase();
    filteredLogs = filteredLogs.filter(log => {
      if (log.request.url.toLowerCase().includes(searchLower)) return true;
      if (log.metadata.model.toLowerCase().includes(searchLower)) return true;
      if (log.error?.toLowerCase().includes(searchLower)) return true;
      if (log.subAgentType?.toLowerCase().includes(searchLower)) return true;
      return false;
    });
  }

  const total = filteredLogs.length;

  // 从 request.body 构建 context
  filteredLogs.forEach(log => buildContextFromRequest(log));

  // 分页
  const paginatedLogs = filteredLogs.slice(offset, offset + limit);

  return { logs: paginatedLogs, total };
}

/**
 * 获取单个日志详情
 */
export function getLogById(id: string): LogEntry | null {
  try {
    if (!existsSync(resolvedConfig.logDir)) {
      return null;
    }

    const files = readdirSync(resolvedConfig.logDir).filter(f => f.endsWith('.jsonl'));

    for (const file of files) {
      const filePath = join(resolvedConfig.logDir, file);
      const content = readFileSync(filePath, 'utf-8');

      const chunks = content.split(LOG_SPLIT_REGEX);
      for (const chunk of chunks) {
        const line = chunk.trim();
        if (!line) continue;
        try {
          const log = JSON.parse(line) as LogEntry;
          if (log.id === id) {
            buildContextFromRequest(log);
            return log;
          }
        } catch {
          // 忽略解析失败的行
        }
      }
    }
  } catch (error) {
    dbg('获取日志详情失败: %O', error);
  }

  return null;
}
