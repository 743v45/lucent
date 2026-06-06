/**
 * AgentProxy Fetch 拦截器模块
 *
 * 功能：
 * - 拦截所有 API 请求
 * - 记录请求/响应到 JSONL 日志
 * - 支持 Delta 存储（增量存储）
 * - 识别主/辅 Agent 类型
 * - 支持流式响应捕获
 */

import { appendFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import { EventSourceParserStream } from 'eventsource-parser/stream';

import {
  DELTA_CHECKPOINT_INTERVAL,
  API_PATH_REGEX,
  API_KEY_MASK_THRESHOLD,
  API_KEY_MASK_PREFIX,
  API_KEY_MASK_SUFFIX,
  LOG_ENTRY_SEPARATOR,
  INTERNAL_HEADERS,
  PROXY_TRACE_HEADER,
  MAX_BODY_PARSE_FAILURE_LENGTH,
  MAX_STREAM_ERROR_BODY_LENGTH,
  MAX_RESPONSE_BODY_LENGTH,
} from './constants.js';
import { resolveEffectiveConfig } from './config.js';
import createDebug from 'debug';
const dbg = createDebug('agentproxy:interceptor');
const dbgSse = createDebug('agentproxy:interceptor:sse');
const dbgDelta = createDebug('agentproxy:interceptor:delta');

// ==================== 配置 ====================
// 日志配置在 setupInterceptor() 中从 resolveEffectiveConfig() 惰性获取

// ==================== 状态 ====================
let interceptorConfig: {
  logDir: string;
  maxLogFileSize: number;
  deltaStorageEnabled: boolean;
  checkpointInterval: number;
} | null = null;

// ==================== 状态 ====================
let currentLogFile: string | null = null;
let projectDir: string = '';
let _lastMessagesCount = 0; // 截至最近一次请求的完整 messages 数量
let _lastTailFp = ''; // 截至最近一次请求的末位 message 指纹
let _mainAgentDeltaCount = 0; // mainAgent 请求计数器

// ==================== 类型定义 ====================
export type ApiProviderType = 'anthropic-messages' | 'openai-chat' | 'openai-responses';

export interface LogEntry {
  id: string;
  timestamp: string;
  project: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  body: any;
  request?: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body: any;
  };
  response: {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body: any;
  } | null;
  duration: number;
  isStream: boolean;
  mainAgent: boolean;
  inProgress?: boolean;
  agentType?: 'main' | 'sub';
  subAgentType?: 'plan' | 'search' | 'bash' | 'workflow' | 'unknown';
  apiType?: ApiProviderType;
  // Delta 存储字段
  _deltaFormat?: number;
  _totalMessageCount?: number;
  _conversationId?: string;
  _isCheckpoint?: boolean;
  _inPlaceReplaceDetected?: boolean;
  // 其他元数据
  proxyProfile?: string;
  proxyUrl?: string;
  error?: string;
}

// ==================== SSE 流提取类型 ====================
export interface ExtractedInfo {
  text: string;
  thinking: string;
  toolCalls: Array<{ id?: string; name: string; input: any }>;
  usage: { input: number; output: number; cache_read: number; cache_create: number };
  stopReason: string;
  model: string;
}

/**
 * 从 SSE 事件中提取关键信息
 * 支持 Anthropic、OpenAI 格式
 */
