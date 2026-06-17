/**
 * E2E 测试共享基础设施
 *
 * 提供后端启动/停止、临时目录管理、端口分配等共享工具
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ==================== 测试目录管理 ====================

export interface TestEnv {
  configDir: string;
  logDir: string;
  configPath: string;
  proxyPort: number;
  webPort: number;
}

/**
 * 创建隔离的测试环境（临时目录 + 随机端口）
 */
export function createTestEnv(prefix: string): TestEnv {
  const id = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const configDir = join(tmpdir(), `lucent-test-${id}`);
  const logDir = join(configDir, 'logs');
  const configPath = join(configDir, 'config.json');
  // 随机端口：30000-60000 范围内
  const proxyPort = 30000 + Math.floor(Math.random() * 30000);
  const webPort = proxyPort + 1;

  return { configDir, logDir, configPath, proxyPort, webPort };
}

/**
 * 清理并重建测试目录
 */
export async function cleanTestDir(env: TestEnv): Promise<void> {
  if (existsSync(env.configDir)) {
    await rm(env.configDir, { recursive: true, force: true });
  }
  await mkdir(env.configDir, { recursive: true });
  await mkdir(env.logDir, { recursive: true });
}

/**
 * 删除测试目录
 */
export async function removeTestDir(env: TestEnv): Promise<void> {
  if (existsSync(env.configDir)) {
    await rm(env.configDir, { recursive: true, force: true });
  }
}

/**
 * 写入测试配置文件
 */
export async function writeTestConfig(env: TestEnv, config: Record<string, unknown>): Promise<void> {
  await writeFile(env.configPath, JSON.stringify(config, null, 2));
}

// ==================== 后端进程管理 ====================

let backendProcess: ChildProcess | null = null;

/**
 * 启动后端服务
 */
export async function startBackend(env: TestEnv): Promise<void> {
  // 杀掉残留进程
  if (backendProcess) {
    backendProcess.kill('SIGTERM');
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  return new Promise<void>((resolve, reject) => {
    const proc = spawn('npx', ['tsx', 'server/index.ts'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        LUCENT_CONFIG_DIR: env.configDir,
        LUCENT_HOST: '127.0.0.1',
        LUCENT_PROXY_PORT: String(env.proxyPort),
        LUCENT_WEB_PORT: String(env.webPort),
        LUCENT_LOG_DIR: env.logDir,
      },
    });

    let output = '';
    proc.stderr?.on('data', (data) => { output += data.toString(); });

    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error(`Server startup timeout. Output: ${output}`));
    }, 20000);

    proc.stdout?.on('data', (data) => {
      output += data.toString();
      if (output.includes('Lucent') || output.includes('代理')) {
        clearTimeout(timeout);
        backendProcess = proc;
        resolve();
      }
    });

    proc.on('error', (err) => { clearTimeout(timeout); reject(err); });
    proc.on('exit', (code) => {
      if (code && code !== 0) { clearTimeout(timeout); reject(new Error(`Server exited: ${code}`)); }
    });
  });
}

/**
 * 停止后端服务
 */
export async function stopBackend(): Promise<void> {
  if (backendProcess) {
    backendProcess.kill('SIGTERM');
    await new Promise(resolve => setTimeout(resolve, 500));
    backendProcess = null;
  }
}

// ==================== 日志读取 ====================

/**
 * 读取最新的 JSONL 日志文件
 */
export async function readLatestLog(logDir: string): Promise<Array<Record<string, unknown>> | null> {
  const files = await readdir(logDir);
  const jsonlFiles = files.filter(f => f.endsWith('.jsonl')).sort().reverse();
  if (jsonlFiles.length === 0) return null;

  const content = await readFile(join(logDir, jsonlFiles[0]), 'utf-8');
  return content.split(/\n---\n?/).filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { return {}; }
  });
}

// ==================== Mock 上游服务器 ====================

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';

/** mock 上游记录的单条请求 */
export interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

/** mock 上游响应模式（Anthropic 格式） */
export type AnthropicResponseMode =
  | 'sse-text'          // 标准文本 SSE 流
  | 'sse-tool-use'      // Tool Use SSE 流
  | 'sse-thinking'      // 思考 + 文本 SSE 流
  | 'json'              // 非流式 JSON 响应
  | 'error-400'
  | 'error-401'
  | 'error-429'
  | 'error-500';

