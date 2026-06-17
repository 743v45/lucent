/**
 * Provider 重构 E2E 测试
 *
 * 验证多供应商 + 自定义路由架构:
 * 1. 配置 CRUD: 新建/重命名(冲突拒绝)/更新/删除
 * 2. 路由命中: /custom/{name}/{rest} → 正确端点
 * 3. 鉴权头透传: 不同 endpointType header 是否正确到达上游
 * 4. 日志落盘: providerName + endpointType
 * 5. 首次启动: 无配置时创建默认 anthropic 供应商
 *
 * 运行: vitest run tests/provider-e2e.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { createTestEnv, cleanTestDir, writeTestConfig, startBackend, stopBackend, readLatestLog, createMockUpstream, type MockUpstream, type TestEnv } from './e2e-helpers.js';

// ==================== 常量 ====================

const testEnv = createTestEnv('provider-e2e');
const { configPath: CONFIG_PATH, logDir: LOG_DIR, proxyPort: PROXY_PORT, webPort: WEB_PORT } = testEnv;

// ==================== 类型定义 ====================

interface ProxyConfig {
  host: string;
  proxyPort: number;
  webPort: number;
  providers: Array<{
    id: string;
    name: string;
    endpoints: Record<string, string | null>;
  }>;
}

// ==================== 全局状态 ====================

let mockAnthropic: MockUpstream;
let mockOpenAI: MockUpstream;

// ==================== 工具函数 ====================

/**
 * 通过代理发送请求到自定义路径
 */