export function extractFromEvent(eventType: string, data: any, acc: ExtractedInfo): void {
  // Anthropic 格式
  if (eventType === 'message_start') {
    acc.model = data.message?.model || acc.model;
    acc.usage.input = data.message?.usage?.input_tokens || acc.usage.input;
    acc.usage.cache_create = data.message?.usage?.cache_creation_input_tokens || acc.usage.cache_create;
    acc.usage.cache_read = data.message?.usage?.cache_read_input_tokens || acc.usage.cache_read;
  } else if (eventType === 'content_block_start') {
    const block = data.content_block;
    if (block?.type === 'tool_use') {
      acc.toolCalls.push({ id: block.id, name: block.name, input: {} });
    }
  } else if (eventType === 'content_block_delta') {
    const delta = data.delta;
    const idx = data.index;
    if (delta?.type === 'text_delta') {
      acc.text += delta.text || '';
    } else if (delta?.type === 'thinking_delta') {
      acc.thinking += delta.thinking || '';
    } else if (delta?.type === 'input_json_delta' && idx !== undefined) {
      // 拼接工具调用参数
      const toolCall = acc.toolCalls[idx];
      if (toolCall && typeof toolCall.input === 'string') {
        toolCall.input += delta.partial_json || '';
      } else if (toolCall) {
        toolCall.input = delta.partial_json || '';
      }
    }
  } else if (eventType === 'message_delta') {
    acc.stopReason = data.delta?.stop_reason || acc.stopReason;
    acc.usage.output = data.usage?.output_tokens || acc.usage.output;
  }

  // OpenAI Chat 格式（无 event，直接看 data.choices）
  else if (data.choices && Array.isArray(data.choices)) {
    const delta = data.choices[0]?.delta;
    if (delta?.content) {
      acc.text += delta.content;
    }
    if (delta?.tool_calls) {
      for (const tc of delta.tool_calls) {
        if (tc.index !== undefined) {
          if (!acc.toolCalls[tc.index]) {
            acc.toolCalls[tc.index] = { id: tc.id, name: '', input: '' };
          }
          if (tc.function?.name) acc.toolCalls[tc.index].name += tc.function.name;
          if (tc.function?.arguments) {
            acc.toolCalls[tc.index].input += tc.function.arguments;
          }
        }
      }
    }
    if (data.choices[0]?.finish_reason) {
      acc.stopReason = data.choices[0].finish_reason;
    }
    if (data.usage) {
      acc.usage.input = data.usage.prompt_tokens || acc.usage.input;
      acc.usage.output = data.usage.completion_tokens || acc.usage.output;
      acc.usage.cache_read = data.usage.prompt_tokens_details?.cached_tokens || acc.usage.cache_read;
    }
  }

  // OpenAI Responses API 格式
  else if (data.type && typeof data.type === 'string' && data.type.startsWith('response.')) {
    if (data.type === 'response.output_text.delta') {
      acc.text += data.delta || '';
    }
    if (data.type === 'response.function_call_arguments.delta') {
      const callId = data.call_id;
      const toolCall = acc.toolCalls.find(tc => tc.id === callId);
      if (toolCall && typeof toolCall.input === 'string') {
        toolCall.input += data.delta || '';
      }
    }
    if (data.type === 'response.completed' && data.response?.usage) {
      acc.usage.input = data.response.usage.input_tokens || acc.usage.input;
      acc.usage.output = data.response.usage.output_tokens || acc.usage.output;
    }
  }
}

/**
 * 后台提取 SSE 流数据（不阻塞客户端响应）
 */
