/**
 * 日志读取服务
 *
 * 从 JSONL 文件读取、归一化、过滤、分页日志
 * 使用异步 I/O，不阻塞事件循环
 */

import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DEFAULT_LOG_QUERY_LIMIT,
  MAX_LOG_FILES_TO_READ,
  LOG_SPLIT_REGEX,
} from '../constants.js';
import { extractContext } from '../context-extractors.js';
import { extractCachedContent, getContextSizeForModel } from '../kvcache.js';
import { extractFromSSELines } from '../sse-extractor.js';
import type { LogEntry, LogsQuery } from '../types.js';
import type { ResolvedConfig } from '../config.js';
import createDebug from 'debug';
const dbg = createDebug('lucent:log-reader');

// ==================== 初始化 ====================

let resolvedConfig: ResolvedConfig;

export function init(resolvedCfg: ResolvedConfig): void {
  resolvedConfig = resolvedCfg;
}

// ==================== 文件级缓存 ====================

interface FileCache {
  mtimeMs: number;
  size: number;
  entries: LogEntry[];
}

const fileCache = new Map<string, FileCache>();

/**
 * 使缓存失效（日志写入/轮转/清理时调用）
 *
 * 注意：readFileEntries 已改为 mtimeMs + size 联合判定，
 * append 后 size 必然变化，因此正常读取路径无需显式失效。
 * 此函数保留供外部在确知结构变化（如轮转归档）时强制清理。
 */
export function invalidateCache(): void {
  fileCache.clear();
}

/**
 * 读取单个文件的日志条目，使用 mtimeMs + size 缓存
 *
 * 仅用 mtimeMs 在同秒高频 append 下 mtime 不变会返回过期数据，
 * 联合 size 判定：size 变化即判定失效。
 */
async function readFileEntries(filename: string): Promise<LogEntry[]> {
  const filePath = join(resolvedConfig.logDir, filename);

  // 检查缓存
  const stats_ = await stat(filePath);
  const cached = fileCache.get(filename);
  if (cached && cached.mtimeMs === stats_.mtimeMs && cached.size === stats_.size) {
    return cached.entries;
  }

  // 缓存未命中，解析文件
  const content = await readFile(filePath, 'utf-8');
  const entries: LogEntry[] = [];
  const chunks = content.split(LOG_SPLIT_REGEX);
  for (const chunk of chunks) {
    const line = chunk.trim();
    if (!line) continue;
    try {
      // 注意：不再调用 unescapeLogContent，因为 JSON.parse 本身能正确处理 \n 转义序列。
      // 写入时 escapeLogContent 把真实的 "\n---\n" 变成字符串形式的 "\\n---\\n"，
      // 这是为了防止内容里的分隔符被误认为条目边界。读取时 JSON.parse 会自动把
      // "\\n" 解析成字符串里的换行符，不需要手动还原。
      const raw = JSON.parse(line);
      entries.push(normalizeLogEntry(raw));
    } catch {
      // 忽略解析失败的行
    }
  }

  // 更新缓存
  fileCache.set(filename, { mtimeMs: stats_.mtimeMs, size: stats_.size, entries });
  return entries;
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
    apiType: raw.apiType,
    clientType: raw.clientType || 'unknown',
    duration: raw.duration || 0,
    metadata: {
      model: body.model || 'unknown',
      provider,
      stream: raw.isStream ?? !!body.stream,
      error: raw.error,
    },
    tokenUsage: raw.tokenUsage,
    kvCache: raw.kvCache,
    context: raw.context,
    error: raw.error,
    isTest: raw.isTest,
    providerName: raw.providerName,
    endpointType: raw.endpointType,
    threadId: raw.threadId,
  };
}

// ==================== Context 构建 ====================

/**
 * 从 request.body 构建 context 数据
 * 使用 context-extractors 统一提取多种 API 格式
 */
