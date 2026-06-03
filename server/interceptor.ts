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

import { appendFileSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, basename } from 'node:path';

// ==================== 配置 ====================
const INTERCEPTOR_CONFIG = {
  logDir: join(homedir(), '.agentproxy', 'logs'),
  maxLogFileSize: 100 * 1024 * 1024, // 100MB
  deltaStorageEnabled: true, // 增量存储开关
  checkpointInterval: 10, // 每 N 条 mainAgent 请求写一个完整 checkpoint
} as const;

// ==================== 状态 ====================
let currentLogFile: string | null = null;
let projectDir: string = '';
let _lastMessagesCount = 0; // 截至最近一次请求的完整 messages 数量
let _lastTailFp = ''; // 截至最近一次请求的末位 message 指纹
let _mainAgentDeltaCount = 0; // mainAgent 请求计数器

// ==================== 类型定义 ====================
export interface LogEntry {
  id: string;
  timestamp: string;
  project: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  body: any;
  response: {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body: any;
  };
  duration: number;
  isStream: boolean;
  mainAgent: boolean;
  agentType?: 'main' | 'sub';
  subAgentType?: 'plan' | 'search' | 'bash' | 'workflow' | 'unknown';
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

// ==================== 工具函数 ====================

/**
 * 初始化日志目录
 */
function initLogDir(): void {
  if (!existsSync(INTERCEPTOR_CONFIG.logDir)) {
    mkdirSync(INTERCEPTOR_CONFIG.logDir, { recursive: true });
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
  return join(INTERCEPTOR_CONFIG.logDir, `${projectName}_${date}_${time}.jsonl`);
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
  return /\/v1\/messages|\/api\/v1\/messages/.test(url);
}

/**
 * 检查是否为 OpenAI API 路径
 */
function isOpenAIApiPath(url: string): boolean {
  return /\/v1\/(chat\/completions|completions)/.test(url);
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
function parseAgentType(body: any, isMain: boolean): { agentType: 'main' | 'sub'; subAgentType?: string } {
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
    safe['x-api-key'] = k.length > 12 ? `${k.slice(0, 8)}****${k.slice(-4)}` : '****';
  }

  // 脱敏 authorization
  if (safe['authorization']) {
    const v = safe['authorization'];
    const spaceIdx = v.indexOf(' ');
    if (spaceIdx > 0) {
      const scheme = v.slice(0, spaceIdx);
      const token = v.slice(spaceIdx + 1);
      safe['authorization'] = scheme + ' ' + (token.length > 12 ? `${token.slice(0, 8)}****${token.slice(-4)}` : '****');
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
    const line = JSON.stringify(entry) + '\n---\n';
    appendFileSync(currentLogFile!, line);
  } catch (error) {
    console.error('[AgentProxy Interceptor] 写入日志失败:', error);
  }
}

/**
 * 检查并轮转日志文件
 */
function checkAndRotateLogFile(): void {
  if (!currentLogFile) return;

  try {
    const { statSync } = require('node:fs');
    if (!existsSync(currentLogFile) || statSync(currentLogFile).size < INTERCEPTOR_CONFIG.maxLogFileSize) {
      return;
    }

    // 轮转日志文件
    currentLogFile = generateLogFilePath();
    // 重置 delta 状态
    _lastMessagesCount = 0;
    _lastTailFp = '';
    _mainAgentDeltaCount = 0;
  } catch (error) {
    console.error('[AgentProxy Interceptor] 日志轮转失败:', error);
  }
}

/**
 * Delta 存储：completed 写入成功后更新状态
 */
function commitDeltaState(originalLength: number, originalTailFp: string): void {
  if (INTERCEPTOR_CONFIG.deltaStorageEnabled && originalLength > 0 && originalLength > _lastMessagesCount) {
    _lastMessagesCount = originalLength;
    if (typeof originalTailFp === 'string') {
      _lastTailFp = originalTailFp;
    }
  }
}

// ==================== 流式响应处理 ====================

/**
 * 从 Anthropic/OpenAI SSE 事件流组装完整消息
 *
 * 支持 Anthropic 事件类型：
 * - message_start: 初始消息对象
 * - content_block_start: 新内容块（text / tool_use）
 * - content_block_delta: 增量内容（text_delta / input_json_delta / thinking_delta）
 * - content_block_stop: 内容块结束
 * - message_delta: stop_reason 和 usage
 * - message_stop: 消息结束
 *
 * 同时兼容 OpenAI 格式：
 * - 含 choices[0].delta 的 chunk
 */
function assembleStreamMessage(events: any[]): any {
  if (!events || events.length === 0) {
    return null;
  }

  const messageStart = events.find((e: any) => e.type === 'message_start');
  const messageDeltaEvent = events.find((e: any) => e.type === 'message_delta');

  // ---- Anthropic 格式 ----
  if (messageStart) {
    const msg: any = {
      id: messageStart.message?.id,
      type: messageStart.message?.type || 'message',
      role: 'assistant',
      model: messageStart.message?.model,
      content: [],
      stop_reason: messageDeltaEvent?.delta?.stop_reason ?? null,
      usage: {
        input_tokens: messageStart.message?.usage?.input_tokens ?? 0,
        output_tokens: messageDeltaEvent?.usage?.output_tokens ?? 0,
        cache_creation_input_tokens: messageStart.message?.usage?.cache_creation_input_tokens ?? 0,
        cache_read_input_tokens: messageStart.message?.usage?.cache_read_input_tokens ?? 0,
      },
    };

    // 按 index 追踪每个 content block
    const blocks = new Map<number, any>();

    for (const event of events) {
      const idx = event.index;

      if (event.type === 'content_block_start' && idx !== undefined) {
        // 初始化内容块
        const block = event.content_block;
        if (block?.type === 'tool_use') {
          blocks.set(idx, { type: 'tool_use', id: block.id, name: block.name, input: '' });
        } else if (block?.type === 'thinking') {
          blocks.set(idx, { type: 'thinking', thinking: '' });
        } else {
          blocks.set(idx, { type: 'text', text: block?.text ?? '' });
        }
      } else if (event.type === 'content_block_delta' && idx !== undefined) {
        const block = blocks.get(idx);
        if (!block) continue;

        const delta = event.delta;
        if (delta?.type === 'text_delta' && delta.text) {
          block.text = (block.text || '') + delta.text;
        } else if (delta?.type === 'input_json_delta' && delta.partial_json) {
          block.input = (block.input || '') + delta.partial_json;
        } else if (delta?.type === 'thinking_delta' && delta.thinking) {
          block.thinking = (block.thinking || '') + delta.thinking;
        }
      }
    }

    // 按 index 排序输出
    for (const [_, block] of [...blocks.entries()].sort(([a], [b]) => a - b)) {
      // tool_use: 尝试解析 JSON input
      if (block.type === 'tool_use' && typeof block.input === 'string') {
        try { block.input = JSON.parse(block.input); } catch { /* 保持字符串 */ }
      }
      msg.content.push(block);
    }

    return msg;
  }

  // ---- OpenAI 格式 ----
  const openaiChunks = events.filter((e: any) => e.choices);
  if (openaiChunks.length > 0) {
    const first = openaiChunks[0];
    let text = '';
    let toolCalls: any[] = [];

    for (const chunk of openaiChunks) {
      const delta = chunk.choices?.[0]?.delta;
      if (delta?.content) text += delta.content;
      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          if (tc.index !== undefined) {
            if (!toolCalls[tc.index]) {
              toolCalls[tc.index] = { id: tc.id, type: 'function', function: { name: '', arguments: '' } };
            }
            if (tc.function?.name) toolCalls[tc.index].function.name += tc.function.name;
            if (tc.function?.arguments) toolCalls[tc.index].function.arguments += tc.function.arguments;
          }
        }
      }
    }

    const content: any[] = text ? [{ type: 'text', text }] : [];
    for (const tc of toolCalls) {
      if (tc) content.push(tc);
    }

    return {
      id: first.id,
      type: 'message',
      role: 'assistant',
      model: first.model,
      content,
      stop_reason: openaiChunks[openaiChunks.length - 1]?.choices?.[0]?.finish_reason ?? null,
      usage: first.usage || {},
    };
  }

  // 未知格式，返回原始事件
  return { events };
}

/**
 * 创建流式组装器（用于实时推送）
 */
function createStreamAssembler() {
  let events: any[] = [];
  let assembledMessage: any = null;

  return {
    feed(event: any) {
      events.push(event);
      assembledMessage = assembleStreamMessage(events);
    },
    hasMessage(): boolean {
      return assembledMessage !== null;
    },
    snapshot(): any {
      return assembledMessage || { events };
    },
    reset() {
      events = [];
      assembledMessage = null;
    },
  };
}

// ==================== 拦截器设置 ====================

let interceptorInstalled = false;

export function setupInterceptor(): void {
  // 避免重复拦截
  if (interceptorInstalled) {
    return;
  }
  interceptorInstalled = true;

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
        (options.headers as any)['x-agentproxy-internal'] ||
        (options.headers as any)['x-cc-viewer-internal']
      );

