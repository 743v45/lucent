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
import type { RawLogEntry } from './types.js';
import createDebug from 'debug';
const dbg = createDebug('agentproxy:interceptor');
const dbgSse = createDebug('agentproxy:interceptor:sse');

// ==================== 状态 ====================

let interceptorInstalled = false;

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

// ==================== 拦截器设置 ====================

export function setupInterceptor(): void {
  if (interceptorInstalled) return;
  interceptorInstalled = true;

  const rc = resolveEffectiveConfig();
  dbg('安装拦截器, logDir=%s maxLogFileSize=%d', rc.logDir, rc.maxLogFileSize);

  const originalFetch = globalThis.fetch;

  globalThis.fetch = async function (url: URL | RequestInfo, options?: RequestInit): Promise<Response> {
    const startTime = Date.now();
    let requestEntry: RawLogEntry | null = null;

    // Delta 存储变量（需要在整个请求-响应周期中保持）
    let deltaOriginalMessagesLength = 0;
    let deltaOriginalTailFp = '';

    try {
      const urlStr = typeof url === 'string' ? url : (url instanceof URL ? url.href : String(url));

      // 检查是否为需要拦截的请求
      const headers = options?.headers || {};
      const isInternalRequest = (headers as any)[INTERNAL_HEADERS[0]] || (headers as any)[INTERNAL_HEADERS[1]];
      const isProxyTrace = (headers as any)[PROXY_TRACE_HEADER] === 'true' || (headers as any)[PROXY_TRACE_HEADER] === true;

      const shouldIntercept = !isInternalRequest && (
        isProxyTrace ||
        urlStr.includes('anthropic') ||
        urlStr.includes('claude') ||
        urlStr.includes('openai') ||
        isAnthropicApiPath(urlStr) ||
        isOpenAIApiPath(urlStr) ||
        detectApiType(urlStr) !== null
      );

      if (shouldIntercept) {
        // 清理代理标记 header
        if (isProxyTrace && options?.headers) {
          delete (options.headers as any)[PROXY_TRACE_HEADER];
        }

        // 解析请求体
        let body: any = null;
        if (options?.body) {
          try {
            body = JSON.parse(options.body as string);
          } catch {
            body = String(options.body).slice(0, MAX_BODY_PARSE_FAILURE_LENGTH);
            dbg('body 解析失败, 存储为截断字符串 len=%d', body.length);
          }
        }

        // 转换 headers
        let reqHeaders: Record<string, string> = {};
        const rawHeaders = options?.headers;
        if (rawHeaders) {
          if (rawHeaders instanceof Headers) {
            reqHeaders = Object.fromEntries(rawHeaders as any);
          } else if (typeof rawHeaders === 'object') {
            reqHeaders = { ...rawHeaders } as Record<string, string>;
          }
        }

        const safeHeaders = sanitizeHeaders(reqHeaders);
        const isMain = isMainAgentRequest(body);
        const { agentType, subAgentType } = parseAgentType(body, isMain);
        const isStream = body?.stream === true;
        const requestId = `${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
        const model = body?.model || 'unknown';
        const detectedApiType = detectApiType(urlStr);

        requestEntry = {
          id: requestId,
          timestamp: new Date().toISOString(),
          project: '',
          url: urlStr,
          method: options?.method || 'GET',
          headers: safeHeaders,
          body,
          response: null,
          duration: 0,
          isStream,
          mainAgent: isMain,
          agentType,
          subAgentType,
          apiType: detectedApiType || undefined,
        };

        dbg('拦截 %s %s apiType=%s agentType=%s subAgentType=%s model=%s stream=%s',
          options?.method || 'GET', urlStr, detectedApiType ?? '-', agentType, subAgentType ?? '-',
          model, isStream);

        // Delta 存储处理
        if (isMain && Array.isArray(body?.messages)) {
          const { deltaOriginalMessagesLength: dLen, deltaOriginalTailFp: dFp } = processDelta(requestEntry, body);
          deltaOriginalMessagesLength = dLen;
          deltaOriginalTailFp = dFp;
        }

        // 检查日志文件大小并轮转
        if (isMain) {
          LogWriter.checkAndRotateLogFile();
        }
      }

      // 发起请求
      const response = await originalFetch.call(this, url, options);

      if (requestEntry) {
        const entry = requestEntry;
        entry.duration = Date.now() - startTime;

        if (entry.isStream) {
          // 流式响应
          try {
            entry.response = {
              status: response.status,
              statusText: response.statusText,
              headers: Object.fromEntries(response.headers.entries()),
              body: null,
            };

            const [clientBody, logBody] = response.body!.tee();
            extractInBackground(logBody, entry,
              (e) => LogWriter.writeLogEntry(e),
              () => commitDeltaState(deltaOriginalMessagesLength, deltaOriginalTailFp),
            );
            dbgSse('SSE 流开始提取: id=%s', entry.id);

            return new Response(clientBody, {
              status: response.status,
              statusText: response.statusText,
              headers: response.headers,
            });
          } catch (err) {
            entry.response = {
              status: response.status,
              statusText: response.statusText,
              headers: Object.fromEntries(response.headers.entries()),
              body: '[Streaming Response - Capture failed]',
            };
            LogWriter.writeLogEntry(requestEntry);
            commitDeltaState(deltaOriginalMessagesLength, deltaOriginalTailFp);
          }
        } else {
          // 非流式响应
          try {
            const clonedResponse = response.clone();
            const responseText = await clonedResponse.text();
            let responseData: any = null;

            try {
              responseData = JSON.parse(responseText);
            } catch {
              responseData = responseText.slice(0, MAX_RESPONSE_BODY_LENGTH);
            }

            entry.response = {
              status: response.status,
              statusText: response.statusText,
              headers: Object.fromEntries(response.headers.entries()),
              body: responseData,
            };

            LogWriter.writeLogEntry(requestEntry);
            commitDeltaState(deltaOriginalMessagesLength, deltaOriginalTailFp);
          } catch (err) {
            LogWriter.writeLogEntry(requestEntry);
            commitDeltaState(deltaOriginalMessagesLength, deltaOriginalTailFp);
          }
        }
      }

      return response;
    } catch (err) {
      if (requestEntry) {
        requestEntry.duration = Date.now() - startTime;
        requestEntry.error = err instanceof Error ? err.message : String(err);
        LogWriter.writeLogEntry(requestEntry);
      }
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
