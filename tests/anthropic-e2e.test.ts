/**
 * Anthropic 供应商 E2E 测试
 *
 * 验证预设 anthropic 供应商的完整代理流程:
 * 1. 路由: /anthropic/v1/messages → 正确上游
 * 2. 请求头透传: x-api-key, anthropic-version, content-type
 * 3. 请求体透传: model, messages, max_tokens, stream
 * 4. SSE 流式响应转发 (标准 Anthropic 事件序列)
 * 5. 非流式 JSON 响应转发
 * 6. Tool Use 响应处理
 * 7. 上游错误透传 (400/401/429/500)
 * 8. 无效路径/供应商 → 404
 *
 * 运行: vitest run tests/anthropic-e2e.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { writeFile, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { createTestEnv, cleanTestDir, removeTestDir, writeTestConfig, startBackend, stopBackend, readLatestLog, createMockUpstream, type TestEnv, type MockUpstream, type AnthropicResponseMode } from './e2e-helpers.js';

const execAsync = promisify(exec);

// ==================== 常量 ====================

const testEnv = createTestEnv('anthropic-e2e');
const { configDir: CONFIG_DIR, configPath: CONFIG_PATH, logDir: LOG_DIR, proxyPort: PROXY_PORT, webPort: WEB_PORT } = testEnv;

// ==================== 全局状态 ====================

let mockAnthropic: MockUpstream;

// ==================== 工具函数 ====================

/**
 * 通过代理发送 Anthropic API 请求
 */