      const headers = options?.headers || {};
      const isProxyTrace = headers['x-agentproxy-trace'] === 'true' || headers['x-agentproxy-trace'] === true;

      const shouldIntercept = !isInternalRequest && (
        isProxyTrace ||
        urlStr.includes('anthropic') ||
        urlStr.includes('claude') ||
        urlStr.includes('openai') ||
        isAnthropicApiPath(urlStr) ||
        isOpenAIApiPath(urlStr)
      );

      if (shouldIntercept) {
        // 清理代理标记 header
        if (isProxyTrace && options?.headers) {
          delete (options.headers as any)['x-agentproxy-trace'];
        }

        // 解析请求体
        let body: any = null;
        if (options?.body) {
          try {
            body = JSON.parse(options.body as string);
          } catch {
            body = String(options.body).slice(0, 500);
          }
        }

        // 转换 headers
        let reqHeaders: Record<string, string> = {};
        const rawHeaders = options?.headers;
        if (rawHeaders) {
          if (rawHeaders instanceof Headers) {
            reqHeaders = Object.fromEntries(rawHeaders.entries());
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
        const provider = urlStr.includes('anthropic') || urlStr.includes('claude') ? 'claude' :
                       urlStr.includes('openai') ? 'openai' : 'unknown';

        requestEntry = {
          id: requestId,
          timestamp: new Date().toISOString(),
          project: basename(getCurrentProjectDir()),
          request: {
            method: options?.method || 'GET',
            url: urlStr,
            headers: safeHeaders,
            body,
          },
          response: null as any,
          agentType,
          subAgentType,
          duration: 0,
          metadata: {
            model,
            provider,
            stream: isStream,
          },
        };

        // Delta 存储处理
        if (INTERCEPTOR_CONFIG.deltaStorageEnabled && isMain && Array.isArray(body?.messages)) {
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
            (_mainAgentDeltaCount % INTERCEPTOR_CONFIG.checkpointInterval === 0) ||
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
          } else {
            // Delta：只保留新增的 messages
            const delta = messages.slice(prevMessagesCount);
            requestEntry._deltaFormat = 1;
            requestEntry._totalMessageCount = messages.length;
            requestEntry._conversationId = 'mainAgent';
            requestEntry._isCheckpoint = false;
            requestEntry.body.messages = delta;
          }
        }

        // 检查日志文件大小并轮转
        if (isMain) {
          checkAndRotateLogFile();
        }

        // 写入在途请求标记
        requestEntry.inProgress = true;
        writeLogEntry({ ...requestEntry } as LogEntry);
      }

      // 发起请求
      const response = await originalFetch.call(this, url, options);

      if (requestEntry) {
        const duration = Date.now() - startTime;
        requestEntry.duration = duration;
        delete (requestEntry as any).inProgress;

        // 检查是否为流式响应
        const isStreamResponse = requestEntry.request.body?.stream === true;

        // 处理流式响应
        if (isStreamResponse) {
          try {
            requestEntry.response = {
              status: response.status,
              statusText: response.statusText,
              headers: Object.fromEntries(response.headers.entries()),
              body: { events: [] },
            };

            const originalBody = response.body;
            const reader = originalBody.getReader();
            const decoder = new TextDecoder();
            let streamedChunks: string[] = [];
            let streamedContentLen = 0;

            const stream = new ReadableStream({
              async start(controller) {
                try {
                  while (true) {
                    const { done, value } = await reader.read();
                    if (done) {
                      // 流结束，组装完整消息
                      const tail = decoder.decode();
                      if (tail) {
                        streamedChunks.push(tail);
                        streamedContentLen += tail.length;
                      }

                      const fullContent = streamedChunks.join('');

                      try {
                        // 解析 SSE 事件
                        const events = fullContent
                          .split(/\r?\n\r?\n/)
                          .filter((block) => block.trim())
                          .map((block) => {
                            const lines = block.split(/\r?\n/);
                            const dataLine = lines.find((l) => l.startsWith('data:'));
                            if (dataLine) {
                              const jsonStr = dataLine.startsWith('data: ')
                                ? dataLine.substring(6)
                                : dataLine.substring(5);
                              try {
                                return JSON.parse(jsonStr);
                              } catch {
                                return jsonStr;
                              }
                            }
                            return null;
                          })
                          .filter(Boolean);

                        // 组装完整消息
                        const assembledMessage = assembleStreamMessage(events);
                        requestEntry.response.body = assembledMessage || fullContent;

                        writeLogEntry(requestEntry);
                        commitDeltaState(deltaOriginalMessagesLength, deltaOriginalTailFp);

                        // 释放内存
                        streamedChunks = [];
                        streamedContentLen = 0;
                        requestEntry.response = null;
                      } catch (err) {
                        requestEntry.response.body = fullContent.slice(0, 1000);
                        writeLogEntry(requestEntry);
                        commitDeltaState(deltaOriginalMessagesLength, deltaOriginalTailFp);
                        streamedChunks = [];
                        requestEntry.response = null;
                      }

                      controller.close();
                      break;
                    }

                    const chunk = decoder.decode(value, { stream: true });
                    streamedChunks.push(chunk);
                    streamedContentLen += chunk.length;
                    controller.enqueue(value);
                  }
                } catch (err) {
                  controller.error(err);
                }
              },
            });

            return new Response(stream, {
              status: response.status,
              statusText: response.statusText,
              headers: response.headers,
            });
          } catch (err) {
            requestEntry.response = {
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
              responseData = responseText.slice(0, 1000);
            }

            requestEntry.response = {
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
