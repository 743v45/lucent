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
 * Header 脱敏 → utils.ts
 */

import { resolveEffectiveConfig } from './config.js';
import { sanitizeHeaders } from './utils.js';
import { extractInBackground } from './sse-extractor.js';
import * as LogWriter from './services/log-writer.js';
import {
  INTERNAL_HEADERS,
  PROXY_TRACE_HEADER,
  REQ_START_HEADER,
  MAX_BODY_PARSE_FAILURE_LENGTH,
  MAX_RESPONSE_BODY_LENGTH,
} from './constants.js';
import { extractTokenUsage, identifyClient, classifyAgent } from './agent-identifier.js';
import { globalSessionTracker } from './session-tracker.js';
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
  reqStartMs: number,
): Response {
  entry.response = {
    ...buildResponseBase(response),
    body: null,
  };

  if (response.body == null) {
    throw new Error('流式响应缺少 body');
  }
  const [clientBody, logBody] = response.body.tee();
  const task = extractInBackground(logBody, entry, reqStartMs,
    (e) => LogWriter.writeLogEntry(e),
    () => {},
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
): void {
  entry.response = {
    ...buildResponseBase(response),
    body: '[Streaming Response - Capture failed]',
  };
  LogWriter.writeLogEntry(entry);
}

async function handleNormalResponse(
  response: Response,
  entry: RawLogEntry,
  reqStartMs: number,
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

  // duration 统一在「响应体完全消费」后定值（响应头到达 ≠ 完成）
  entry.duration = Date.now() - reqStartMs;
  entry.tokenUsage = extractTokenUsage(body);
  LogWriter.writeLogEntry(entry);
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
  const agentType = classifyAgent(body);
  const isMain = agentType === 'main';
  const nowISO = new Date().toISOString();
  // main：内容寻址算 threadId；sub：落最近活跃 main 的 threadId（时间邻近，非内容寻址——
  // sub 的 body 是独立子任务 prompt，无父对话前缀/父引用，只能靠运行期 lineage 归属）。
  const threadId = isMain
    ? globalSessionTracker.identify(body, urlStr, nowISO)
    : globalSessionTracker.findRecentThread(nowISO);
  const model = (body as any)?.model || 'unknown';
  const clientType = identifyClient(headers);
  const isTest = isTestRequest(body);

  const requestId = `${startTime}_${Math.random().toString(36).substring(2, 11)}`;

  dbg('拦截 %s %s provider=%s endpoint=%s agentType=%s clientType=%s model=%s stream=%s isTest=%s',
    options?.method || 'GET', urlStr,
    providerName ?? '-', endpointType ?? '-',
    agentType, clientType, model,
    (body as any)?.stream === true, isTest);

  return {
    id: requestId,
    timestamp: nowISO,
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
    apiType: endpointType || undefined,
    clientType,
    isTest,
    providerName: providerName || undefined,
    endpointType: endpointType || undefined,
    threadId,
  };
}

// ==================== 拦截器安装 ====================

export function setupInterceptor(): void {
  if (interceptorInstalled) return;
  interceptorInstalled = true;

  const rc = resolveEffectiveConfig();
  dbg('安装拦截器, logDir=%s dbPath=%s', rc.logDir, rc.dbPath);

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

    // TTFT/Duration 时钟起点：优先 proxy.ts 注入的「客户端请求到达代理」时刻；
    // 缺失/非法（如不走 proxy.ts 的直连 fetch）回退到本拦截器 fetch 起始时间。
    const reqStartRaw = headers[REQ_START_HEADER];
    const reqStartParsed = reqStartRaw !== undefined ? Number(reqStartRaw) : NaN;
    const reqStartMs = Number.isFinite(reqStartParsed) ? reqStartParsed : startTime;

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
      delete h[REQ_START_HEADER];
    }

    // 构建请求日志
    const body = parseRequestBody(options?.body as string | undefined);
    const entry = buildRequestEntry(urlStr, options, body, startTime, providerName, endpointType);

    try {
      const response = await originalFetch.call(this, url, options);
      // 临时 duration（响应头到达）；流式由收集器在流结束覆盖、非流式由 handleNormalResponse 在 body 读完后覆盖
      entry.duration = Date.now() - reqStartMs;

      // 优先根据 response Content-Type 判断是否为流式响应，回退到 request.body.stream
      const respCT = (response.headers.get('content-type') || '').toLowerCase();
      const isStreamResponse = respCT.includes('text/event-stream')
        || (!respCT.includes('application/json') && entry.isStream);

      if (isStreamResponse) {
        try {
          return handleStreamingResponse(response, entry, reqStartMs);
        } catch {
          handleStreamingFailure(response, entry);
          return response;
        }
      } else {
        try {
          await handleNormalResponse(response, entry, reqStartMs);
        } catch {
          LogWriter.writeLogEntry(entry);
        }
        return response;
      }
    } catch (err) {
      entry.duration = Date.now() - reqStartMs;
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