export async function extractInBackground(
  body: ReadableStream<Uint8Array>,
  entry: LogEntry,
  deltaOriginalMessagesLength: number,
  deltaOriginalTailFp: string
): Promise<void> {
  const extracted: ExtractedInfo = {
    text: '',
    thinking: '',
    toolCalls: [],
    usage: { input: 0, output: 0, cache_read: 0, cache_create: 0 },
    stopReason: '',
    model: '',
  };

  try {
    const eventStream = body
      .pipeThrough(new TextDecoderStream() as any)
      .pipeThrough(new EventSourceParserStream()) as ReadableStream<any>;

    const reader = eventStream.getReader();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      try {
        const data = JSON.parse(value.data);
        extractFromEvent(value.event || '', data, extracted);
      } catch {
        // JSON 解析失败，跳过
      }
    }

    // 解析工具调用参数（从字符串转为对象）
    for (const tc of extracted.toolCalls) {
      if (typeof tc.input === 'string' && tc.input) {
        try {
          tc.input = JSON.parse(tc.input);
        } catch {
          // 保持字符串
        }
      }
    }

    // 写入日志
    entry.response = {
      status: entry.response?.status || 200,
      statusText: entry.response?.statusText || 'OK',
      headers: entry.response?.headers || {},
      body: {
        type: 'message',
        role: 'assistant',
        model: extracted.model,
        content: [
          ...(extracted.text ? [{ type: 'text', text: extracted.text }] : []),
          ...(extracted.thinking ? [{ type: 'thinking', thinking: extracted.thinking }] : []),
          ...extracted.toolCalls.map(tc => ({ type: 'tool_use', ...tc })),
        ],
        stop_reason: extracted.stopReason,
        usage: extracted.usage,
      },
    };

    writeLogEntry(entry);
    commitDeltaState(deltaOriginalMessagesLength, deltaOriginalTailFp);

    dbgSse('SSE 提取完成: textLen=%d thinkingLen=%d toolCalls=%d usage=%o stopReason=%s model=%s',
      extracted.text.length, extracted.thinking.length, extracted.toolCalls.length,
      extracted.usage, extracted.stopReason, extracted.model);
  } catch (err) {
    dbgSse('SSE 提取失败: %O', err);
    entry.response = {
      status: entry.response?.status || 200,
      statusText: entry.response?.statusText || 'OK',
      headers: entry.response?.headers || {},
      body: '[Streaming Response - Extract failed]',
    };
    writeLogEntry(entry);
    commitDeltaState(deltaOriginalMessagesLength, deltaOriginalTailFp);
  }
}

// ==================== 工具函数 ====================

function ensureConfig(): void {
  if (!interceptorConfig) {
    const rc = resolveEffectiveConfig();
    interceptorConfig = {
      logDir: rc.logDir,
      maxLogFileSize: rc.maxLogFileSize,
      deltaStorageEnabled: true,
      checkpointInterval: DELTA_CHECKPOINT_INTERVAL,
    };
  }
}

/**
 * 初始化日志目录
 */
function initLogDir(): void {
  ensureConfig();
  if (!existsSync(interceptorConfig!.logDir)) {
    mkdirSync(interceptorConfig!.logDir, { recursive: true });
  }
}

/**
 * 获取当前项目目录
 */
function getCurrentProjectDir(): string {
  try {
    return process.cwd();
  } catch {
    return homedir();
  }
}

/**
 * 生成日志文件路径
 */
function generateLogFilePath(): string {
  const now = new Date();
  const date = now.toISOString().split('T')[0];
  const time = now.toTimeString().split(' ')[0].replace(/:/g, '-');
  const projectName = basename(getCurrentProjectDir()).replace(/[^a-zA-Z0-9_\-\.]/g, '_');
  return join(interceptorConfig!.logDir, `${projectName}_${date}_${time}.jsonl`);
}

/**
 * 初始化日志文件
 */
function initLogFile(): void {
  initLogDir();
  projectDir = getCurrentProjectDir();
  currentLogFile = generateLogFilePath();
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

/**
 * 检测 API 类型
 */
function detectApiType(url: string): ApiProviderType | null {
  if (API_PATH_REGEX.OPENAI_RESPONSES.test(url)) return 'openai-responses';
  if (API_PATH_REGEX.ANTHROPIC_MESSAGES.test(url)) return 'anthropic-messages';
  if (API_PATH_REGEX.OPENAI_CHAT.test(url)) return 'openai-chat';
  return null;
}

/**
 * 判断是否为主 Agent 请求
 * 主 Agent 识别标准：
 * 1. 包含完整的 messages 数组（>=2 条）
 * 2. 或者包含 user + assistant 的对话历史
 */
function isMainAgentRequest(body: any): boolean {
  if (!body || typeof body !== 'object') {
    return false;
  }

  const messages = body.messages;
  if (!Array.isArray(messages)) {
    return false;
  }

  // 至少包含 2 条消息（通常是 user + assistant）
  if (messages.length >= 2) {
    return true;
  }

  // 检查是否有对话历史（包含 assistant 角色）
  const hasAssistant = messages.some((m: any) => m.role === 'assistant');
  return hasAssistant;
}

/**
 * 解析 Agent 类型
 */
function parseAgentType(body: any, isMain: boolean): { agentType: 'main' | 'sub'; subAgentType?: 'plan' | 'search' | 'bash' | 'workflow' | 'unknown' } {
  if (isMain) {
    return { agentType: 'main' };
  }

  // 辅 Agent 识别
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
    const hasSearch = tools.some((t: any) => typeof t.name === 'string' && t.name.includes('search'));
    if (hasSearch) {
      return { agentType: 'sub', subAgentType: 'search' };
    }

    const hasBash = tools.some((t: any) => t.name === 'bash');
    if (hasBash) {
      return { agentType: 'sub', subAgentType: 'bash' };
    }

    const hasWorkflow = tools.some((t: any) => t.name === 'workflow');
    if (hasWorkflow) {
      return { agentType: 'sub', subAgentType: 'workflow' };
    }
  }

  return { agentType: 'sub', subAgentType: 'unknown' };
}

