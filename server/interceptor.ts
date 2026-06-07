/**
 * AgentProxy Fetch 拦截器模块
 *
 * 功能：
 * - 拦截所有 API 请求
 * - 记录请求/响应到 JSONL 日志
 * - 支持 Delta 存储（增量存储）
 * - 识别主/辅 Agent 类型
 * - 支持流式响应捕获
 *
 * SSE 提取 → sse-extractor.ts
 * Delta 存储 → delta-storage.ts
 * Header 脱敏 → utils.ts
 */

import { resolveEffectiveConfig } from './config.js';
import { detectApiType } from './context-extractors.js';
import { sanitizeHeaders } from './utils.js';
import { extractInBackground } from './sse-extractor.js';
import { processDelta, commitDeltaState } from './delta-storage.js';
import * as LogWriter from './services/log-writer.js';
import {
  API_PATH_REGEX,
  INTERNAL_HEADERS,
  PROXY_TRACE_HEADER,
  MAX_BODY_PARSE_FAILURE_LENGTH,
  MAX_RESPONSE_BODY_LENGTH,
} from './constants.js';
import { extractTokenUsage } from './agent-identifier.js';
import type { ApiProviderType, RawLogEntry } from './types.js';
import createDebug from 'debug';
const dbg = createDebug('agentproxy:interceptor');
const dbgSse = createDebug('agentproxy:interceptor:sse');

// ==================== 状态 ====================

let interceptorInstalled = false;

/**
 * 后台 SSE 提取任务集合
 * 用于优雅退出时等待所有任务完成
 */
const pendingSSETasks = new Set<Promise<void>>();

/**
 * 等待所有后台 SSE 任务完成
 * 优雅退出时调用，确保数据不丢失
 */
export async function drainPendingSSETasks(): Promise<void> {
  if (pendingSSETasks.size === 0) return;
  dbg('等待后台 SSE 任务完成: count=%d', pendingSSETasks.size);
  await Promise.all([...pendingSSETasks]);
  dbg('所有后台 SSE 任务已完成');
}

// ==================== 工具函数 ====================

/**
 * 判断是否为主 Agent 请求
 */
function isMainAgentRequest(body: any): boolean {
  if (!body || typeof body !== 'object') return false;
  const messages = body.messages;
  if (!Array.isArray(messages)) return false;
  if (messages.length >= 2) return true;
  return messages.some((m: any) => m.role === 'assistant');
}

/**
 * 解析 Agent 类型
 */
function parseAgentType(body: any, isMain: boolean): { agentType: 'main' | 'sub'; subAgentType?: 'plan' | 'search' | 'bash' | 'workflow' | 'unknown' } {
  if (isMain) return { agentType: 'main' };

  const messages = body.messages || [];
  const firstMessage = messages[0] as any;
  const content = firstMessage?.content;

  if (typeof content === 'string') {
    if (content.includes('plan') || content.includes('strategy') || content.includes('implementation plan')) {
      return { agentType: 'sub', subAgentType: 'plan' };
    }
  }

  const tools = body.tools || [];
  if (Array.isArray(tools)) {
    if (tools.some((t: any) => typeof t.name === 'string' && t.name.includes('search'))) {
      return { agentType: 'sub', subAgentType: 'search' };
    }
    if (tools.some((t: any) => t.name === 'bash')) {
      return { agentType: 'sub', subAgentType: 'bash' };
    }
    if (tools.some((t: any) => t.name === 'workflow')) {
      return { agentType: 'sub', subAgentType: 'workflow' };
    }
  }

  return { agentType: 'sub', subAgentType: 'unknown' };
}

/**
 * 检查是否为 Anthropic API 路径
 */
function isAnthropicApiPath(url: string): boolean {
  return API_PATH_REGEX.ANTHROPIC_MESSAGES.test(url);
}

/**
 * 检查是否为 OpenAI API 路径
 */
function isOpenAIApiPath(url: string): boolean {
  return API_PATH_REGEX.OPENAI_CHAT.test(url);
}

// ==================== 响应处理 ====================

interface DeltaState {
  originalMessagesLength: number;
  originalTailFp: string;
}

/**
 * 构建响应基础信息（status, statusText, headers）
 */
