/**
 * 多供应商 E2E 测试
 *
 * 覆盖除 anthropic 外所有预设供应商的完整路由验证:
 * 1. OpenAI: openai-chat + openai-responses 完整流程 (SSE/JSON/错误/Tool Calls)
 * 2. 其余预设供应商: 参数化路由 + header 透传
 * 3. 多协议供应商: 同一供应商不同端点路由
 * 4. 日志落盘: providerName + endpointType
 *
 * 运行: vitest run tests/providers-e2e.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { join } from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { createTestEnv, cleanTestDir, writeTestConfig, startBackend, stopBackend, readLatestLog, createMockUpstream, type TestEnv, type MockUpstream } from './e2e-helpers.js';

const execAsync = promisify(exec);

// ==================== 常量 ====================

const testEnv = createTestEnv('providers-e2e');
const { configDir: CONFIG_DIR, configPath: CONFIG_PATH, logDir: LOG_DIR, proxyPort: PROXY_PORT, webPort: WEB_PORT } = testEnv;

/** 仅支持 openai-chat 的预设供应商 */
const CHAT_ONLY_PROVIDERS = [
  'deepseek', 'gemini', 'groq', 'mistral', 'xai',
  'together', 'fireworks', 'perplexity', 'cohere',
  'zhipu', 'moonshot', 'qwen', 'baichuan', 'minimax',
  'spark', 'doubao', 'stepfun', 'siliconcloud', 'openrouter',
  'cerebras', 'deepinfra', 'novita', 'sambanova', 'nvidia',
] as const;

// ==================== 全局状态 ====================

let mockServer: MockUpstream;

// ==================== 工具函数 ====================