/**
 * 计算消息指纹（用于检测 in-place replace）
 */
function fingerprintMsg(msg: any): string {
  if (!msg) return '';
  try {
    return JSON.stringify(msg);
  } catch {
    return String(msg);
  }
}

/**
 * 脱敏敏感 headers
 */
function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
  const safe = { ...headers };

  // 脱敏 x-api-key
  if (safe['x-api-key']) {
    const k = safe['x-api-key'];
    safe['x-api-key'] = k.length > API_KEY_MASK_THRESHOLD ? `${k.slice(0, API_KEY_MASK_PREFIX)}****${k.slice(-API_KEY_MASK_SUFFIX)}` : '****';
  }

  // 脱敏 x-goog-api-key
  if (safe['x-goog-api-key']) {
    const k = safe['x-goog-api-key'];
    safe['x-goog-api-key'] = k.length > API_KEY_MASK_THRESHOLD ? `${k.slice(0, API_KEY_MASK_PREFIX)}****${k.slice(-API_KEY_MASK_SUFFIX)}` : '****';
  }

  // 脱敏 authorization
  if (safe['authorization']) {
    const v = safe['authorization'];
    const spaceIdx = v.indexOf(' ');
    if (spaceIdx > 0) {
      const scheme = v.slice(0, spaceIdx);
      const token = v.slice(spaceIdx + 1);
      safe['authorization'] = scheme + ' ' + (token.length > API_KEY_MASK_THRESHOLD ? `${token.slice(0, API_KEY_MASK_PREFIX)}****${token.slice(-API_KEY_MASK_SUFFIX)}` : '****');
    } else {
      safe['authorization'] = '****';
    }
  }

  return safe;
}

/**
 * 写入日志条目
 */
function writeLogEntry(entry: LogEntry): void {
  if (!currentLogFile) {
    initLogFile();
  }

  try {
    const line = JSON.stringify(entry) + LOG_ENTRY_SEPARATOR;
    appendFileSync(currentLogFile!, line);
  } catch (error) {
    dbg('写入日志失败: %O', error);
  }
}

/**
 * 检查并轮转日志文件
 */
function checkAndRotateLogFile(): void {
  if (!currentLogFile) return;

  try {
    if (!existsSync(currentLogFile) || statSync(currentLogFile).size < interceptorConfig!.maxLogFileSize) {
      return;
    }

    // 轮转日志文件
    currentLogFile = generateLogFilePath();
    // 重置 delta 状态
    _lastMessagesCount = 0;
    _lastTailFp = '';
    _mainAgentDeltaCount = 0;
    dbg('日志轮转: 新文件=%s, delta 状态已重置', currentLogFile);
  } catch (error) {
    dbg('日志轮转失败: %O', error);
  }
}

/**
 * Delta 存储：completed 写入成功后更新状态
 */
function commitDeltaState(originalLength: number, originalTailFp: string): void {
  if (interceptorConfig!.deltaStorageEnabled && originalLength > 0 && originalLength > _lastMessagesCount) {
    _lastMessagesCount = originalLength;
    if (typeof originalTailFp === 'string') {
      _lastTailFp = originalTailFp;
    }
  }
}

// ==================== 拦截器设置 ====================

let interceptorInstalled = false;