/** mock 上游响应模式（OpenAI 格式） */
export type OpenAIResponseMode =
  | 'chat-sse'           // chat.completion.chunk SSE 流
  | 'chat-json'          // 非流式 chat.completion
  | 'chat-tool-calls'    // 带 tool_calls 的 SSE 流
  | 'responses-sse'      // Responses API SSE 流
  | 'responses-json'     // 非流式 Responses
  | 'error-400'
  | 'error-401'
  | 'error-429'
  | 'error-500';

/** mock 上游响应格式 */
export type MockFormat = 'anthropic' | 'openai';

/** Mock 上游实例 */
export interface MockUpstream {
  /** 实际监听端口（listen 0 随机分配，写 config 时用） */
  port: number;
  /** 已收到的请求列表 */
  requests: CapturedRequest[];
  /** 清空已记录的请求（替代 beforeEach 手动 length=0） */
  reset(): void;
  /** 切换响应模式（Anthropic: sse-text 等；OpenAI: chat-sse 等） */
  setMode(mode: AnthropicResponseMode | OpenAIResponseMode): void;
  /** 关闭并释放端口 */
  close(): Promise<void>;
}

/**
 * 创建并启动一个 mock 上游服务器
 *
 * 所有 e2e 测试的统一上游：记录请求 + 按模式返回响应。
 * - format: 'anthropic'（默认）→ MockResponseMode 见 AnthropicResponseMode
 * - format: 'openai'            → MockResponseMode 见 OpenAIResponseMode
 *
 * @param opts.name   仅调试标识，不影响行为
 * @param opts.format 响应格式，默认 'anthropic'
 */
export async function createMockUpstream(opts?: { name?: string; format?: MockFormat }): Promise<MockUpstream> {
  const requests: CapturedRequest[] = [];
  const format: MockFormat = opts?.format ?? 'anthropic';
  let mode: AnthropicResponseMode | OpenAIResponseMode = format === 'openai' ? 'chat-sse' : 'sse-text';

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString();

    requests.push({
      url: req.url || '/',
      method: req.method || 'GET',
      headers: req.headers as Record<string, string>,
      body,
    });

    if (format === 'openai') {
      switch (mode as OpenAIResponseMode) {
        case 'chat-sse':          respondSSE(res, openaiChatSSEEvents()); break;
        case 'chat-json':         respondJSON(res, 200, openaiChatJsonBody()); break;
        case 'chat-tool-calls':   respondSSE(res, openaiChatToolCallsSSEEvents()); break;
        case 'responses-sse':     respondSSE(res, openaiResponsesSSEEvents()); break;
        case 'responses-json':    respondJSON(res, 200, openaiResponsesJsonBody()); break;
        case 'error-400':         respondJSON(res, 400, openaiErrorByStatus(400, 'invalid_request_error', 'Invalid model')); break;
        case 'error-401':         respondJSON(res, 401, openaiErrorByStatus(401, 'invalid_api_key', 'Incorrect API key')); break;
        case 'error-429':         respondJSON(res, 429, openaiErrorByStatus(429, 'rate_limit_exceeded', 'Rate limit exceeded')); break;
        case 'error-500':         respondJSON(res, 500, openaiErrorByStatus(500, 'server_error', 'Internal server error')); break;
      }
    } else {
      switch (mode as AnthropicResponseMode) {
        case 'sse-text':       respondSSE(res, anthropicTextSSEEvents()); break;
        case 'sse-tool-use':   respondSSE(res, anthropicToolUseSSEEvents()); break;
        case 'sse-thinking':   respondSSE(res, anthropicThinkingSSEEvents()); break;
        case 'json':           respondJSON(res, 200, anthropicJsonResponse()); break;
        case 'error-400':      respondJSON(res, 400, anthropicErrorBody('invalid_request_error', 'mock 400')); break;
        case 'error-401':      respondJSON(res, 401, anthropicErrorBody('authentication_error', 'mock 401')); break;
        case 'error-429':      respondJSON(res, 429, anthropicErrorBody('rate_limit_error', 'mock 429')); break;
        case 'error-500':      respondJSON(res, 500, anthropicErrorBody('api_error', 'mock 500')); break;
      }
    }
  };

  const server: Server = createServer(handler);

  const port: number = await new Promise<number>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object' && 'port' in addr) resolve(addr.port);
      else reject(new Error('Failed to get mock upstream port'));
    });
    server.on('error', reject);
  });

  return {
    port,
    requests,
    reset() { requests.length = 0; },
    setMode(m: AnthropicResponseMode | OpenAIResponseMode) { mode = m; },
    close() {
      return new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

// ==================== Anthropic SSE 响应 fixture ====================
// 从原 anthropic-e2e.test.ts 迁移，供所有 e2e 复用。
// 这些是 Anthropic Messages 协议的标准 SSE 事件序列。

function respondSSE(res: ServerResponse, events: string[]): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    'connection': 'keep-alive',
  });
  let i = 0;
  const interval = setInterval(() => {
    if (i < events.length) {
      res.write(events[i]);
      i++;
    } else {
      clearInterval(interval);
      res.end();
    }
  }, 10);
}

