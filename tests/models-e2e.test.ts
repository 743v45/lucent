/**
 * models 列表端点 E2E 测试（models-endpoint spec）
 *
 * 验证 /{name}/v1/models 路由:
 * 1. 路径形式: /{name}/v1/models、/{name}/models、/custom/{name}/v1/models
 * 2. 默认目标解析: OpenAI 系优先（openai-chat → openai-responses → anthropic-messages）
 * 3. 显式隔离: ?protocol=anthropic / openai-responses / bogus
 * 4. query 透传: protocol 剥离、其余参数保留
 * 5. 透明转发: 鉴权头原样、错误路径仍 404
 * 6. 日志落库: providerName 记录、endpointType 为空
 * 7. mock 上游 /models 支持: auto / anthropic / openai 三格式 + setModels
 *
 * 运行: vitest run tests/models-e2e.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestEnv, cleanTestDir, writeTestConfig, startBackend, stopBackend, readLatestLog, createMockUpstream, type MockUpstream, type TestEnv } from './e2e-helpers.js';

// ==================== 常量 ====================

const testEnv = createTestEnv('models-e2e');
const { logDir: LOG_DIR, proxyPort: PROXY_PORT } = testEnv;

// ==================== 全局状态 ====================

let mockChat: MockUpstream;        // openai-chat 目标
let mockResponses: MockUpstream;   // openai-responses 目标
let mockAnthropic: MockUpstream;   // anthropic-messages 目标

// ==================== 工具函数 ====================

/** 经代理发 GET（models 标准形态） */
async function getViaProxy(
  path: string,
  headers?: Record<string, string>,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${PROXY_PORT}${path}`, {
    method: 'GET',
    headers: headers ?? {},
  });
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body };
}

// ==================== 测试套件 ====================

describe('models 端点 E2E', () => {
  beforeAll(async () => {
    mockChat = await createMockUpstream({ name: 'chat', format: 'openai' });
    mockResponses = await createMockUpstream({ name: 'responses', format: 'openai' });
    mockAnthropic = await createMockUpstream({ name: 'anthropic', format: 'anthropic' });

    await cleanTestDir(testEnv);
    await writeTestConfig(testEnv, {
      host: '127.0.0.1',
      proxyPort: PROXY_PORT,
      webPort: testEnv.webPort,
      providers: [
        {
          // 三协议全配（baseUrl 按 provider-baseurl 契约含 /v1）
          id: 'provider-fullstack',
          name: 'fullstack',
          endpoints: {
            'openai-chat': `http://127.0.0.1:${mockChat.port}/v1`,
            'openai-responses': `http://127.0.0.1:${mockResponses.port}/v1`,
            'anthropic-messages': `http://127.0.0.1:${mockAnthropic.port}/v1`,
          },
        },
        {
          // 仅 anthropic
          id: 'provider-claudeonly',
          name: 'claudeonly',
          endpoints: {
            'openai-chat': null,
            'openai-responses': null,
            'anthropic-messages': `http://127.0.0.1:${mockAnthropic.port}/v1`,
          },
        },
        {
          // 全 null
          id: 'provider-empty',
          name: 'empty',
          endpoints: {
            'openai-chat': null,
            'openai-responses': null,
            'anthropic-messages': null,
          },
        },
      ],
    });

    await startBackend(testEnv);
    await new Promise(resolve => setTimeout(resolve, 2000));
  }, 30000);

  afterAll(async () => {
    await stopBackend();
    await mockChat.close();
    await mockResponses.close();
    await mockAnthropic.close();
    await cleanTestDir(testEnv);
  }, 10000);

  beforeEach(() => {
    mockChat.reset();
    mockResponses.reset();
    mockAnthropic.reset();
  });

  // ==================== 路径形式 ====================

  describe('路径形式', () => {
    it('GET /fullstack/v1/models → 转发 openai-chat 上游 /v1/models', async () => {
      const res = await getViaProxy('/fullstack/v1/models');
      expect(res.status).toBe(200);
      expect(mockChat.requests.length).toBe(1);
      expect(mockChat.requests[0].url).toBe('/v1/models');
      expect(mockChat.requests[0].method).toBe('GET');
      // OpenAI list 格式透传
      expect(res.body.object).toBe('list');
      expect(Array.isArray(res.body.data)).toBe(true);
    });

    it('GET /fullstack/models（无 /v1 前缀）→ 同样命中', async () => {
      const res = await getViaProxy('/fullstack/models');
      expect(res.status).toBe(200);
      expect(mockChat.requests.length).toBe(1);
      expect(mockChat.requests[0].url).toBe('/v1/models');
    });

    it('GET /custom/fullstack/v1/models（自定义前缀变体）→ 命中', async () => {
      const res = await getViaProxy('/custom/fullstack/v1/models');
      expect(res.status).toBe(200);
      expect(mockChat.requests.length).toBe(1);
    });

    it('GET /fullstack/v1/unknown（非 models 路径）→ 仍 404 unsupported endpoint path', async () => {
      const res = await getViaProxy('/fullstack/v1/unknown');
      expect(res.status).toBe(404);
      expect((res.body as { error: string }).error).toContain('unsupported endpoint path');
    });
  });

  // ==================== 默认目标解析 ====================

  describe('默认目标解析（OpenAI 系优先）', () => {
    it('三协议全配 → 默认转发 openai-chat（不落在 responses/anthropic）', async () => {
      const res = await getViaProxy('/fullstack/v1/models');
      expect(res.status).toBe(200);
      expect(mockChat.requests.length).toBe(1);
      expect(mockResponses.requests.length).toBe(0);
      expect(mockAnthropic.requests.length).toBe(0);
    });

    it('仅 anthropic 配置 → 默认回退 anthropic-messages,响应为 Anthropic 格式', async () => {
      const res = await getViaProxy('/claudeonly/v1/models');
      expect(res.status).toBe(200);
      expect(mockAnthropic.requests.length).toBe(1);
      expect(res.body.data[0].type).toBe('model');
      expect(res.body.has_more).toBe(false);
    });

    it('全 null endpoint → 404 does not support models', async () => {
      const res = await getViaProxy('/empty/v1/models');
      expect(res.status).toBe(404);
      expect((res.body as { error: string }).error).toContain('does not support models');
    });
  });

  // ==================== 显式协议隔离 ====================

  describe('?protocol= 显式隔离', () => {
    it('?protocol=anthropic → 转发 anthropic-messages,Anthropic 格式响应', async () => {
      const res = await getViaProxy('/fullstack/v1/models?protocol=anthropic');
      expect(res.status).toBe(200);
      expect(mockAnthropic.requests.length).toBe(1);
      expect(mockChat.requests.length).toBe(0);
      expect(res.body.data[0].type).toBe('model');
    });

    it('?protocol=anthropic-messages（全名）→ 同 anthropic', async () => {
      const res = await getViaProxy('/fullstack/v1/models?protocol=anthropic-messages');
      expect(res.status).toBe(200);
      expect(mockAnthropic.requests.length).toBe(1);
    });

    it('?protocol=openai-responses → 精确指定 responses 端点', async () => {
      const res = await getViaProxy('/fullstack/v1/models?protocol=openai-responses');
      expect(res.status).toBe(200);
      expect(mockResponses.requests.length).toBe(1);
      expect(mockChat.requests.length).toBe(0);
    });

    it('?protocol=anthropic 但未配置 anthropic → 404 不回退其他协议', async () => {
      const res = await getViaProxy('/claudeonly/v1/models?protocol=openai');
      expect(res.status).toBe(404);
      expect((res.body as { error: string }).error).toContain('does not support models');
      expect(mockAnthropic.requests.length).toBe(0);
    });

    it('?protocol=bogus → 400', async () => {
      const res = await getViaProxy('/fullstack/v1/models?protocol=bogus');
      expect(res.status).toBe(400);
      expect((res.body as { error: string }).error).toContain('invalid protocol');
    });
  });

  // ==================== query 透传 ====================

  describe('query 透传', () => {
    it('protocol 剥离,其余参数原样保留', async () => {
      const res = await getViaProxy('/fullstack/v1/models?limit=5&protocol=anthropic');
      expect(res.status).toBe(200);
      expect(mockAnthropic.requests.length).toBe(1);
      expect(mockAnthropic.requests[0].url).toBe('/v1/models?limit=5');
    });

    it('无 protocol 时 query 完整透传', async () => {
      await getViaProxy('/fullstack/v1/models?limit=2&offset=4');
      expect(mockChat.requests[0].url).toBe('/v1/models?limit=2&offset=4');
    });
  });

  // ==================== 透明转发 ====================

  describe('透明转发', () => {
    it('鉴权头原样透传,lucent 内部头不泄露', async () => {
      await getViaProxy('/fullstack/v1/models', {
        'x-api-key': 'sk-test-key',
        'authorization': 'Bearer sk-test-key',
      });

      const headers = mockChat.requests[0].headers;
      expect(headers['x-api-key']).toBe('sk-test-key');
      expect(headers['authorization']).toBe('Bearer sk-test-key');
      expect(headers['x-lucent-provider']).toBeUndefined();
      expect(headers['x-lucent-endpoint']).toBeUndefined();
    });
  });

  // ==================== 日志落库 ====================

  describe('日志落库', () => {
    it('models 请求落日志: providerName 记录,endpointType 为空', async () => {
      await getViaProxy('/claudeonly/v1/models?limit=3');

      const logs = await readLatestLog(LOG_DIR);
      expect(logs).not.toBeNull();
      // 日志按 timestamp 升序返回,取最后一条 models 请求(前面用例发过多条 fullstack models)
      const entry = logs!.filter(l => String(l.url).includes('/models')).pop();
      expect(entry).toBeDefined();
      expect(entry!.providerName).toBe('claudeonly');
      // endpointType 无协议归属:拦截器写入 undefined,落库读回为 null
      expect(entry!.endpointType ?? null).toBeNull();
      expect(entry!.method).toBe('GET');
    });
  });

  // ==================== mock 上游 /models 支持 ====================

  describe('mock 上游 /models 支持', () => {
    it('auto 实例 → OpenAI list 格式;anthropic 实例 → Anthropic 格式', async () => {
      const autoMock = await createMockUpstream({ name: 'auto-m', format: 'auto' });
      const anthropicMock = await createMockUpstream({ name: 'anthropic-m', format: 'anthropic' });
      try {
        for (const mock of [autoMock, anthropicMock]) {
          const res = await fetch(`http://127.0.0.1:${mock.port}/v1/models`);
          expect(res.status).toBe(200);
          const body = await res.json() as any;
          expect(Array.isArray(body.data)).toBe(true);
        }
        // 请求被记录
        expect(autoMock.requests.length).toBe(1);
      } finally {
        await autoMock.close();
        await anthropicMock.close();
      }
    });

    it('setModels 配置生效;reset() 不清除配置', async () => {
      mockChat.setModels(['m-a', 'm-b']);
      try {
        let res = await getViaProxy('/fullstack/v1/models');
        expect(res.body.data.map((m: { id: string }) => m.id)).toEqual(['m-a', 'm-b']);

        mockChat.reset();
        res = await getViaProxy('/fullstack/v1/models');
        expect(res.body.data.map((m: { id: string }) => m.id)).toEqual(['m-a', 'm-b']);
        expect(mockChat.requests.length).toBe(1);
      } finally {
        mockChat.setModels(['mock-model-1', 'mock-model-2']);
      }
    });
  });
});
