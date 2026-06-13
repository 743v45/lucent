/**
 * log-reader.buildContextFromRequest 单元测试
 *
 * 重点：contextWindow 口径须与 KV-Cache 的 totalInputTokens 一致（含 cache tokens）
 */

import { describe, it, expect } from 'vitest';
import { buildContextFromRequest } from '../server/services/log-reader.js';
import type { LogEntry } from '../server/types.js';

describe('buildContextFromRequest — contextWindow 口径', () => {
  it('totalTokens 含 cache_creation + cache_read（与 KV-Cache 一致）', () => {
    const log = {
      id: 'test-ctx',
      timestamp: '2026-01-01T00:00:00.000Z',
      request: {
        method: 'POST',
        url: 'https://api.anthropic.com/v1/messages',
        headers: {},
        body: {
          model: 'claude-3-5-sonnet-20241022',
          messages: [{ role: 'user', content: 'hi' }],
        },
      },
      response: {
        status: 200,
        statusText: 'OK',
        headers: {},
        body: {
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_creation_input_tokens: 200,
            cache_read_input_tokens: 300,
          },
        },
      },
      agentType: 'main',
      duration: 0,
      metadata: { model: 'claude-3-5-sonnet-20241022', provider: 'claude', stream: false },
      tokenUsage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_tokens: 200,
        cache_read_tokens: 300,
      },
      endpointType: 'anthropic-messages',
    } as unknown as LogEntry;

    buildContextFromRequest(log);

    // totalInput = 100(input) + 200(create) + 300(read) = 600；output=50；total=650
    expect(log.context?.contextWindow?.totalTokens).toBe(650);
  });

  it('SSE 流式响应：从 lines 提取 cache read（tokenUsage 缺失时兜底）', () => {
    const lines = [
      { event: 'message_start', data: JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 173, cache_creation_input_tokens: 0, cache_read_input_tokens: 29184 } } }) },
      { event: 'message_delta', data: JSON.stringify({ type: 'message_delta', usage: { output_tokens: 121 } }) },
    ];
    const log = {
      id: 'test-sse',
      timestamp: '2026-06-12T00:00:00.000Z',
      request: { method: 'POST', url: 'https://api.anthropic.com/v1/messages', headers: {}, body: { model: 'claude-3-5-sonnet-20241022', messages: [{ role: 'user', content: 'hi' }] } },
      response: { status: 200, statusText: 'OK', headers: {}, body: { type: 'sse_raw', lines } },
      agentType: 'main',
      duration: 0,
      metadata: { model: 'claude-3-5-sonnet-20241022', provider: 'claude', stream: true },
      endpointType: 'anthropic-messages',
    } as unknown as LogEntry;

    buildContextFromRequest(log);

    expect(log.kvCache?.cacheReadTokens).toBe(29184);
    expect(log.kvCache?.hitRate).toBeGreaterThan(0);
  });

  it('历史 camelCase tokenUsage：归一化后正确读取 cache read', () => {
    const log = {
      id: 'test-camel',
      timestamp: '2026-06-12T00:00:00.000Z',
      request: { method: 'POST', url: 'https://api.anthropic.com/v1/messages', headers: {}, body: { model: 'claude-3-5-sonnet-20241022', messages: [{ role: 'user', content: 'hi' }] } },
      response: { status: 200, statusText: 'OK', headers: {}, body: {} },
      agentType: 'main',
      duration: 0,
      metadata: { model: 'claude-3-5-sonnet-20241022', provider: 'claude', stream: true },
      tokenUsage: { inputTokens: 173, outputTokens: 121, cacheReadTokens: 29184 },
      endpointType: 'anthropic-messages',
    } as unknown as LogEntry;

    buildContextFromRequest(log);

    expect(log.kvCache?.cacheReadTokens).toBe(29184);
  });
});