function respondJSON(res: ServerResponse, status: number, body: object): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(data),
  });
  res.end(data);
}

/** 标准 Anthropic 文本 SSE 事件序列 */
/** 完整 schema 按 docs/protocols/01-anthropic-messages.md: message_start 含 cache + service_tier + inference_geo */
function anthropicTextSSEEvents(): string[] {
  return [
    'event: message_start\ndata: ' + JSON.stringify({
      type: 'message_start',
      message: {
        id: 'msg_e2e_test', type: 'message', role: 'assistant',
        model: 'claude-sonnet-4-20250514', content: [],
        stop_reason: null, stop_sequence: null,
        usage: {
          input_tokens: 258, output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
          output_tokens_details: { thinking_tokens: 0 },
          server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 },
          service_tier: 'standard',
          inference_geo: 'us-east-1',
        },
      },
    }) + '\n\n',
    'event: content_block_start\ndata: ' + JSON.stringify({
      type: 'content_block_start', index: 0,
      content_block: { type: 'text', text: '' },
    }) + '\n\n',
    'event: content_block_delta\ndata: ' + JSON.stringify({
      type: 'content_block_delta', index: 0,
      delta: { type: 'text_delta', text: 'Hello! ' },
    }) + '\n\n',
    'event: content_block_delta\ndata: ' + JSON.stringify({
      type: 'content_block_delta', index: 0,
      delta: { type: 'text_delta', text: 'How can I help?' },
    }) + '\n\n',
    'event: content_block_stop\ndata: ' + JSON.stringify({
      type: 'content_block_stop', index: 0,
    }) + '\n\n',
    'event: message_delta\ndata: ' + JSON.stringify({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 15 },
    }) + '\n\n',
    'event: message_stop\ndata: ' + JSON.stringify({
      type: 'message_stop',
    }) + '\n\n',
  ];
}

/** Tool Use SSE 事件序列 */
function anthropicToolUseSSEEvents(): string[] {
  return [
    'event: message_start\ndata: ' + JSON.stringify({
      type: 'message_start',
      message: {
        id: 'msg_e2e_tool', type: 'message', role: 'assistant',
        model: 'claude-sonnet-4-20250514', content: [],
        stop_reason: null, stop_sequence: null,
        usage: {
          input_tokens: 400, output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
          output_tokens_details: { thinking_tokens: 0 },
          server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 },
          service_tier: 'standard',
          inference_geo: 'us-east-1',
        },
      },
    }) + '\n\n',
    'event: content_block_start\ndata: ' + JSON.stringify({
      type: 'content_block_start', index: 0,
      content_block: { type: 'tool_use', id: 'toolu_e2e_01', name: 'bash' },
    }) + '\n\n',
    'event: content_block_delta\ndata: ' + JSON.stringify({
      type: 'content_block_delta', index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"command":"ls -la"}' },
    }) + '\n\n',
    'event: content_block_stop\ndata: ' + JSON.stringify({
      type: 'content_block_stop', index: 0,
    }) + '\n\n',
    'event: message_delta\ndata: ' + JSON.stringify({
      type: 'message_delta',
      delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage: { output_tokens: 45 },
    }) + '\n\n',
    'event: message_stop\ndata: ' + JSON.stringify({
      type: 'message_stop',
    }) + '\n\n',
  ];
}

