/**
 * 配置动态更新 E2E 测试
 *
 * 验证: 运行时通过 API 修改 provider 端点后，下一次请求使用新的上游地址
 * 运行: vitest run tests/config-reload-e2e.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestEnv, cleanTestDir, writeTestConfig, readTestConfig, startBackend, stopBackend, createMockUpstream, type MockUpstream, type TestEnv } from './e2e-helpers.js';

// ==================== 常量 ====================

const testEnv = createTestEnv('config-reload-e2e');
const { proxyPort: PROXY_PORT, webPort: WEB_PORT } = testEnv;

// ==================== 全局状态 ====================

let mock1: MockUpstream;
let mock2: MockUpstream;

// ==================== 工具函数 ====================

async function proxyRequest(): Promise<{ ok: boolean }> {
  try {
    const res = await fetch(`http://127.0.0.1:${PROXY_PORT}/glm/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-3-opus-20240229',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    });
    return { ok: res.ok };
  } catch {
    return { ok: false };
  }
}

async function readConfig(): Promise<any> {
  return readTestConfig(testEnv);
}

// ==================== 测试套件 ====================

describe('配置动态更新 E2E 测试', () => {
  beforeAll(async () => {
    mock1 = await createMockUpstream({ name: 'mock1' });
    mock2 = await createMockUpstream({ name: 'mock2' });

    // 初始配置: glm → mock1
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
            'anthropic-messages': `http://127.0.0.1:${mock1.port}`,
            'openai-chat': null,
            'openai-responses': null,
          },
        },
      ],
    });

    await startBackend(testEnv);
    await new Promise(r => setTimeout(r, 2000));
  }, 30000);

  afterAll(async () => {
    await stopBackend();
    await mock1.close();
    await mock2.close();
    await cleanTestDir(testEnv);
  }, 10000);

  beforeEach(() => {
    mock1.reset();
    mock2.reset();
  });

  it('初始状态: 请求应发送到 Mock 1', async () => {
    await proxyRequest();

    expect(mock1.requests.length).toBeGreaterThan(0);
    expect(mock2.requests.length).toBe(0);
  });

  it('通过 PUT API 修改端点后，请求应发送到 Mock 2', async () => {
    // 通过 REST API 修改 glm 的 anthropic-messages 端点指向 mock2
    const res = await fetch(`http://127.0.0.1:${WEB_PORT}/api/providers/glm`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        endpoints: {
          'anthropic-messages': `http://127.0.0.1:${mock2.port}`,
          'openai-chat': null,
          'openai-responses': null,
        },
      }),
    });
    expect(res.ok).toBe(true);

    // 等待配置生效
    await new Promise(r => setTimeout(r, 200));

    await proxyRequest();

    expect(mock1.requests.length).toBe(0);
    expect(mock2.requests.length).toBeGreaterThan(0);
  });

  it('验证配置已持久化到数据库', async () => {
    const config = await readConfig();
    const glm = config.providers.find((p: any) => p.name === 'glm');
    expect(glm).toBeDefined();
    expect(glm.endpoints['anthropic-messages']).toBe(`http://127.0.0.1:${mock2.port}`);
  });

  it('通过 PUT API 切换回 Mock 1 后，请求应回到 Mock 1', async () => {
    const res = await fetch(`http://127.0.0.1:${WEB_PORT}/api/providers/glm`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        endpoints: {
          'anthropic-messages': `http://127.0.0.1:${mock1.port}`,
          'openai-chat': null,
          'openai-responses': null,
        },
      }),
    });
    expect(res.ok).toBe(true);

    await new Promise(r => setTimeout(r, 200));

    await proxyRequest();

    expect(mock1.requests.length).toBeGreaterThan(0);
    expect(mock2.requests.length).toBe(0);
  });
});