async function proxyFetch(
  providerName: string,
  path: string,
  options?: { headers?: Record<string, string>; body?: unknown },
): Promise<{ status: number; body: string }> {
  const defaultBody = {
    model: 'gpt-4o',
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'Hello' }],
  };
  try {
    const res = await fetch(`http://127.0.0.1:${PROXY_PORT}/${providerName}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer sk-e2e-test-key',
        ...options?.headers,
      },
      body: JSON.stringify(options?.body ?? defaultBody),
    });
    return { status: res.status, body: await res.text() };
  } catch (err) {
    return { status: 0, body: String(err) };
  }
}

// ==================== 测试套件 ====================

describe('多供应商 E2E 测试', () => {
  beforeAll(async () => {
    mockServer = await createMockUpstream({ name: 'openai', format: 'openai' });
    await cleanTestDir(testEnv);
    const openaiBase = `http://127.0.0.1:${mockServer.port}`;
    await writeTestConfig(testEnv, {
      host: '127.0.0.1',
      proxyPort: PROXY_PORT,
      webPort: WEB_PORT,
      providers: [
        {
          id: 'provider-openai-e2e', name: 'openai',
          endpoints: { 'openai-chat': openaiBase, 'openai-responses': openaiBase, 'anthropic-messages': null },
        },
        ...CHAT_ONLY_PROVIDERS.map(name => ({
          id: `provider-${name}-e2e`, name,
          endpoints: { 'openai-chat': openaiBase, 'openai-responses': null, 'anthropic-messages': null },
        })),
      ],
    });
    await startBackend(testEnv);
    await new Promise(r => setTimeout(r, 2000));
  }, 30000);

  afterAll(async () => {
    await stopBackend();
    await mockServer.close();
    await cleanTestDir(testEnv);
  }, 10000);

  beforeEach(() => { mockServer.reset(); mockServer.setMode('chat-sse'); });

  // ==================== OpenAI 完整流程 ====================

  describe('OpenAI', () => {
    describe('Chat Completions 路由', () => {
      it('/openai/v1/chat/completions → 上游收到 /chat/completions', async () => {
        const res = await proxyFetch('openai', '/v1/chat/completions');
        expect(res.status).toBe(200);
        expect(mockServer.requests[0].url).toBe('/chat/completions');
        expect(mockServer.requests[0].method).toBe('POST');
      });

      it('/openai/v1/completions → 同样路由到 openai-chat', async () => {
        const res = await proxyFetch('openai', '/v1/completions');
        expect(res.status).toBe(200);
        expect(mockServer.requests[0].url).toBe('/completions');
      });

      it('Authorization: Bearer 原样透传', async () => {
        await proxyFetch('openai', '/v1/chat/completions');
        expect(mockServer.requests[0].headers['authorization']).toBe('Bearer sk-e2e-test-key');
      });

      it('请求体 model/messages/max_tokens 透传', async () => {
        await proxyFetch('openai', '/v1/chat/completions', {
          body: { model: 'gpt-4o-mini', max_tokens: 50, messages: [{ role: 'user', content: 'test' }] },
        });
        const parsed = JSON.parse(mockServer.requests[0].body);
        expect(parsed.model).toBe('gpt-4o-mini');
        expect(parsed.max_tokens).toBe(50);
        expect(parsed.messages).toEqual([{ role: 'user', content: 'test' }]);
      });

      it('stream: true 参数透传', async () => {
        await proxyFetch('openai', '/v1/chat/completions', {
          body: { model: 'gpt-4o', max_tokens: 100, stream: true, messages: [{ role: 'user', content: 'hi' }] },
        });
        expect(JSON.parse(mockServer.requests[0].body).stream).toBe(true);
      });

      it('tools 参数透传', async () => {
        await proxyFetch('openai', '/v1/chat/completions', {
          body: {
            model: 'gpt-4o', max_tokens: 100,
            messages: [{ role: 'user', content: 'weather?' }],
            tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }],
          },
        });
        const parsed = JSON.parse(mockServer.requests[0].body);
        expect(parsed.tools).toHaveLength(1);
        expect(parsed.tools[0].function.name).toBe('get_weather');
      });

      it('内部标记头不应泄露到上游', async () => {
        await proxyFetch('openai', '/v1/chat/completions');
        expect(mockServer.requests[0].headers['x-lucent-trace']).toBeUndefined();
        expect(mockServer.requests[0].headers['x-lucent-provider']).toBeUndefined();
        expect(mockServer.requests[0].headers['x-lucent-endpoint']).toBeUndefined();
      });

      it('accept-encoding 被强制为 identity', async () => {
        await proxyFetch('openai', '/v1/chat/completions');
        expect(mockServer.requests[0].headers['accept-encoding']).toBe('identity');
      });
    });

    describe('Chat Completions SSE 流', () => {
      it('标准 SSE 文本流转发', async () => {
        mockServer.setMode('chat-sse');
        const res = await proxyFetch('openai', '/v1/chat/completions');
        expect(res.status).toBe(200);
        expect(res.body).toContain('chat.completion.chunk');
        expect(res.body).toContain('Hello!');
        expect(res.body).toContain('[DONE]');
      });

      it('Tool Calls SSE 流转发', async () => {
        mockServer.setMode('chat-tool-calls');
        const res = await proxyFetch('openai', '/v1/chat/completions');
        expect(res.status).toBe(200);
        expect(res.body).toContain('tool_calls');
        expect(res.body).toContain('get_weather');
        expect(res.body).toContain('Tokyo');
        expect(res.body).toContain('"finish_reason":"tool_calls"');
      });
    });

    describe('Chat Completions JSON', () => {
      it('非流式 JSON 原样返回', async () => {
        mockServer.setMode('chat-json');
        const res = await proxyFetch('openai', '/v1/chat/completions', {
          body: { model: 'gpt-4o', max_tokens: 100, stream: false, messages: [{ role: 'user', content: 'hi' }] },
        });
        expect(res.status).toBe(200);
        const parsed = JSON.parse(res.body);
        expect(parsed.object).toBe('chat.completion');
        expect(parsed.id).toBe('chatcmpl-e2e-json');
        expect(parsed.model).toBe('gpt-4o');
        expect(parsed.choices[0].message.role).toBe('assistant');
        expect(parsed.choices[0].message.content).toBe('Hello from JSON.');
        expect(parsed.choices[0].finish_reason).toBe('stop');
        expect(parsed.usage.prompt_tokens).toBe(10);
        expect(parsed.usage.completion_tokens).toBe(5);
        expect(parsed.usage.total_tokens).toBe(15);
      });
    });

    describe('Responses API 路由', () => {
      it('/openai/v1/responses → 上游收到 /responses', async () => {
        mockServer.setMode('responses-sse');
        const res = await proxyFetch('openai', '/v1/responses', {
          body: { model: 'gpt-4o', input: 'Hello' },
        });
        expect(res.status).toBe(200);
        expect(mockServer.requests[0].url).toBe('/responses');
        expect(res.body).toContain('response.output_text.delta');
      });

      it('Responses API input 字段透传', async () => {
        mockServer.setMode('responses-sse');
        await proxyFetch('openai', '/v1/responses', {
          body: { model: 'gpt-4o', input: 'What is 2+2?' },
        });
        const parsed = JSON.parse(mockServer.requests[0].body);
        expect(parsed.input).toBe('What is 2+2?');
      });

      it('Responses SSE 流转发', async () => {
        mockServer.setMode('responses-sse');
        const res = await proxyFetch('openai', '/v1/responses', {
          body: { model: 'gpt-4o', input: 'Hello' },
        });
        expect(res.body).toContain('Hello!');
        expect(res.body).toContain('response.completed');
      });

      it('Responses 非流式 JSON 完整字段', async () => {
        mockServer.setMode('responses-json');
        const res = await proxyFetch('openai', '/v1/responses', {
          body: { model: 'gpt-4o', input: 'Hello' },
        });
        expect(res.status).toBe(200);
        const parsed = JSON.parse(res.body);
        expect(parsed.object).toBe('response');
        expect(parsed.status).toBe('completed');
        expect(parsed.id).toBe('resp-e2e-json');
        expect(parsed.output[0].content[0].text).toBe('Hello from JSON.');
        expect(parsed.usage.input_tokens).toBe(10);
        expect(parsed.usage.output_tokens).toBe(5);
        expect(parsed.usage.total_tokens).toBe(15);
      });
    });

    describe('错误透传', () => {
      it('400 → Invalid model', async () => {
        mockServer.setMode('error-400');
        const res = await proxyFetch('openai', '/v1/chat/completions');
        expect(res.status).toBe(400);
        expect(JSON.parse(res.body).error.message).toContain('Invalid model');
      });

      it('401 → Incorrect API key', async () => {
        mockServer.setMode('error-401');
        const res = await proxyFetch('openai', '/v1/chat/completions');
        expect(res.status).toBe(401);
        expect(JSON.parse(res.body).error.code).toBe('invalid_api_key');
      });

      it('429 → Rate limit', async () => {
        mockServer.setMode('error-429');
        const res = await proxyFetch('openai', '/v1/chat/completions');
        expect(res.status).toBe(429);
        expect(JSON.parse(res.body).error.code).toBe('rate_limit_exceeded');
      });

      it('500 → Server error', async () => {
        mockServer.setMode('error-500');
        const res = await proxyFetch('openai', '/v1/chat/completions');
        expect(res.status).toBe(500);
        expect(JSON.parse(res.body).error.code).toBe('server_error');
      });
    });
  });

  // ==================== OpenAI 兼容供应商参数化测试 ====================

  describe('OpenAI 兼容供应商路由', () => {
    it.each(CHAT_ONLY_PROVIDERS.map(name => [name]))(
      '%s: chat/completions 路由到 openai-chat',
      async (name: string) => {
        const res = await proxyFetch(name, '/v1/chat/completions');
        expect(res.status).toBe(200);
        expect(mockServer.requests[0].url).toBe('/chat/completions');
      },
    );

    it.each(CHAT_ONLY_PROVIDERS.map(name => [name]))(
      '%s: Authorization header 透传',
      async (name: string) => {
        await proxyFetch(name, '/v1/chat/completions');
        expect(mockServer.requests[0].headers['authorization']).toBe('Bearer sk-e2e-test-key');
      },
    );

    it.each(CHAT_ONLY_PROVIDERS.map(name => [name]))(
      '%s: responses 端点 → 404',
      async (name: string) => {
        const res = await proxyFetch(name, '/v1/responses');
        expect(res.status).toBe(404);
      },
    );

    it.each(CHAT_ONLY_PROVIDERS.map(name => [name]))(
      '%s: messages 端点 → 404',
      async (name: string) => {
        const res = await proxyFetch(name, '/v1/messages');
        expect(res.status).toBe(404);
      },
    );
  });

  // ==================== /custom/ 前缀兼容 ====================

  describe('/custom/ 前缀兼容', () => {
    it('/custom/openai/v1/chat/completions → 同样路由成功', async () => {
      const res = await fetch(`http://127.0.0.1:${PROXY_PORT}/custom/openai/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'authorization': 'Bearer sk-test' },
        body: JSON.stringify({ model: 'gpt-4o', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] }),
      });
      expect(res.status).toBe(200);
      expect(mockServer.requests[0].url).toBe('/chat/completions');
    });

    it('/custom/deepseek/v1/chat/completions → 同样路由成功', async () => {
      const res = await fetch(`http://127.0.0.1:${PROXY_PORT}/custom/deepseek/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'authorization': 'Bearer sk-test' },
        body: JSON.stringify({ model: 'deepseek-chat', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] }),
      });
      expect(res.status).toBe(200);
      expect(mockServer.requests[0].url).toBe('/chat/completions');
    });
  });

  // ==================== 不存在的供应商 ====================

  describe('不存在供应商', () => {
    it('/unknown/v1/chat/completions → 404', async () => {
      const res = await proxyFetch('unknown', '/v1/chat/completions');
      expect(res.status).toBe(404);
      expect(JSON.parse(res.body).error).toContain('not found');
    });
  });

  // ==================== 日志落盘 ====================

  describe('日志落盘', () => {
    it('openai 请求日志含 providerName + endpointType', async () => {
      mockServer.setMode('chat-sse');
      await proxyFetch('openai', '/v1/chat/completions');
      await new Promise(r => setTimeout(r, 500));

      const logs = await readLatestLog(LOG_DIR);
      expect(logs).not.toBeNull();
      const last = (logs!).find((l: Record<string, unknown>) =>
        l.providerName === 'openai' && l.endpointType === 'openai-chat',
      );
      expect(last).toBeDefined();
    });

    it('deepseek 请求日志含正确 providerName', async () => {
      mockServer.setMode('chat-sse');
      await proxyFetch('deepseek', '/v1/chat/completions');
      await new Promise(r => setTimeout(r, 500));

      const logs = await readLatestLog(LOG_DIR);
      expect(logs).not.toBeNull();
      const last = (logs!).find((l: Record<string, unknown>) =>
        l.providerName === 'deepseek' && l.endpointType === 'openai-chat',
      );
      expect(last).toBeDefined();
    });
  });
});