/** 思考 + 文本 SSE 事件序列 */
function anthropicThinkingSSEEvents(): string[] {
  return [
    'event: message_start\ndata: ' + JSON.stringify({
      type: 'message_start',
      message: {
        id: 'msg_e2e_think', type: 'message', role: 'assistant',
        model: 'claude-sonnet-4-20250514', content: [],
        stop_reason: null, stop_sequence: null,
        usage: {
          input_tokens: 300, output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
          output_tokens_details: { thinking_tokens: 0 },
          server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 },
          service_tier: 'standard',
          inference_geo: 'us-east-1',
        },
      },
    }) + '\n\n',
    'event: content_block_start\ndata: ' + JSON.stringify({
      type: 'content_block_start', index: 0,
      content_block: { type: 'thinking', thinking: '', signature: '' },
    }) + '\n\n',
    'event: content_block_delta\ndata: ' + JSON.stringify({
      type: 'content_block_delta', index: 0,
      delta: { type: 'thinking_delta', thinking: 'Let me analyze...' },
    }) + '\n\n',
    'event: content_block_delta\ndata: ' + JSON.stringify({
      type: 'content_block_delta', index: 0,
      delta: { type: 'signature_delta', signature: 'WaUjzwoIxt7DT4F4...' },
    }) + '\n\n',
    'event: content_block_stop\ndata: ' + JSON.stringify({
      type: 'content_block_stop', index: 0,
    }) + '\n\n',
    'event: content_block_start\ndata: ' + JSON.stringify({
      type: 'content_block_start', index: 1,
      content_block: { type: 'text', text: '' },
    }) + '\n\n',
    'event: content_block_delta\ndata: ' + JSON.stringify({
      type: 'content_block_delta', index: 1,
      delta: { type: 'text_delta', text: 'The answer is 42.' },
    }) + '\n\n',
    'event: content_block_stop\ndata: ' + JSON.stringify({
      type: 'content_block_stop', index: 1,
    }) + '\n\n',
    'event: message_delta\ndata: ' + JSON.stringify({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 60 },
    }) + '\n\n',
    'event: message_stop\ndata: ' + JSON.stringify({
      type: 'message_stop',
    }) + '\n\n',
  ];
}

/** 非流式 JSON 响应体 */
function anthropicJsonResponse(): object {
  return {
    id: 'msg_e2e_json', type: 'message', role: 'assistant',
    model: 'claude-sonnet-4-20250514',
    content: [{ type: 'text', text: 'Hello from JSON response.' }],
    stop_reason: 'end_turn', stop_sequence: null,
    container: null,
    stop_details: null,
    usage: {
      input_tokens: 100, output_tokens: 10,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
      output_tokens_details: { thinking_tokens: 0 },
      server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 },
      service_tier: 'standard',
      inference_geo: 'us-east-1',
    },
  };
}

/** Anthropic 标准错误响应 */
/** request_id 格式: req_ + 24 字符 base62 (官方示例 req_011CSHoEeqs5C35K2UUqR7Fy), per docs § 4 */
function anthropicErrorBody(errorType: string, message: string, requestId?: string): object {
  return {
    type: 'error',
    error: { type: errorType, message },
    request_id: requestId ?? ('req_' + Array.from({ length: 24 }, () =>
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 62)]
    ).join('')),
  };
}

// ==================== OpenAI 响应 fixture ====================
// 从原 providers-e2e.test.ts 迁移，覆盖 chat completions + responses 两套协议。

/** chat.completion.chunk SSE 流 */
function openaiChatSSEEvents(): string[] {
  return [
    'data: ' + JSON.stringify({
      id: 'chatcmpl-e2e', object: 'chat.completion.chunk', model: 'gpt-4o',
      choices: [{ index: 0, delta: { role: 'assistant', content: '' } }],
    }) + '\n\n',
    'data: ' + JSON.stringify({
      id: 'chatcmpl-e2e', object: 'chat.completion.chunk', model: 'gpt-4o',
      choices: [{ index: 0, delta: { content: 'Hello! ' } }],
    }) + '\n\n',
    'data: ' + JSON.stringify({
      id: 'chatcmpl-e2e', object: 'chat.completion.chunk', model: 'gpt-4o',
      choices: [{ index: 0, delta: { content: 'How can I help?' } }],
    }) + '\n\n',
    'data: ' + JSON.stringify({
      id: 'chatcmpl-e2e', object: 'chat.completion.chunk', model: 'gpt-4o',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 10, completion_tokens: 8, total_tokens: 18,
        prompt_tokens_details: { cached_tokens: 0, audio_tokens: 0 },
        completion_tokens_details: { reasoning_tokens: 0, audio_tokens: 0 },
      },
      service_tier: 'default',
    }) + '\n\n',
    'data: [DONE]\n\n',
  ];
}

