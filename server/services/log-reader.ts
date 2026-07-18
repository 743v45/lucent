/**
 * 日志读取服务（SQLite 后端）
 *
 * readLogs / getLogById 全走 db.ts 的索引查询，再批量拉 bodies 重建 LogEntry。
 * 不再全量解析文件、不再 fileCache 常驻——查询 O(命中+limit)，内存按页。
 * normalizeLogEntry / buildContextFromRequest 保留原样（前端契约 + context 口径不变）。
 */

import {
  DEFAULT_LOG_QUERY_LIMIT,
} from '../constants.js';
import { extractContext } from '../context-extractors.js';
import { extractCachedContent, getContextSizeForModel } from '../kvcache.js';
import { extractFromSSELines } from '../sse-extractor.js';
import type { LogEntry, LogsQuery, LogsResult } from '../types.js';
import type { ResolvedConfig } from '../config.js';
import { listLogs, searchLogs, fetchBodies, getLogById as getLogByIdRaw, type LogRow } from './db.js';
import { getDb } from './db-instance.js';
import createDebug from 'debug';
const dbg = createDebug('lucent:log-reader');

// ==================== 初始化 ====================

/**
 * DB 句柄由 log-writer.init → initDb 初始化，reader 经 getDb() 取用。
 * 保留 init(cfg) 契约以兼容现有调用方（server/index.ts、测试）。
 */
export function init(_resolvedCfg: ResolvedConfig): void {
  /* no-op: 句柄在 log-writer.init 时已就绪 */
}

/**
 * 失效提取结果缓存。
 *
 * 日志一旦写入即不可变（db.ts insertLog 用 INSERT OR IGNORE，全程无 UPDATE，
 * 只有 INSERT / DELETE），所以正常读取永远不需要失效——按 id 记忆的结果不会过期。
 * 仅在「清空全部日志」（DELETE /api/logs）时调用，释放内存。SQLite 索引本身
 * 无进程级缓存，这里的失效只针对下面的提取结果记忆缓存。
 */
export function invalidateCache(): void {
  contextCache.clear();
}

// ==================== 提取结果记忆（读路径） ====================

/**
 * 按 log.id 记忆 buildContextFromRequest 的结果。
 *
 * 背景：迁移到 SQLite（step2）时退役了旧的常驻 fileCache，读路径变成每次刷新 /
 * 翻页 / 点详情都对页内每条日志重跑 context + KV-Cache 提取，并因此反复打印
 * lucent:context / lucent:kvcache 调试日志（见 TAE-73）。日志不可变，提取结果
 * 永远不会过期，所以按 id 记忆一次即可：命中即复用、不重提、不重打日志。
 *
 * FIFO 上限保护内存：超限丢最旧条目。
 */
const CONTEXT_CACHE_MAX = 2000;
const contextCache = new Map<string, { context?: LogEntry['context']; kvCache?: LogEntry['kvCache'] }>();

/**
 * 读路径专用：按 log.id 记忆 buildContextFromRequest 的结果。
 * 命中 → 直接贴回 context / kvCache（不重提，不重打调试日志）；
 * 未命中 → 跑一次 buildContextFromRequest 并存入缓存。
 */
export function applyContextCache(log: LogEntry): void {
  const id = log.id;
  if (id) {
    const cached = contextCache.get(id);
    if (cached) {
      // 按引用贴回缓存里的同一份对象——命中即复用、不重提、不重打调试日志。
      // 约定：下游（路由/前端）只读不改 context / kvCache；就地 mutate 会污染缓存，
      // 需要变更请整个替换。
      log.context = cached.context;
      log.kvCache = cached.kvCache;
      return;
    }
  }

  buildContextFromRequest(log);

  if (id) {
    if (contextCache.size >= CONTEXT_CACHE_MAX) {
      const oldest = contextCache.keys().next().value;
      if (oldest !== undefined) contextCache.delete(oldest);
    }
    contextCache.set(id, { context: log.context, kvCache: log.kvCache });
  }
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
    ttftFirstTokenMs: raw.ttftFirstTokenMs,
    ttftThinkingMs: raw.ttftThinkingMs,
    ttftAnswerMs: raw.ttftAnswerMs,
    tokensPerSecond: raw.tokensPerSecond,
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
    expiresAt: raw.expiresAt,
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
  if (messages.length === 0 && !systemPrompt?.length && !tools?.length) return;

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
      // 段总长（含 \n 分隔，与旧 join 口径同形；单段时与旧值一致）。该字段当前无读取方，保留契约形状。
      systemPromptLength: systemPrompt?.join('\n').length ?? 0,
      toolsCount: tools?.length ?? 0,
      duration: 0,
    },
    ...(systemPrompt?.length ? { systemPrompt } : {}),
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

