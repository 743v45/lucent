/**
 * Lucent Fetch 拦截器模块
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
import { sanitizeHeaders } from './utils.js';
import { extractInBackground } from './sse-extractor.js';
import { processDelta, commitDeltaState } from './delta-storage.js';
import * as LogWriter from './services/log-writer.js';
import {
  INTERNAL_HEADERS,
  PROXY_TRACE_HEADER,
  MAX_BODY_PARSE_FAILURE_LENGTH,
  MAX_RESPONSE_BODY_LENGTH,
} from './constants.js';
import { extractTokenUsage, identifyClient } from './agent-identifier.js';
import type { EndpointType, RawLogEntry } from './types.js';
import createDebug from 'debug';
const dbg = createDebug('lucent:interceptor');
const dbgSse = createDebug('lucent:interceptor:sse');

// ==================== 状态 ====================

let interceptorInstalled = false;
const pendingSSETasks = new Set<Promise<void>>();

/** 优雅关闭时等待 SSE 任务的超时（毫秒） */
const DRAIN_TIMEOUT_MS = 5_000;

export async function drainPendingSSETasks(): Promise<void> {
  if (pendingSSETasks.size === 0) return;
  dbg('等待后台 SSE 任务完成: count=%d', pendingSSETasks.size);

  // 超时保护：避免单个后台任务卡住导致优雅关闭无限阻塞
  const allSettled = Promise.allSettled([...pendingSSETasks]);
  const timeout = new Promise<'timeout'>((resolve) =>
    setTimeout(() => resolve('timeout'), DRAIN_TIMEOUT_MS),
  );

  const result = await Promise.race([allSettled, timeout]);
  if (result === 'timeout') {
    dbg('排空超时（%dms），强制继续: count=%d', DRAIN_TIMEOUT_MS, pendingSSETasks.size);
    return;
  }
  dbg('所有后台 SSE 任务已完成');
}

// ==================== 工具函数 ====================

function isMainAgentRequest(body: any): boolean {
  if (!body || typeof body !== 'object') return false;
  const messages = body.messages;
  if (!Array.isArray(messages)) return false;
  if (messages.length >= 2) return true;
  return messages.some((m: any) => m.role === 'assistant');
}