/** 带 tool_calls 的 chat.completion.chunk SSE 流 */
function openaiChatToolCallsSSEEvents(): string[] {
  return [
    'data: ' + JSON.stringify({
      id: 'chatcmpl-e2e-tool', object: 'chat.completion.chunk', model: 'gpt-4o',
      choices: [{ index: 0, delta: { role: 'assistant', content: null, tool_calls: [{ index: 0, id: 'call_e2e_1', type: 'function', function: { name: 'get_weather', arguments: '' } }] } }],
    }) + '\n\n',
    'data: ' + JSON.stringify({
      id: 'chatcmpl-e2e-tool', object: 'chat.completion.chunk', model: 'gpt-4o',
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"location":"Tokyo"}' } }] } }],
    }) + '\n\n',
    'data: ' + JSON.stringify({
      id: 'chatcmpl-e2e-tool', object: 'chat.completion.chunk', model: 'gpt-4o',
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      usage: {
        prompt_tokens: 50, completion_tokens: 20, total_tokens: 70,
        prompt_tokens_details: { cached_tokens: 0, audio_tokens: 0 },
        completion_tokens_details: { reasoning_tokens: 0, audio_tokens: 0 },
      },
      service_tier: 'default',
    }) + '\n\n',
    'data: [DONE]\n\n',
  ];
}

/** 非流式 chat.completion JSON */
/** 完整 schema 按 docs/protocols/02-openai-chat-completions.md */
function openaiChatJsonBody(): object {
  return {
    id: 'chatcmpl-e2e-json', object: 'chat.completion', model: 'gpt-4o',
    service_tier: 'default',
    system_fingerprint: 'fp_e2e',
    choices: [{ index: 0, message: { role: 'assistant', content: 'Hello from JSON.', refusal: null }, finish_reason: 'stop', logprobs: null }],
    usage: {
      prompt_tokens: 10, completion_tokens: 5, total_tokens: 15,
      prompt_tokens_details: { cached_tokens: 0, audio_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 0, audio_tokens: 0 },
    },
  };
}