async function anthropicRequest(options?: {
  headers?: Record<string, string>;
  body?: unknown;
}): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  const defaultBody = {
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'Hello' }],
  };

  try {
    const res = await fetch(`http://127.0.0.1:${PROXY_PORT}/anthropic/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'sk-ant-e2e-test-key',
        'anthropic-version': '2023-06-01',
        ...options?.headers,
      },
      body: JSON.stringify(options?.body ?? defaultBody),
    });

    const body = await res.text();
    const resHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => { resHeaders[k] = v; });
    return { status: res.status, headers: resHeaders, body };
  } catch (err) {
    return { status: 0, headers: {}, body: String(err) };
  }
}

// ==================== 测试套件 ====================

describe('Anthropic 供应商 E2E 测试', () => {
  beforeAll(async () => {
    // 启动 mock 上游
    mockAnthropic = await createMockUpstream({ name: 'anthropic' });

    // 隔离配置 + 日志
    await cleanTestDir(testEnv);
    await writeTestConfig(testEnv, {
      host: '127.0.0.1',
      proxyPort: PROXY_PORT,
      webPort: WEB_PORT,
      providers: [
        {
          id: 'provider-anthropic-e2e',
          name: 'anthropic',
          endpoints: {
            'anthropic-messages': `http://127.0.0.1:${mockAnthropic.port}`,
            'openai-chat': null,
            'openai-responses': null,
          },
        },
      ],
    });

    // 启动后端
    await startBackend(testEnv);
    await new Promise(resolve => setTimeout(resolve, 2000));
  }, 30000);

  afterAll(async () => {
    await stopBackend();
    await mockAnthropic.close();
    await cleanTestDir(testEnv);
  }, 10000);

  beforeEach(() => {
    mockAnthropic.reset();
    mockAnthropic.setMode('sse-text');
  });

  // ==================== 路由 ====================

  describe('路由', () => {
    it('/anthropic/v1/messages → 命中 anthropic-messages 端点', async () => {
      const res = await anthropicRequest();
      expect(res.status).toBe(200);

      expect(mockAnthropic.requests.length).toBe(1);
      // proxy 去掉了 rest 中的 /v1 前缀，上游收到 /messages
      expect(mockAnthropic.requests[0].url).toBe('/messages');
      expect(mockAnthropic.requests[0].method).toBe('POST');
    });

    it('/anthropic/v1/chat/completions → 404 (不支持 openai-chat)', async () => {
      const res = await fetch(`http://127.0.0.1:${PROXY_PORT}/anthropic/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-4', messages: [] }),
      });
      expect(res.status).toBe(404);
      const body = await res.json() as { error: string };
      expect(body.error).toContain('does not support');
    });

    it('/anthropic/v1/unknown → 404 (不支持路径)', async () => {
      const res = await fetch(`http://127.0.0.1:${PROXY_PORT}/anthropic/v1/unknown`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(404);
      const body = await res.json() as { error: string };
      expect(body.error).toContain('unsupported');
    });

    it('/unknown/v1/messages → 404 (供应商不存在)', async () => {
      const res = await fetch(`http://127.0.0.1:${PROXY_PORT}/unknown/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'test', messages: [] }),
      });
      expect(res.status).toBe(404);
      const body = await res.json() as { error: string };
      expect(body.error).toContain('not found');
    });

    it('裸路径 /v1/messages → 被解析为 provider=v1 → 404', async () => {
      const res = await fetch(`http://127.0.0.1:${PROXY_PORT}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'test', messages: [] }),
      });
      expect(res.status).toBe(404);
      const body = await res.json() as { error: string };
      // /v1/messages 匹配 PATH_REGEX → providerName="v1"，不在配置中
      expect(body.error).toContain('not found');
    });
  });

  // ==================== 请求头透传 ====================

  describe('请求头透传', () => {
    it('x-api-key 原样转发到上游', async () => {
      await anthropicRequest();
      expect(mockAnthropic.requests[0].headers['x-api-key']).toBe('sk-ant-e2e-test-key');
    });

    it('anthropic-version 原样转发到上游', async () => {
      await anthropicRequest();
      expect(mockAnthropic.requests[0].headers['anthropic-version']).toBe('2023-06-01');
    });

    it('content-type 保持 application/json', async () => {
      await anthropicRequest();
      expect(mockAnthropic.requests[0].headers['content-type']).toContain('application/json');
    });

    it('自定义 header 也能透传', async () => {
      await anthropicRequest({
        headers: { 'x-custom-header': 'test-value' },
      });
      expect(mockAnthropic.requests[0].headers['x-custom-header']).toBe('test-value');
    });

    it('内部标记头不应泄露到上游', async () => {
      await anthropicRequest();
      expect(mockAnthropic.requests[0].headers['x-lucent-trace']).toBeUndefined();
      expect(mockAnthropic.requests[0].headers['x-lucent-provider']).toBeUndefined();
      expect(mockAnthropic.requests[0].headers['x-lucent-endpoint']).toBeUndefined();
    });

    it('accept-encoding 被强制为 identity', async () => {
      await anthropicRequest();
      expect(mockAnthropic.requests[0].headers['accept-encoding']).toBe('identity');
    });
  });

  // ==================== 请求体透传 ====================

  describe('请求体透传', () => {
    it('model / messages / max_tokens 原样转发', async () => {
      const body = {
        model: 'claude-opus-4-20250514',
        max_tokens: 2048,
        messages: [
          { role: 'user', content: 'What is 2+2?' },
        ],
      };

      await anthropicRequest({ body });

      const parsed = JSON.parse(mockAnthropic.requests[0].body);
      expect(parsed.model).toBe('claude-opus-4-20250514');
      expect(parsed.max_tokens).toBe(2048);
      expect(parsed.messages).toEqual([{ role: 'user', content: 'What is 2+2?' }]);
    });

    it('stream: true 参数透传', async () => {
      await anthropicRequest({
        body: {
          model: 'claude-sonnet-4-20250514',
          max_tokens: 100,
          stream: true,
          messages: [{ role: 'user', content: 'hi' }],
        },
      });

      const parsed = JSON.parse(mockAnthropic.requests[0].body);
      expect(parsed.stream).toBe(true);
    });

    it('tools 定义透传', async () => {
      const body = {
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'run ls' }],
        tools: [
          {
            name: 'bash',
            description: 'Run a bash command',
            input_schema: {
              type: 'object' as const,
              properties: { command: { type: 'string' as const } },
              required: ['command'],
            },
          },
        ],
      };

      await anthropicRequest({ body });

      const parsed = JSON.parse(mockAnthropic.requests[0].body);
      expect(parsed.tools).toHaveLength(1);
      expect(parsed.tools[0].name).toBe('bash');
    });

    it('system prompt 透传', async () => {
      const body = {
        model: 'claude-sonnet-4-20250514',
        max_tokens: 100,
        system: 'You are a helpful math tutor.',
        messages: [{ role: 'user', content: 'What is 2+2?' }],
      };

      await anthropicRequest({ body });

      const parsed = JSON.parse(mockAnthropic.requests[0].body);
      expect(parsed.system).toBe('You are a helpful math tutor.');
    });

    it('temperature 参数透传', async () => {
      const body = {
        model: 'claude-sonnet-4-20250514',
        max_tokens: 100,
        temperature: 0.5,
        messages: [{ role: 'user', content: 'Hello' }],
      };

      await anthropicRequest({ body });

      const parsed = JSON.parse(mockAnthropic.requests[0].body);
      expect(parsed.temperature).toBe(0.5);
    });

    it('多轮对话 messages 透传', async () => {
      const body = {
        model: 'claude-sonnet-4-20250514',
        max_tokens: 100,
        messages: [
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi there!' },
          { role: 'user', content: 'How are you?' },
        ],
      };

      await anthropicRequest({ body });

      const parsed = JSON.parse(mockAnthropic.requests[0].body);
      expect(parsed.messages).toHaveLength(3);
      expect(parsed.messages[2].content).toBe('How are you?');
    });
  });

  // ==================== SSE 流式响应 ====================

  describe('SSE 流式响应', () => {
    it('标准文本 SSE 流正确转发', async () => {
      mockAnthropic.setMode('sse-text');
      const res = await anthropicRequest();

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/event-stream');
      // SSE 响应应包含完整事件序列
      expect(res.body).toContain('message_start');
      expect(res.body).toContain('content_block_start');
      expect(res.body).toContain('content_block_delta');
      expect(res.body).toContain('content_block_stop');
      expect(res.body).toContain('message_delta');
      expect(res.body).toContain('message_stop');
      // 验证文本内容
      expect(res.body).toContain('Hello!');
      expect(res.body).toContain('How can I help?');
    });

    it('Tool Use SSE 流正确转发', async () => {
      mockAnthropic.setMode('sse-tool-use');
      const res = await anthropicRequest();

      expect(res.status).toBe(200);
      expect(res.body).toContain('tool_use');
      expect(res.body).toContain('bash');
      expect(res.body).toContain('ls -la');
      expect(res.body).toContain('stop_reason');
    });

    it('思考 + 文本 SSE 流正确转发', async () => {
      mockAnthropic.setMode('sse-thinking');
      const res = await anthropicRequest();

      expect(res.status).toBe(200);
      expect(res.body).toContain('thinking_delta');
      expect(res.body).toContain('Let me analyze...');
      expect(res.body).toContain('text_delta');
      expect(res.body).toContain('The answer is 42.');
    });
  });

  // ==================== 非流式 JSON 响应 ====================

  describe('非流式 JSON 响应', () => {
    it('完整 JSON 响应原样返回', async () => {
      mockAnthropic.setMode('json');
      const res = await anthropicRequest({
        body: {
          model: 'claude-sonnet-4-20250514',
          max_tokens: 100,
          stream: false,
          messages: [{ role: 'user', content: 'Hello' }],
        },
      });

      expect(res.status).toBe(200);

      const parsed = JSON.parse(res.body);
      expect(parsed.id).toBe('msg_e2e_json');
      expect(parsed.type).toBe('message');
      expect(parsed.role).toBe('assistant');
      expect(parsed.model).toBe('claude-sonnet-4-20250514');
      expect(parsed.content[0].type).toBe('text');
      expect(parsed.content[0].text).toBe('Hello from JSON response.');
      expect(parsed.stop_reason).toBe('end_turn');
      expect(parsed.usage.input_tokens).toBe(100);
      expect(parsed.usage.output_tokens).toBe(10);
    });

    it('JSON 响应的 content-type 为 application/json', async () => {
      mockAnthropic.setMode('json');
      const res = await anthropicRequest();
      expect(res.headers['content-type']).toContain('application/json');
    });
  });

  // ==================== 上游错误透传 ====================

  describe('上游错误透传', () => {
    it('400 invalid_request_error', async () => {
      mockAnthropic.setMode('error-400');
      const res = await anthropicRequest();

      expect(res.status).toBe(400);
      const parsed = JSON.parse(res.body);
      expect(parsed.type).toBe('error');
      expect(parsed.error.type).toBe('invalid_request_error');
      expect(parsed.error.message).toBeDefined()  // 消息文本是 mock 实现细节;
    });

    it('401 authentication_error', async () => {
      mockAnthropic.setMode('error-401');
      const res = await anthropicRequest();

      expect(res.status).toBe(401);
      const parsed = JSON.parse(res.body);
      expect(parsed.type).toBe('error');
      expect(parsed.error.type).toBe('authentication_error');
    });

    it('429 rate_limit_error', async () => {
      mockAnthropic.setMode('error-429');
      const res = await anthropicRequest();

      expect(res.status).toBe(429);
      const parsed = JSON.parse(res.body);
      expect(parsed.type).toBe('error');
      expect(parsed.error.type).toBe('rate_limit_error');
    });

    it('500 api_error', async () => {
      mockAnthropic.setMode('error-500');
      const res = await anthropicRequest();

      expect(res.status).toBe(500);
      const parsed = JSON.parse(res.body);
      expect(parsed.type).toBe('error');
      expect(parsed.error.type).toBe('api_error');
    });
  });

  // ==================== 日志落盘 ====================

  describe('日志落盘', () => {
    it('请求后日志含 providerName=anthropic + endpointType=anthropic-messages', async () => {
      mockAnthropic.setMode('sse-text');
      await anthropicRequest();

      await new Promise(resolve => setTimeout(resolve, 500));

      const logs = await readLatestLog(LOG_DIR);
      expect(logs).not.toBeNull();
      expect(logs!.length).toBeGreaterThan(0);

      const lastLog = logs![logs!.length - 1] as Record<string, unknown>;
      expect(lastLog.providerName).toBe('anthropic');
      expect(lastLog.endpointType).toBe('anthropic-messages');
    });
  });

  // ==================== /custom/ 前缀兼容 ====================

  describe('/custom/ 前缀兼容', () => {
    it('/custom/anthropic/v1/messages 同样路由成功', async () => {
      const res = await fetch(`http://127.0.0.1:${PROXY_PORT}/custom/anthropic/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'sk-ant-e2e-test-key',
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 100,
          messages: [{ role: 'user', content: 'test' }],
        }),
      });

      expect(res.status).toBe(200);
      expect(mockAnthropic.requests.length).toBe(1);
    });
  });
});