async function requestViaProxy(
  providerName: string,
  path: string,
  options?: { headers?: Record<string, string>; body?: unknown },
): Promise<{ status: number; body: unknown }> {
  try {
    const res = await fetch(`http://127.0.0.1:${PROXY_PORT}/custom/${providerName}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...options?.headers,
      },
      body: JSON.stringify(options?.body ?? {
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    });

    const text = await res.text();
    let body: unknown = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { status: res.status, body };
  } catch (err) {
    return { status: 0, body: { error: String(err) } };
  }
}

async function apiRequest(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  try {
    const res = await fetch(`http://127.0.0.1:${WEB_PORT}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const responseBody = await res.text();
    return { status: res.status, body: responseBody ? JSON.parse(responseBody) : null };
  } catch (err) {
    return { status: 0, body: { error: String(err) } };
  }
}

async function readTestConfig(): Promise<ProxyConfig | null> {
  if (!existsSync(CONFIG_PATH)) return null;
  const content = await readFile(CONFIG_PATH, 'utf-8');
  return JSON.parse(content);
}

// ==================== 测试套件 ====================

describe('Provider E2E 测试', () => {
  beforeAll(async () => {
    mockAnthropic = await createMockUpstream({ name: 'anthropic' });
    mockOpenAI = await createMockUpstream({ name: 'openai' });

    await cleanTestDir(testEnv);
    await writeTestConfig(testEnv, {
      host: '127.0.0.1',
      proxyPort: PROXY_PORT,
      webPort: WEB_PORT,
      providers: [
        {
          id: 'provider-glm',
          name: 'glm',
          endpoints: {
            'anthropic-messages': `http://127.0.0.1:${mockAnthropic.port}`,
            'openai-chat': `http://127.0.0.1:${mockOpenAI.port}`,
            'openai-responses': null,
          },
        },
      ],
    });

    await startBackend(testEnv);
    await new Promise(resolve => setTimeout(resolve, 2000));
  }, 30000);

  afterAll(async () => {
    await stopBackend();
    await mockAnthropic.close();
    await mockOpenAI.close();
    await cleanTestDir(testEnv);
  }, 10000);

  beforeEach(() => {
    mockAnthropic.reset();
    mockOpenAI.reset();
  });

  // ==================== 路由命中测试 ====================

  describe('路由命中', () => {
    it('/custom/glm/v1/messages → 命中 anthropic-messages 端点', async () => {
      const res = await requestViaProxy('glm', '/v1/messages');
      expect(res.status).toBe(200);

      expect(mockAnthropic.requests.length).toBeGreaterThan(0);
      // proxy 去掉 rest 中的 /v1 前缀，上游收到 /messages
      expect(mockAnthropic.requests[0].url).toBe('/messages');
    });

    it('/custom/glm/v1/chat/completions → 命中 openai-chat 端点', async () => {
      const res = await requestViaProxy('glm', '/v1/chat/completions');
      expect(res.status).toBe(200);

      expect(mockOpenAI.requests.length).toBeGreaterThan(0);
      expect(mockOpenAI.requests[0].url).toBe('/chat/completions');
    });

    it('/custom/glm/v1/responses (GLM 未配) → 404', async () => {
      const res = await requestViaProxy('glm', '/v1/responses');
      expect(res.status).toBe(404);
      expect((res.body as { error: string }).error).toContain('does not support');
    });

    it('/custom/unknown/v1/messages → 404 (provider not found)', async () => {
      const res = await requestViaProxy('unknown', '/v1/messages');
      expect(res.status).toBe(404);
      expect((res.body as { error: string }).error).toContain('not found');
    });

    it('/v1/messages 裸路径 → 被解析为 provider=v1 → 404', async () => {
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

  // ==================== 鉴权头透传测试 ====================

  describe('鉴权头透传', () => {
    it('anthropic-messages: x-api-key + anthropic-version 原样透传', async () => {
      await requestViaProxy('glm', '/v1/messages', {
        headers: {
          'x-api-key': 'sk-glm-test-key',
          'anthropic-version': '2023-06-01',
        },
      });

      expect(mockAnthropic.requests[0].headers['x-api-key']).toBe('sk-glm-test-key');
      expect(mockAnthropic.requests[0].headers['anthropic-version']).toBe('2023-06-01');
    });

    it('openai-chat: Authorization Bearer 原样透传', async () => {
      await requestViaProxy('glm', '/v1/chat/completions', {
        headers: {
          'authorization': 'Bearer sk-glm-test-key',
        },
      });

      expect(mockOpenAI.requests[0].headers['authorization']).toBe('Bearer sk-glm-test-key');
    });
  });

  // ==================== 配置 CRUD 测试 ====================

  describe('配置 CRUD', () => {
    it('GET /api/providers → 列出 providers', async () => {
      const res = await apiRequest('GET', '/api/providers');
      expect(res.status).toBe(200);

      const body = res.body as { providers: Array<{ name: string }> };
      expect(body.providers.length).toBeGreaterThan(0);
      expect(body.providers[0].name).toBe('glm');
    });

    it('POST /api/providers → 新增 provider (非预设名)', async () => {
      const res = await apiRequest('POST', '/api/providers', {
        name: 'mytest',
        endpoints: {
          'openai-chat': 'https://api.mytest.com',
          'anthropic-messages': null,
          'openai-responses': null,
        },
      });
      expect(res.status).toBe(201);

      const config = await readTestConfig();
      const mytest = config?.providers.find(p => p.name === 'mytest');
      expect(mytest).toBeDefined();
      expect(mytest?.endpoints['openai-chat']).toBe('https://api.mytest.com');
    });

    it('POST /api/providers 重复 name → 409 冲突', async () => {
      const res = await apiRequest('POST', '/api/providers', {
        name: 'mytest',
        endpoints: { 'openai-chat': 'https://other.com', 'anthropic-messages': null, 'openai-responses': null },
      });
      expect(res.status).toBe(409);
    });

    it('PUT /api/providers/:name → 更新 endpoints', async () => {
      const res = await apiRequest('PUT', '/api/providers/mytest', {
        endpoints: {
          'openai-chat': 'https://api.mytest.com/v2',
          'anthropic-messages': null,
          'openai-responses': null,
        },
      });
      expect(res.status).toBe(200);

      const config = await readTestConfig();
      const mytest = config?.providers.find(p => p.name === 'mytest');
      expect(mytest?.endpoints['openai-chat']).toBe('https://api.mytest.com/v2');
    });

    it('POST /api/providers/:name/rename → 重命名', async () => {
      const res = await apiRequest('POST', '/api/providers/mytest/rename', {
        newName: 'mytest-v2',
      });
      expect(res.status).toBe(200);

      const config = await readTestConfig();
      expect(config?.providers.find(p => p.name === 'mytest')).toBeUndefined();
      expect(config?.providers.find(p => p.name === 'mytest-v2')).toBeDefined();
    });

    it('DELETE /api/providers/:name → 删除', async () => {
      const res = await apiRequest('DELETE', '/api/providers/mytest-v2');
      expect(res.status).toBe(200);

      const config = await readTestConfig();
      expect(config?.providers.find(p => p.name === 'mytest-v2')).toBeUndefined();
    });
  });

  // ==================== 测试连接（baseUrl 含 /v1，与 presets 一致）====================

  describe('测试连接: baseUrl 含 /v1（presets 写法）', () => {
    // presets.ts 里 anthropic/openai/deepseek 等内置预设的 baseUrl 均含 /v1
    // 测试路由必须与 proxy 主转发对齐：baseUrl 已含 /v1，直接补协议路径，不能重复加 /v1
    // 否则拼成 https://api.anthropic.com/v1/v1/messages → 测试必失败

    it('anthropic-messages: baseUrl 含 /v1 → 上游收到 /v1/messages（非 /v1/v1/messages）', async () => {
      // 动态新建一个 baseUrl 含 /v1 的 provider，复用主套件 mock 上游
      const res = await apiRequest('POST', '/api/providers', {
        name: 'preset-style',
        endpoints: {
          'anthropic-messages': `http://127.0.0.1:${mockAnthropic.port}/v1`,
          'openai-chat': null,
          'openai-responses': null,
        },
      });
      expect(res.status).toBe(201);

      const testRes = await apiRequest('POST', '/api/providers/preset-style/test', {
        endpointType: 'anthropic-messages',
      });
      expect(testRes.status).toBe(200);

      // mock 上游应收到 /v1/messages，而非双重 v1
      const hit = mockAnthropic.requests.find(r => r.url.includes('/messages'));
      expect(hit).toBeDefined();
      expect(hit!.url).toBe('/v1/messages');
      expect(hit!.url).not.toContain('/v1/v1/');
    });

    it('openai-chat: baseUrl 含 /v1 → 上游收到 /v1/chat/completions（非 /v1/v1/chat/completions）', async () => {
      const res = await apiRequest('POST', '/api/providers', {
        name: 'preset-style-chat',
        endpoints: {
          'openai-chat': `http://127.0.0.1:${mockOpenAI.port}/v1`,
          'anthropic-messages': null,
          'openai-responses': null,
        },
      });
      expect(res.status).toBe(201);

      const testRes = await apiRequest('POST', '/api/providers/preset-style-chat/test', {
        endpointType: 'openai-chat',
      });
      expect(testRes.status).toBe(200);

      const hit = mockOpenAI.requests.find(r => r.url.includes('/chat/completions'));
      expect(hit).toBeDefined();
      expect(hit!.url).toBe('/v1/chat/completions');
      expect(hit!.url).not.toContain('/v1/v1/');
    });

    it('openai-responses: baseUrl 含 /v1 → 上游收到 /v1/responses（非 /v1/v1/responses）', async () => {
      const res = await apiRequest('POST', '/api/providers', {
        name: 'preset-style-resp',
        endpoints: {
          'openai-chat': null,
          'openai-responses': `http://127.0.0.1:${mockOpenAI.port}/v1`,
          'anthropic-messages': null,
        },
      });
      expect(res.status).toBe(201);

      const testRes = await apiRequest('POST', '/api/providers/preset-style-resp/test', {
        endpointType: 'openai-responses',
      });
      expect(testRes.status).toBe(200);

      const hit = mockOpenAI.requests.find(r => r.url.includes('/responses'));
      expect(hit).toBeDefined();
      expect(hit!.url).toBe('/v1/responses');
      expect(hit!.url).not.toContain('/v1/v1/');
    });
  });

  // ==================== 日志落盘测试 ====================

  describe('日志落盘', () => {
    it('请求后日志含 providerName + endpointType', async () => {
      await requestViaProxy('glm', '/v1/messages');

      await new Promise(resolve => setTimeout(resolve, 500));

      const logs = await readLatestLog(LOG_DIR);
      expect(logs).not.toBeNull();
      expect(logs!.length).toBeGreaterThan(0);

      const entry = logs!.find(l => l.providerName === 'glm');
      expect(entry).toBeDefined();
      expect(entry?.providerName).toBe('glm');
      expect(entry?.endpointType).toBe('anthropic-messages');
    });

    // ===== Delta 机制移除测试（曾因全局状态串话导致 body.messages 被清空）=====
    // 对应 openspec/specs/provider-baseurl 同源的日志完整性要求:
    // 每次请求的 body.messages 必须原样落盘, 不允许被 delta 逻辑截短或清空

    it('连续两次发相同 messages, 两次日志的 body.messages 都必须完整(不被 delta 清空)', async () => {
      const messages = [
        { role: 'user', content: 'What is latin for Ant?' },
        { role: 'assistant', content: 'The answer is (' },
      ];

      // 第一次请求
      await requestViaProxy('glm', '/v1/messages', {
        headers: { 'x-api-key': 'sk-test', 'anthropic-version': '2023-06-01' },
        body: { model: 'claude-sonnet-4-5', max_tokens: 1, messages },
      });
      await new Promise(r => setTimeout(r, 400));

      // 第二次请求(相同 messages, 独立请求, 非会话延续)
      await requestViaProxy('glm', '/v1/messages', {
        headers: { 'x-api-key': 'sk-test', 'anthropic-version': '2023-06-01' },
        body: { model: 'claude-sonnet-4-5', max_tokens: 1, messages },
      });
      await new Promise(r => setTimeout(r, 500));

      const logs = await readLatestLog(LOG_DIR);
      expect(logs).not.toBeNull();
      const glmEntries = logs!.filter(l => l.providerName === 'glm' && l.endpointType === 'anthropic-messages');
      // 至少有这两次请求的记录
      expect(glmEntries.length).toBeGreaterThanOrEqual(2);

      // 取最后两条(本次测试发的)
      const lastTwo = glmEntries.slice(-2);
      for (const [i, entry] of lastTwo.entries()) {
        const bodyMessages = (entry as any)?.body?.messages;
        expect(bodyMessages).toBeDefined();
        expect(Array.isArray(bodyMessages)).toBe(true);
        // 关键断言: 必须是完整的 2 条, 不能被 delta 清空为 []
        expect(bodyMessages.length).toBe(2);
        expect(bodyMessages[0]).toEqual(messages[0]);
        expect(bodyMessages[1]).toEqual(messages[1]);
      }
    });
  });
});

// ==================== 首次启动测试 ====================

describe('首次启动:无配置时创建默认 anthropic 供应商', () => {
  let standaloneBackend: ChildProcess | null = null;

  beforeAll(async () => {
    await stopBackend();
    await cleanTestDir(testEnv);
  }, 10000);

  afterAll(async () => {
    if (standaloneBackend) {
      standaloneBackend.kill('SIGTERM');
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    await cleanTestDir(testEnv);
  }, 10000);

  it('启动后应创建默认 anthropic 供应商', async () => {
    standaloneBackend = spawn('npx', ['tsx', 'server/index.ts'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        LUCENT_CONFIG_DIR: testEnv.configDir,
        LUCENT_HOST: '127.0.0.1',
        LUCENT_PROXY_PORT: String(19048),
        LUCENT_WEB_PORT: String(19049),
      },
    });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { reject(new Error('Server startup timeout')); }, 15000);

      standaloneBackend!.stdout?.on('data', () => {
        clearTimeout(timeout);
        resolve();
      });

      standaloneBackend!.on('error', (err) => { clearTimeout(timeout); reject(err); });
    });

    await new Promise(resolve => setTimeout(resolve, 1000));

    const config = await readTestConfig();
    expect(config).not.toBeNull();
    expect(config?.providers.length).toBeGreaterThan(0);

    const defaultProvider = config?.providers.find(p => p.name === 'anthropic');
    expect(defaultProvider).toBeDefined();
    expect(defaultProvider?.endpoints['anthropic-messages']).toBeDefined();
    // 默认 baseUrl 必须含 /v1，与 presets.ts 对齐（proxy.ts 假设 baseUrl 含 /v1）
    // 不含 /v1 会导致代理转发拼成 https://api.anthropic.com/messages → 上游 404
    expect(defaultProvider?.endpoints['anthropic-messages']).toBe('https://api.anthropic.com/v1');
  }, 20000);
});