export function setupInterceptor(): void {
  // 避免重复拦截
  if (interceptorInstalled) {
    return;
  }
  interceptorInstalled = true;

  // 从统一配置获取日志参数
  const rc = resolveEffectiveConfig();
  interceptorConfig = {
    logDir: rc.logDir,
    maxLogFileSize: rc.maxLogFileSize,
    deltaStorageEnabled: true,
    checkpointInterval: DELTA_CHECKPOINT_INTERVAL,
  };
  dbg('安装拦截器, logDir=%s maxLogFileSize=%d', rc.logDir, rc.maxLogFileSize);

  // 初始化日志文件
  initLogFile();

  const originalFetch = globalThis.fetch;

  globalThis.fetch = async function (url: URL | RequestInfo, options?: RequestInit): Promise<Response> {
    const startTime = Date.now();
    let requestEntry: LogEntry | null = null;

    // Delta 存储变量（需要在整个请求-响应周期中保持）
    let deltaOriginalMessagesLength = 0;
    let deltaOriginalTailFp = '';

    try {
      const urlStr = typeof url === 'string' ? url : (url instanceof URL ? url.href : String(url));

      // 检查是否为需要拦截的请求
      const isInternalRequest = options?.headers && (
        (options.headers as any)[INTERNAL_HEADERS[0]] ||
        (options.headers as any)[INTERNAL_HEADERS[1]]
      );

      const headers = options?.headers || {};
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

        // 脱敏 headers
        const safeHeaders = sanitizeHeaders(reqHeaders);

        // 判断 Agent 类型
        const isMain = isMainAgentRequest(body);
        const { agentType, subAgentType } = parseAgentType(body, isMain);

        // 检查是否为流式请求
        const isStream = body?.stream === true;

        // 生成唯一请求 ID
        const requestId = `${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;

        // 从 body 中提取模型和提供商信息
        const model = body?.model || 'unknown';
        const detectedApiType = detectApiType(urlStr);
        const provider = detectedApiType ? detectedApiType.split('-')[0] :
                       urlStr.includes('anthropic') || urlStr.includes('claude') ? 'claude' :
                       urlStr.includes('openai') ? 'openai' : 'unknown';

        requestEntry = {
          id: requestId,
          timestamp: new Date().toISOString(),
          project: basename(getCurrentProjectDir()),
          url: urlStr,
          method: options?.method || 'GET',
          headers: safeHeaders,
          body,
          response: null as any,
          duration: 0,
          isStream,
          mainAgent: isMain,
          agentType,
          subAgentType,
          apiType: detectedApiType || undefined,
          _deltaFormat: undefined,
          _totalMessageCount: undefined,
          _conversationId: undefined,
          _isCheckpoint: undefined,
          _inPlaceReplaceDetected: undefined,
          proxyProfile: undefined,
          proxyUrl: undefined,
          error: undefined,
        };

        dbg('拦截 %s %s apiType=%s agentType=%s subAgentType=%s model=%s stream=%s bodySize=%d',
          options?.method || 'GET', urlStr, detectedApiType ?? '-', agentType, subAgentType ?? '-',
          model, isStream, options?.body ? String(options.body).length : 0);

        // Delta 存储处理
        if (interceptorConfig!.deltaStorageEnabled && isMain && Array.isArray(body?.messages)) {
          const messages = body.messages;
          deltaOriginalMessagesLength = messages.length;
          deltaOriginalTailFp = messages.length > 0 ? fingerprintMsg(messages[messages.length - 1]) : '';
          _mainAgentDeltaCount++;

          // 快照上一请求的状态
          const prevMessagesCount = _lastMessagesCount;
          const prevTailFp = _lastTailFp;

          // Eager update：立即推到本次值
          if (deltaOriginalMessagesLength > 0) {
            _lastMessagesCount = deltaOriginalMessagesLength;
            if (deltaOriginalTailFp !== '') {
              _lastTailFp = deltaOriginalTailFp;
            }
          }

          // In-place replace 检测
          const sameLenInPlaceReplace =
            messages.length === prevMessagesCount &&
            prevMessagesCount > 0 &&
            prevTailFp !== '' &&
            deltaOriginalTailFp !== '' &&
            deltaOriginalTailFp !== prevTailFp;

          // 判断是否需要 checkpoint
          const needsCheckpoint =
            prevMessagesCount === 0 ||
            messages.length < prevMessagesCount ||
            (_mainAgentDeltaCount % interceptorConfig!.checkpointInterval === 0) ||
            sameLenInPlaceReplace;

          if (needsCheckpoint) {
            // Checkpoint：保持完整 messages
            requestEntry._deltaFormat = 1;
            requestEntry._totalMessageCount = messages.length;
            requestEntry._conversationId = 'mainAgent';
            requestEntry._isCheckpoint = true;
            if (sameLenInPlaceReplace) {
              requestEntry._inPlaceReplaceDetected = true;
            }
            dbgDelta('Checkpoint: isCheckpoint=true totalMsgs=%d prevCount=%d inPlaceReplace=%s', messages.length, prevMessagesCount, sameLenInPlaceReplace);
          } else {
            // Delta：只保留新增的 messages
            const delta = messages.slice(prevMessagesCount);
            requestEntry._deltaFormat = 1;
            requestEntry._totalMessageCount = messages.length;
            requestEntry._conversationId = 'mainAgent';
            requestEntry._isCheckpoint = false;
            requestEntry.body.messages = delta;
            dbgDelta('Delta: slicing messages [%d..%d] (%d new)', prevMessagesCount, messages.length, delta.length);
          }
        }

        // 检查日志文件大小并轮转
        if (isMain) {
          checkAndRotateLogFile();
        }

        // 不写入在途请求标记，等响应完成后再写入，避免 ID 重复
        if (!requestEntry) return originalFetch.call(this, url, options);
      }

      // 发起请求
      const response = await originalFetch.call(this, url, options);

      if (requestEntry) {
        const entry = requestEntry; // const alias for closures
        const duration = Date.now() - startTime;
        entry.duration = duration;
        delete (entry as any).inProgress;

        // 检查是否为流式响应
        const isStreamResponse = entry.request?.body?.stream === true;

        // 处理流式响应
        if (isStreamResponse) {
          try {
            entry.response = {
              status: response.status,
              statusText: response.statusText,
              headers: Object.fromEntries(response.headers.entries()),
              body: null,
            };

            // 使用 tee() 分流：一个给客户端，一个用于后台提取
            const [clientBody, logBody] = response.body!.tee();

            // 后台提取（不阻塞客户端）
            extractInBackground(logBody, entry, deltaOriginalMessagesLength, deltaOriginalTailFp);
            dbgSse('SSE 流开始提取: id=%s', entry.id);

            // 直接返回原始流给客户端
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
            writeLogEntry(requestEntry);
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

            writeLogEntry(requestEntry);
            commitDeltaState(deltaOriginalMessagesLength, deltaOriginalTailFp);
          } catch (err) {
            writeLogEntry(requestEntry);
            commitDeltaState(deltaOriginalMessagesLength, deltaOriginalTailFp);
          }
        }
      }

      return response;
    } catch (err) {
      if (requestEntry) {
        requestEntry.duration = Date.now() - startTime;
        requestEntry.error = err instanceof Error ? err.message : String(err);
        writeLogEntry(requestEntry);
      }
      throw err;
    }
  };

  console.log('[AgentProxy Interceptor] Fetch 拦截器已安装');
}

// ==================== 导出 ====================

export function getCurrentLogFile(): string | null {
  return currentLogFile;
}

export function getInterceptorState(): {
  logFile: string | null;
  projectDir: string;
  lastMessagesCount: number;
  mainAgentDeltaCount: number;
} {
  return {
    logFile: currentLogFile,
    projectDir,
    lastMessagesCount: _lastMessagesCount,
    mainAgentDeltaCount: _mainAgentDeltaCount,
  };
}

// 自动执行拦截器设置（如果直接运行此模块）
if (import.meta.url === `file://${process.argv[1]}`) {
  setupInterceptor();
}
