/**
 * MockUpstream 共享工具单测
 *
 * 这是所有 e2e 测试的地基：mock 上游必须能正确记录请求、按模式返回响应、
 * 释放端口。地基不稳，上层 e2e 全塌。
 *
 * 运行: npx vitest run tests/mock-upstream.test.ts
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createMockUpstream, type MockUpstream } from './e2e-helpers.js';

const created: MockUpstream[] = [];

async function makeUpstream(): Promise<MockUpstream> {
  const u = await createMockUpstream({ name: 'test' });
  created.push(u);
  return u;
}

afterEach(async () => {
  // 兜底关闭，防端口泄漏影响其他测试
  await Promise.all(created.splice(0).map(u => u.close().catch(() => {})));
});

describe('MockUpstream', () => {
  it('启动后 port > 0，可被请求', async () => {
    const u = await makeUpstream();
    expect(u.port).toBeGreaterThan(0);

    const res = await fetch(`http://127.0.0.1:${u.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hi: 1 }),
    });
    expect(res.status).toBe(200);
  });

  it('记录请求的 url / method / headers / body', async () => {
    const u = await makeUpstream();
    await fetch(`http://127.0.0.1:${u.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'sk-test' },
      body: JSON.stringify({ model: 'm', messages: [] }),
    });

    expect(u.requests).toHaveLength(1);
    expect(u.requests[0].method).toBe('POST');
    expect(u.requests[0].url).toBe('/v1/messages');
    expect(u.requests[0].headers['x-api-key']).toBe('sk-test');
    expect(u.requests[0].body).toBe(JSON.stringify({ model: 'm', messages: [] }));
  });

  it('reset() 清空已记录的请求', async () => {
    const u = await makeUpstream();
    await fetch(`http://127.0.0.1:${u.port}/a`, { method: 'POST' });
    expect(u.requests).toHaveLength(1);

    u.reset();
    expect(u.requests).toHaveLength(0);
  });

  it('默认 sse-text 模式返回 text/event-stream', async () => {
    const u = await makeUpstream();
    const res = await fetch(`http://127.0.0.1:${u.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    // SSE 事件以 "event:" 开头
    expect(text).toContain('event: message_start');
  });

  it('setMode("json") 返回 application/json', async () => {
    const u = await makeUpstream();
    u.setMode('json');
    const res = await fetch(`http://127.0.0.1:${u.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.headers.get('content-type')).toContain('application/json');
    const j = await res.json();
    expect(j.type).toBe('message');
  });

  it('setMode("error-429") 返回 429 + 错误体', async () => {
    const u = await makeUpstream();
    u.setMode('error-429');
    const res = await fetch(`http://127.0.0.1:${u.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(429);
    const j = await res.json();
    expect(j.type).toBe('error');
    expect(j.error.type).toBe('rate_limit_error');
  });

  it('close() 后端口不再可连', async () => {
    const u = await makeUpstream();
    const port = u.port;
    await u.close();
    await expect(
      fetch(`http://127.0.0.1:${port}/x`, { method: 'POST' }),
    ).rejects.toThrow();
  });
});

describe('MockUpstream (OpenAI 格式)', () => {
  const openaiCreated: MockUpstream[] = [];

  async function makeOpenAI(mode?: Parameters<MockUpstream['setMode']>[0]): Promise<MockUpstream> {
    const u = await createMockUpstream({ name: 'openai-test', format: 'openai' });
    if (mode) u.setMode(mode);
    openaiCreated.push(u);
    return u;
  }

  afterEach(async () => {
    await Promise.all(openaiCreated.splice(0).map(u => u.close().catch(() => {})));
  });

  it('默认 chat-sse 模式返回 OpenAI chat.completion.chunk 流', async () => {
    const u = await makeOpenAI();
    const res = await fetch(`http://127.0.0.1:${u.port}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    expect(text).toContain('chat.completion.chunk');
    expect(text).toContain('[DONE]');
  });

  it('chat-json 模式返回 OpenAI chat.completion JSON', async () => {
    const u = await makeOpenAI('chat-json');
    const res = await fetch(`http://127.0.0.1:${u.port}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    expect(res.headers.get('content-type')).toContain('application/json');
    const j = await res.json();
    expect(j.object).toBe('chat.completion');
  });

  it('chat-tool-calls 模式返回带 tool_calls 的 SSE', async () => {
    const u = await makeOpenAI('chat-tool-calls');
    const res = await fetch(`http://127.0.0.1:${u.port}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    const text = await res.text();
    expect(text).toContain('tool_calls');
  });

  it('responses-sse 模式返回 OpenAI Responses SSE', async () => {
    const u = await makeOpenAI('responses-sse');
    const res = await fetch(`http://127.0.0.1:${u.port}/v1/responses`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    const text = await res.text();
    expect(text).toContain('response.output_text.delta');
    expect(text).toContain('response.completed');
  });

  it('responses-json 模式返回 Responses JSON', async () => {
    const u = await makeOpenAI('responses-json');
    const res = await fetch(`http://127.0.0.1:${u.port}/v1/responses`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    const j = await res.json();
    expect(j.object).toBe('response');
  });

  it('error-429 模式返回 OpenAI 错误格式', async () => {
    const u = await makeOpenAI('error-429');
    const res = await fetch(`http://127.0.0.1:${u.port}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    expect(res.status).toBe(429);
    const j = await res.json();
    expect(j.error).toBeDefined();
    expect(j.error.code).toBe('rate_limit_exceeded');
  });

  it('记录请求的 url / method / body', async () => {
    const u = await makeOpenAI();
    await fetch(`http://127.0.0.1:${u.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer sk-x' },
      body: JSON.stringify({ model: 'gpt-4o', messages: [] }),
    });
    expect(u.requests).toHaveLength(1);
    expect(u.requests[0].url).toBe('/v1/chat/completions');
    expect(u.requests[0].headers.authorization).toBe('Bearer sk-x');
  });
});