// ==================== 重建 ====================

/**
 * 从 logs 行 + bodies 重建前端期望的 LogEntry：
 * 先拼回扁平 RawLogEntry，再走 normalizeLogEntry 归一化（与原 JSONL 路径一致）。
 */
export function reconstructEntry(row: LogRow, request: string, response: string): LogEntry {
  const req = JSON.parse(request) as { method: string; url: string; headers: Record<string, string>; body: unknown };
  const resp = JSON.parse(response);
  const hasUsage = row.input_tokens != null || row.output_tokens != null;
  const flat: any = {
    id: row.id,
    timestamp: row.timestamp,
    url: req.url,
    method: req.method,
    headers: req.headers,
    body: req.body,
    response: resp,
    duration: row.duration,
    isStream: !!row.is_stream,
    mainAgent: row.agent_type === 'main',
    agentType: row.agent_type ?? undefined,
    apiType: row.endpoint_type ?? undefined,
    clientType: row.client_type ?? undefined,
    isTest: !!row.is_test,
    error: row.error ?? undefined,
    providerName: row.provider_name ?? undefined,
    endpointType: row.endpoint_type ?? undefined,
    threadId: row.thread_id ?? undefined,
    expiresAt: row.expires_at ?? undefined,
    tokenUsage: hasUsage ? {
      input_tokens: row.input_tokens ?? 0,
      output_tokens: row.output_tokens ?? 0,
      ...(row.cache_read_tokens != null ? { cache_read_tokens: row.cache_read_tokens } : {}),
      ...(row.cache_creation_tokens != null ? { cache_creation_tokens: row.cache_creation_tokens } : {}),
    } : undefined,
  };
  return normalizeLogEntry(flat);
}

// ==================== 读取 ====================

/**
 * 读取并过滤日志（索引查询 + 按页拉 bodies 重建）。
 * search 非空走 FTS 检索，否则列表；cursor=keyset 深分页，filter 含 provider/endpoint。
 */
export async function readLogs(query: LogsQuery = {}): Promise<LogsResult> {
  const {
    limit = DEFAULT_LOG_QUERY_LIMIT,
    cursor,
    agentType = 'all',
    providerName,
    endpointType,
    startDate,
    endDate,
    search,
  } = query;

  // clamp limit：防止恶意超大 limit 打爆内存
  const MAX_LOG_QUERY_LIMIT = 500;
  const safeLimit = Math.max(1, Math.min(limit, MAX_LOG_QUERY_LIMIT));

  try {
    const filter = {
      ...(agentType && agentType !== 'all' ? { agentType } : {}),
      ...(providerName && providerName !== 'all' ? { providerName } : {}),
      ...(endpointType && endpointType !== 'all' ? { endpointType } : {}),
      ...(startDate ? { startDate } : {}),
      ...(endDate ? { endDate } : {}),
    };
    // 前端走 keyset（cursor），不传 offset——传 offset 会让 listLogs 落到 OFFSET 旧模式、
    // 首页 nextCursor=null，断掉 keyset 链。OFFSET 仅 bench/旧调用直连 listLogs 时用。
    const pageOpts = { limit: safeLimit, cursor, filter };

    const { logs: rows, total, nextCursor, hasMore } = search && search.trim()
      ? searchLogs(getDb(), search, pageOpts)
      : listLogs(getDb(), pageOpts);

    // 按页批量拉 bodies 重建（O(页大小) body 读，不拖全量）
    const bodies = fetchBodies(getDb(), rows.map(r => r.rowid));
    const logs = rows.map(r => {
      const b = bodies.get(r.rowid);
      if (!b) {
        dbg('body 缺失 rowid=%d id=%s（跳过）', r.rowid, r.id);
        return null;
      }
      const log = reconstructEntry(r, b.request, b.response);
      applyContextCache(log);
      return log;
    }).filter((l): l is LogEntry => l !== null);

    return { logs, total, nextCursor, hasMore };
  } catch (error) {
    dbg('读取日志失败: %O', error);
    return { logs: [], total: 0, nextCursor: null, hasMore: false };
  }
}

/**
 * 获取单个日志详情（主键直查 + 重建）
 */
export async function getLogById(id: string): Promise<LogEntry | null> {
  try {
    const raw = getLogByIdRaw(getDb(), id);
    if (!raw) return null;
    const log = reconstructEntry(raw.row, raw.request, raw.response);
    applyContextCache(log);
    return log;
  } catch (error) {
    dbg('获取日志详情失败: %O', error);
    return null;
  }
}