function parseAgentType(body: any, isMain: boolean): { agentType: 'main' | 'sub'; subAgentType?: 'plan' | 'search' | 'bash' | 'workflow' | 'unknown' } {
  if (isMain) return { agentType: 'main' };
  if (!body || !body.messages) return { agentType: 'sub', subAgentType: 'unknown' };

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

function normalizeHeaders(rawHeaders: HeadersInit | undefined): Record<string, string> {
  if (!rawHeaders) return {};
  if (rawHeaders instanceof Headers) return Object.fromEntries(rawHeaders as any);
  return { ...rawHeaders } as Record<string, string>;
}

function isTestRequest(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  const messages = (body as any).messages;
  if (!Array.isArray(messages)) return false;
  const firstUserMsg = messages.find((m: any) => m.role === 'user');
  if (!firstUserMsg) return false;
  const content = firstUserMsg.content;
  if (typeof content !== 'string') return false;
  const trimmed = content.trim().toLowerCase();
  return /^hi[!?.?\s]*$/.test(trimmed);
}

// ==================== 响应处理 ====================

interface DeltaState {
  originalMessagesLength: number;
  originalTailFp: string;
}

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

function handleStreamingResponse(
  response: Response,
  entry: RawLogEntry,
  deltaState: DeltaState,
): Response {
  entry.response = {
    ...buildResponseBase(response),
    body: null,
  };

  if (response.body == null) {
    throw new Error('流式响应缺少 body');
  }
  const [clientBody, logBody] = response.body.tee();
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

  entry.tokenUsage = extractTokenUsage(body);
  LogWriter.writeLogEntry(entry);
  commitDeltaState(deltaState.originalMessagesLength, deltaState.originalTailFp);
}

// ==================== 请求处理 ====================

function buildRequestEntry(
  urlStr: string,
  options: RequestInit | undefined,
  body: unknown,
  startTime: number,
  providerName: string | null,
  endpointType: EndpointType | null,
): RawLogEntry {
  const headers = normalizeHeaders(options?.headers);
  const safeHeaders = sanitizeHeaders(headers);
  const isMain = isMainAgentRequest(body);
  const { agentType, subAgentType } = parseAgentType(body, isMain);
  const model = (body as any)?.model || 'unknown';
  const clientType = identifyClient(headers);
  const isTest = isTestRequest(body);

  const requestId = `${startTime}_${Math.random().toString(36).substring(2, 11)}`;

  dbg('拦截 %s %s provider=%s endpoint=%s agentType=%s subAgentType=%s clientType=%s model=%s stream=%s isTest=%s',
    options?.method || 'GET', urlStr,
    providerName ?? '-', endpointType ?? '-',
    agentType, subAgentType ?? '-', clientType, model,
    (body as any)?.stream === true, isTest);

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
    apiType: endpointType || undefined,
    clientType,
    isTest,
    providerName: providerName || undefined,
    endpointType: endpointType || undefined,
  };
}

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

    // 内部请求不拦截
    const isInternal = headers[INTERNAL_HEADERS[0]] || headers[INTERNAL_HEADERS[1]];
    if (isInternal) {
      return originalFetch.call(this, url, options);
    }

    // 检查是否为代理转发请求（由 proxy.ts 发起）
    const isProxyTrace = headers[PROXY_TRACE_HEADER] === 'true';

    // 从代理 header 读取 providerName + endpointType（proxy.ts 注入）
    const providerName = headers['x-lucent-provider'] || null;
    const endpointType = (headers['x-lucent-endpoint'] as EndpointType) || null;

    // 只拦截代理转发请求或显式包含 anthropic/openai 的 URL
    if (!isProxyTrace && !urlStr.includes('anthropic') && !urlStr.includes('claude') && !urlStr.includes('openai')) {
      return originalFetch.call(this, url, options);
    }

    // 清理代理标记 header（不发送给上游）
    if (options?.headers) {
      const h = options.headers as Record<string, unknown>;
      delete h[PROXY_TRACE_HEADER];
      delete h['x-lucent-provider'];
      delete h['x-lucent-endpoint'];
    }

    // 构建请求日志
    const body = parseRequestBody(options?.body as string | undefined);
    const entry = buildRequestEntry(urlStr, options, body, startTime, providerName, endpointType);
    const deltaState = processDeltaForMainAgent(entry, body);

    // 主 Agent 检查日志轮转
    if (entry.mainAgent) {
      LogWriter.checkAndRotateLogFile();
    }

    try {
      const response = await originalFetch.call(this, url, options);
      entry.duration = Date.now() - startTime;

      // 优先根据 response Content-Type 判断是否为流式响应，回退到 request.body.stream
      const respCT = (response.headers.get('content-type') || '').toLowerCase();
      const isStreamResponse = respCT.includes('text/event-stream')
        || (!respCT.includes('application/json') && entry.isStream);

      if (isStreamResponse) {
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
          LogWriter.writeLogEntry(entry);
          commitDeltaState(deltaState.originalMessagesLength, deltaState.originalTailFp);
        }
        return response;
      }
    } catch (err) {
      entry.duration = Date.now() - startTime;
      const errno = (err as NodeJS.ErrnoException)?.code;
      if (errno === 'EPIPE') {
        // 客户端断开，静默处理，返回空 Response（fetch 约定必须返回 Response）
        return new Response(null, { status: 499, statusText: 'Client Closed Request' });
      }

      entry.error = err instanceof Error ? err.message : String(err);
      LogWriter.writeLogEntry(entry);
      throw err;
    }
  };

  console.log('[Lucent Interceptor] Fetch 拦截器已安装');
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