function buildResponseBase(response: Response): {
  status: number;
  statusText: string;
  headers: Record<string, string>;
} {
  return {
    status: response.status,
    statusText: response.statusText,
    headers: Object.fromEntries((response.headers as any).entries()),
  };
}

/**
 * 处理流式响应：tee body，后台提取 SSE，返回客户端响应
 */
function handleStreamingResponse(
  response: Response,
  entry: RawLogEntry,
  deltaState: DeltaState,
): Response {
  entry.response = {
    ...buildResponseBase(response),
    body: null,
  };

  const [clientBody, logBody] = response.body!.tee();

  // 创建后台任务并跟踪
  const task = extractInBackground(logBody, entry,
    (e) => LogWriter.writeLogEntry(e),
    () => commitDeltaState(deltaState.originalMessagesLength, deltaState.originalTailFp),
  );
  pendingSSETasks.add(task);
  task.finally(() => pendingSSETasks.delete(task));

  dbgSse('SSE 流开始提取: id=%s pending=%d', entry.id, pendingSSETasks.size);

  return new Response(clientBody, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * 处理流式响应失败：记录错误，提交 delta
 */
function handleStreamingFailure(
  response: Response,
  entry: RawLogEntry,
  deltaState: DeltaState,
): void {
  entry.response = {
    ...buildResponseBase(response),
    body: '[Streaming Response - Capture failed]',
  };
  LogWriter.writeLogEntry(entry);
  commitDeltaState(deltaState.originalMessagesLength, deltaState.originalTailFp);
}

/**
 * 处理非流式响应：克隆、解析、记录日志
 */
async function handleNormalResponse(
  response: Response,
  entry: RawLogEntry,
  deltaState: DeltaState,
): Promise<void> {
  const cloned = response.clone();
  const text = await cloned.text();

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text.slice(0, MAX_RESPONSE_BODY_LENGTH);
  }

  entry.response = {
    ...buildResponseBase(response),
    body,
  };

  // 从响应体提取 token 使用情况
  entry.tokenUsage = extractTokenUsage(body);

  LogWriter.writeLogEntry(entry);
  commitDeltaState(deltaState.originalMessagesLength, deltaState.originalTailFp);
}

// ==================== 请求处理 ====================

/**
 * 判断是否需要拦截此请求，同时返回检测到的 API 类型
 * 返回 null 表示不拦截，返回 ApiProviderType 表示需要拦截
 */
function checkIntercept(urlStr: string, headers: Record<string, unknown>): ApiProviderType | null {
  const isInternal = headers[INTERNAL_HEADERS[0]] || headers[INTERNAL_HEADERS[1]];
  const isProxyTrace = headers[PROXY_TRACE_HEADER] === 'true' || headers[PROXY_TRACE_HEADER] === true;

  if (isInternal) return null;

  // 先检测 API 类型（只调用一次）
  const detectedApiType = detectApiType(urlStr);

  if (isProxyTrace ||
      urlStr.includes('anthropic') ||
      urlStr.includes('claude') ||
      urlStr.includes('openai') ||
      isAnthropicApiPath(urlStr) ||
      isOpenAIApiPath(urlStr) ||
      detectedApiType !== null) {
    return detectedApiType; // 返回检测结果（可能为 null 但仍需拦截）
  }

  return null;
}

/**
 * 解析请求 body
 */
function parseRequestBody(bodyRaw: string | undefined): unknown {
  if (!bodyRaw) return null;
  try {
    return JSON.parse(bodyRaw);
  } catch {
    const truncated = String(bodyRaw).slice(0, MAX_BODY_PARSE_FAILURE_LENGTH);
    dbg('body 解析失败, 存储为截断字符串 len=%d', truncated.length);
    return truncated;
  }
}

/**
 * 转换 headers 为普通对象
 */
function normalizeHeaders(rawHeaders: HeadersInit | undefined): Record<string, string> {
  if (!rawHeaders) return {};
  if (rawHeaders instanceof Headers) {
    return Object.fromEntries(rawHeaders as any);
  }
  return { ...rawHeaders } as Record<string, string>;
}

/**
 * 构建请求日志条目
 */
function buildRequestEntry(
  urlStr: string,
  options: RequestInit | undefined,
  body: unknown,
  startTime: number,
  detectedApiType: ApiProviderType | null,
): RawLogEntry {
  const headers = normalizeHeaders(options?.headers);
  const safeHeaders = sanitizeHeaders(headers);
  const isMain = isMainAgentRequest(body);
  const { agentType, subAgentType } = parseAgentType(body, isMain);
  const model = (body as any)?.model || 'unknown';

  const requestId = `${startTime}_${Math.random().toString(36).substring(2, 11)}`;

  dbg('拦截 %s %s apiType=%s agentType=%s subAgentType=%s model=%s stream=%s',
    options?.method || 'GET', urlStr, detectedApiType ?? '-', agentType, subAgentType ?? '-',
    model, (body as any)?.stream === true);

  return {
    id: requestId,
    timestamp: new Date().toISOString(),
    project: '',
    url: urlStr,
    method: options?.method || 'GET',
    headers: safeHeaders,
    body,
    response: null,
    duration: 0,
    isStream: (body as any)?.stream === true,
    mainAgent: isMain,
    agentType,
    subAgentType,
    apiType: detectedApiType || undefined,
  };
}

/**
 * 处理 Delta 存储（仅对主 Agent）
 */
function processDeltaForMainAgent(entry: RawLogEntry, body: unknown): DeltaState {
  const defaultState: DeltaState = { originalMessagesLength: 0, originalTailFp: '' };
  if (!entry.mainAgent || !Array.isArray((body as any)?.messages)) {
    return defaultState;
  }
  const { deltaOriginalMessagesLength, deltaOriginalTailFp } = processDelta(entry, body as any);
  return { originalMessagesLength: deltaOriginalMessagesLength, originalTailFp: deltaOriginalTailFp };
}

// ==================== 拦截器安装 ====================

export function setupInterceptor(): void {
  if (interceptorInstalled) return;
  interceptorInstalled = true;

  const rc = resolveEffectiveConfig();
  dbg('安装拦截器, logDir=%s maxLogFileSize=%d', rc.logDir, rc.maxLogFileSize);

  const originalFetch = globalThis.fetch;

  globalThis.fetch = async function (url: URL | RequestInfo, options?: RequestInit): Promise<Response> {
    const startTime = Date.now();
    const urlStr = typeof url === 'string' ? url : (url instanceof URL ? url.href : String(url));
    const headers = normalizeHeaders(options?.headers);

    // 检查是否需要拦截，同时获取 API 类型（避免重复检测）
    const detectedApiType = checkIntercept(urlStr, headers);
    if (detectedApiType === null) {
      return originalFetch.call(this, url, options);
    }

    // 清理代理标记 header
    if (headers[PROXY_TRACE_HEADER] && options?.headers) {
      delete (options.headers as Record<string, unknown>)[PROXY_TRACE_HEADER];
    }

    // 构建请求日志
    const body = parseRequestBody(options?.body as string | undefined);
    const entry = buildRequestEntry(urlStr, options, body, startTime, detectedApiType);
    const deltaState = processDeltaForMainAgent(entry, body);

    // 主 Agent 检查日志轮转
    if (entry.mainAgent) {
      LogWriter.checkAndRotateLogFile();
    }

    try {
      const response = await originalFetch.call(this, url, options);
      entry.duration = Date.now() - startTime;

      if (entry.isStream) {
        try {
          return handleStreamingResponse(response, entry, deltaState);
        } catch {
          handleStreamingFailure(response, entry, deltaState);
          return response;
        }
      } else {
        try {
          await handleNormalResponse(response, entry, deltaState);
        } catch {
          // 非流式失败也要记录
          LogWriter.writeLogEntry(entry);
          commitDeltaState(deltaState.originalMessagesLength, deltaState.originalTailFp);
        }
        return response;
      }
    } catch (err) {
      entry.duration = Date.now() - startTime;
      entry.error = err instanceof Error ? err.message : String(err);
      LogWriter.writeLogEntry(entry);
      throw err;
    }
  };

  console.log('[AgentProxy Interceptor] Fetch 拦截器已安装');
}

// ==================== 导出 ====================

export function getInterceptorState() {
  return {
    logFile: LogWriter.getCurrentLogFile(),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  setupInterceptor();
}