/** Responses API 完整事件链 (按 docs/protocols/03-openai-responses.md) */
/** 事件顺序: response.created → output_item.added → content_part.added → output_text.delta × 多 → text.done → content_part.done → output_item.done → response.completed (8 个事件) */
/** response.created/completed 的 response 子对象必须是完整 Response schema (per doc § 2 + § 3 SDK: ResponseCreatedEvent.response / ResponseCompletedEvent.response 均为完整 Response) */
function openaiResponsesSSEEvents(): string[] {
  const createdResponse = openaiResponsesResponseObject('resp-e2e', 'in_progress', [], null);
  const completedResponse = openaiResponsesResponseObject(
    'resp-e2e', 'completed',
    [{ id: 'msg_e2e', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Hello! World.', annotations: [] }] }],
    1700000005,
  );
  return [
    'event: response.created\ndata: ' + JSON.stringify({
      type: 'response.created', sequence_number: 0,
      response: createdResponse,
    }) + '\n\n',
    'event: response.output_item.added\ndata: ' + JSON.stringify({
      type: 'response.output_item.added', output_index: 0, sequence_number: 1,
      item: { id: 'msg_e2e', type: 'message', role: 'assistant', status: 'in_progress', content: [] },
    }) + '\n\n',
    'event: response.content_part.added\ndata: ' + JSON.stringify({
      type: 'response.content_part.added', content_index: 0, item_id: 'msg_e2e', output_index: 0, sequence_number: 2,
      part: { type: 'output_text', text: '', annotations: [] },
    }) + '\n\n',
    'event: response.output_text.delta\ndata: ' + JSON.stringify({
      type: 'response.output_text.delta', content_index: 0, delta: 'Hello!', item_id: 'msg_e2e', output_index: 0, sequence_number: 3, logprobs: [],
    }) + '\n\n',
    'event: response.output_text.delta\ndata: ' + JSON.stringify({
      type: 'response.output_text.delta', content_index: 0, delta: ' World.', item_id: 'msg_e2e', output_index: 0, sequence_number: 4, logprobs: [],
    }) + '\n\n',
    'event: response.output_text.done\ndata: ' + JSON.stringify({
      type: 'response.output_text.done', content_index: 0, text: 'Hello! World.', item_id: 'msg_e2e', output_index: 0, sequence_number: 5, logprobs: [],
    }) + '\n\n',
    'event: response.content_part.done\ndata: ' + JSON.stringify({
      type: 'response.content_part.done', content_index: 0, item_id: 'msg_e2e', output_index: 0, sequence_number: 6,
      part: { type: 'output_text', text: 'Hello! World.', annotations: [] },
    }) + '\n\n',
    'event: response.output_item.done\ndata: ' + JSON.stringify({
      type: 'response.output_item.done', output_index: 0, sequence_number: 7,
      item: { id: 'msg_e2e', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Hello! World.', annotations: [] }] },
    }) + '\n\n',
    'event: response.completed\ndata: ' + JSON.stringify({
      type: 'response.completed', sequence_number: 8,
      response: completedResponse,
    }) + '\n\n',
  ];
}

/**
 * 构造完整 Response 对象 (doc § 2 schema)
 * - created (in_progress): completed_at = null, output = []
 * - completed: completed_at 有值, output 填充, output_text 合并
 */
function openaiResponsesResponseObject(id: string, status: string, output: object[], completedAt: number | null): object {
  const outputText = output
    .flatMap((item: any) => (item.content || [])
      .filter((c: any) => c.type === 'output_text')
      .map((c: any) => c.text))
    .join('');
  return {
    id, object: 'response', status, model: 'gpt-4o',
    created_at: 1700000000,
    completed_at: completedAt,
    parallel_tool_calls: true, temperature: 1, top_p: 1, tools: [],
    instructions: null, max_output_tokens: null, metadata: null, store: false, background: false,
    output_text: outputText || '',
    output,
    previous_response_id: null, prompt: null, reasoning: null,
    text: null, tool_choice: 'auto', truncation: 'disabled',
    prompt_cache_key: null, prompt_cache_retention: null,
    safety_identifier: null, service_tier: 'default',
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
    user: null,
    error: null, incomplete_details: null,
    conversation: null,
  };
}

/** 非流式 Responses JSON */
/** 完整 schema 按 docs/protocols/03-openai-responses.md § 2 */
function openaiResponsesJsonBody(): object {
  return {
    id: 'resp-e2e-json', object: 'response', status: 'completed', model: 'gpt-4o',
    created_at: 1700000000, completed_at: 1700000005,
    parallel_tool_calls: true, temperature: 1, top_p: 1, tools: [],
    instructions: null, max_output_tokens: null, metadata: null, store: false, background: false,
    output_text: 'Hello from JSON.',
    output: [{ id: 'msg_e2e', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Hello from JSON.', annotations: [] }] }],
    usage: {
      input_tokens: 10, output_tokens: 5, total_tokens: 15,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
    error: null, incomplete_details: null,
  };
}

/** OpenAI 标准错误响应 */
/** 完整 schema 按 docs/protocols/02-openai-chat-completions.md § 4 ErrorObject */
function openaiErrorBody(code: string, message: string, type?: string): object {
  return { error: { message, type: type ?? 'invalid_request_error', code, param: null } };
}

/** 按 HTTP status 自动映射到正确 type (per docs) */
function openaiErrorByStatus(status: number, code: string, message: string): object {
  const typeByStatus: Record<number, string> = {
    400: 'invalid_request_error',
    401: 'authentication_error',
    403: 'permission_error',
    404: 'not_found_error',
    413: 'request_too_large',
    429: 'rate_limit_error',
    500: 'api_error',
    529: 'overloaded_error',
  };
  return openaiErrorBody(code, message, typeByStatus[status] ?? 'invalid_request_error');
}