export function buildContextFromRequest(log: LogEntry): void {
  const body = log.request?.body as any;
  const url = log.request?.url || '';

  if (!body || typeof body !== 'object') return;

  // 提取 KV-Cache 信息（命中率、缓存内容、状态判定）。
  // 总是用新口径重新提取并覆盖：修正旧日志存储的 string[] 旧格式 + 旧命中率口径，
  // 同时为无缓存命中的请求补上 status/cacheMode（用于前端空状态三态）。
  // 优先从 SSE lines 提取 usage（source of truth，与前端 resolveTokenUsage 一致），
  // 兼容历史 camelCase/snakeCase tokenUsage（归一化），最后回退 response.body.usage。
  const respBody = log.response?.body as any;
  let normalizedUsage: any;

  // 1. SSE 流式：从原始 lines 提取（最可靠，覆盖 tokenUsage 缺失的历史日志）
  if (respBody?.type === 'sse_raw' && Array.isArray(respBody.lines)) {
    const extracted = extractFromSSELines(respBody.lines);
    if (extracted.usage.input > 0 || extracted.usage.output > 0) {
      normalizedUsage = {
        input_tokens: extracted.usage.input,
        output_tokens: extracted.usage.output,
        cache_creation_input_tokens: extracted.usage.cache_create || undefined,
        cache_read_input_tokens: extracted.usage.cache_read || undefined,
      };
    }
  }

  // 2. tokenUsage（兼容 camelCase 历史 / snakeCase 新）
  if (!normalizedUsage) {
    const tu = log.tokenUsage as any;
    if (tu && (tu.input_tokens ?? tu.inputTokens) !== undefined) {
      normalizedUsage = {
        input_tokens: tu.input_tokens ?? tu.inputTokens,
        output_tokens: tu.output_tokens ?? tu.outputTokens,
        cache_creation_input_tokens: tu.cache_creation_tokens ?? tu.cacheCreationTokens,
        cache_read_input_tokens: tu.cache_read_tokens ?? tu.cacheReadTokens,
      };
    }
  }

  // 3. fallback response.body.usage（非流式）
  if (!normalizedUsage) {
    normalizedUsage = respBody?.usage;
  }
  // 传入 endpointType/provider 以区分显式缓存（Anthropic）与自动缓存（OpenAI）
  // 兼容旧日志：endpointType 字段缺失时 fallback 到 apiType
  const endpointType = log.endpointType || (log as any).apiType;
  // metadata.provider 用 'claude' 表示 Anthropic，规范成契约要求的 'anthropic'
  const metaProvider = log.metadata?.provider;
  const provider =
    metaProvider === 'claude' ? 'anthropic'
      : metaProvider === 'openai' ? 'openai'
        : metaProvider;
  const cached = extractCachedContent(body, normalizedUsage, { endpointType, provider });
  log.kvCache = {
    hitRate: cached.hitRate,
    cacheReadTokens: cached.cacheReadTokens,
    cacheCreateTokens: cached.cacheCreateTokens,
    totalCachedTokens: cached.totalCachedTokens,
    totalInputTokens: cached.totalInputTokens,
    uncachedInputTokens: cached.uncachedInputTokens,
    cacheMode: cached.cacheMode,
    provider: cached.provider,
    status: cached.status,
    ...(cached.system.length ? { system: cached.system } : {}),
    ...(cached.messages.length ? { messages: cached.messages } : {}),
    ...(cached.tools.length ? { tools: cached.tools } : {}),
  };

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

  // 计算上下文窗口：复用 KV-Cache 的 totalInputTokens（已按 provider 口径含 cache），
  // 与 KV-Cache 面板口径一致，避免漏算 cache 或 OpenAI 重复算 cached_tokens。
  if (cached.totalInputTokens > 0 && log.metadata?.model) {
    const outputTokens = normalizedUsage?.output_tokens ?? 0;
    const contextSize = getContextSizeForModel(log.metadata.model);
    const totalTokens = cached.totalInputTokens + outputTokens;
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
export async function readLogs(query: LogsQuery = {}): Promise<{ logs: LogEntry[]; total: number }> {
  const {
    limit = DEFAULT_LOG_QUERY_LIMIT,
    offset = 0,
    agentType = 'all',
    startDate,
    endDate,
    search,
  } = query;

  // clamp limit/offset：防止恶意超大 limit 打爆内存
  const MAX_LOG_QUERY_LIMIT = 500;
  const safeLimit = Math.max(0, Math.min(limit, MAX_LOG_QUERY_LIMIT));
  const safeOffset = Math.max(0, offset);

  let allLogs: LogEntry[] = [];

  try {
    if (!existsSync(resolvedConfig.logDir)) {
      return { logs: [], total: 0 };
    }

    const allFiles = await readdir(resolvedConfig.logDir);
    const files = allFiles
      .filter(f => f.endsWith('.jsonl') && !f.startsWith('export_'))
      .sort()
      .reverse()
      .slice(0, MAX_LOG_FILES_TO_READ);

    // 使用缓存读取每个文件
    for (const file of files) {
      const entries = await readFileEntries(file);
      allLogs.push(...entries);
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
      // 所有参与搜索的字段都做空值守卫，避免 undefined.toLowerCase() 抛 TypeError 中断查询
      if ((log.request?.url ?? '').toLowerCase().includes(searchLower)) return true;
      if ((log.metadata?.model ?? '').toLowerCase().includes(searchLower)) return true;
      if (log.error?.toLowerCase().includes(searchLower)) return true;
      if ((log.providerName ?? '').toLowerCase().includes(searchLower)) return true;
      return false;
    });
  }

  const total = filteredLogs.length;

  // 从 request.body 构建 context（只对分页后返回的条目）
  const paginatedLogs = filteredLogs.slice(safeOffset, safeOffset + safeLimit);
  paginatedLogs.forEach(log => buildContextFromRequest(log));

  return { logs: paginatedLogs, total };
}

/**
 * 获取单个日志详情
 */
export async function getLogById(id: string): Promise<LogEntry | null> {
  try {
    if (!existsSync(resolvedConfig.logDir)) {
      return null;
    }

    const files = (await readdir(resolvedConfig.logDir)).filter(f => f.endsWith('.jsonl'));

    for (const file of files) {
      const entries = await readFileEntries(file);
      const found = entries.find(e => e.id === id);
      if (found) {
        buildContextFromRequest(found);
        return found;
      }
    }
  } catch (error) {
    dbg('获取日志详情失败: %O', error);
  }

  return null;
}
