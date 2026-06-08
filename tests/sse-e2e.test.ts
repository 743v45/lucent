/**
 * SSE 流端到端测试
 *
 * 模拟真实 SSE 流式响应，测试 extractInBackground 函数
 * 新架构存储原始 SSE 行数据 (sse_raw)，使用 extractFromSSELines 提取结构化信息
 */

import { describe, it, expect } from 'vitest';
import { ReadableStream } from 'node:stream/web';
import { extractInBackground, extractFromSSELines } from '../server/sse-extractor.js';
import type { ExtractedInfo, RawLogEntry, SSERawBody } from '../server/types.js';

// 测试中用 RawLogEntry 替代原 LogEntry
type LogEntry = RawLogEntry;

/**
 * 从日志条目的 SSE 原始数据中提取结构化信息
 * 新架构中，response.body 是 SSERawBody {type: 'sse_raw', lines: [...]}
 */
function extractFromEntry(entry: LogEntry): ExtractedInfo {
  const body = entry.response?.body as SSERawBody | undefined;
  if (!body || body.type !== 'sse_raw' || !body.lines) {
    throw new Error('Expected sse_raw body with lines');
  }
  return extractFromSSELines(body.lines);
}

// SSE 格式编码函数
function encodeSSE(events: Array<{ event?: string; data: any }>): Uint8Array {
  const encoder = new TextEncoder();
  const chunks = events.map(e => {
    const lines = [];
    if (e.event) lines.push(`event: ${e.event}`);
    lines.push(`data: ${JSON.stringify(e.data)}`);
    return lines.join('\n') + '\n\n';
  });
  return encoder.encode(chunks.join(''));
}

describe('extractInBackground 端到端测试', () => {
  it('应该解析 Anthropic SSE 流', async () => {
    // 模拟 Anthropic SSE 流
    const events = [
      {
        event: 'message_start',
        data: {
          type: 'message_start',
          message: {
            id: 'msg_123',
            type: 'message',
            role: 'assistant',
            model: 'claude-3-opus-20240229',
            usage: { input_tokens: 100 },
          },
        },
      },
      {
        event: 'content_block_start',
        data: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        },
      },
      {
        event: 'content_block_delta',
        data: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Hello' },
        },
      },
      {
        event: 'content_block_delta',
        data: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: ' world' },
        },
      },
      {
        event: 'message_delta',
        data: {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: { output_tokens: 50 },
        },
      },
    ];

    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(encodeSSE(events));
        controller.close();
      },
    });

    const entry: LogEntry = {
      id: 'test_1',
      timestamp: new Date().toISOString(),
      project: 'test',
      url: 'https://api.anthropic.com/v1/messages',
      method: 'POST',
      headers: {},
      body: null,
      response: null,
      duration: 100,
      isStream: true,
      mainAgent: true,
    };

    await extractInBackground(body, entry,
      (_e) => { /* no-op */ },
      () => { /* no-op */ },
    );

    // 新架构：response.body 是 SSERawBody，用 extractFromEntry 提取结构化信息
    const extracted = extractFromEntry(entry);
    expect(entry.response?.body.type).toBe('sse_raw');
    expect(extracted.model).toBe('claude-3-opus-20240229');
    expect(extracted.text).toBe('Hello world');
    expect(extracted.stopReason).toBe('end_turn');
    expect(extracted.usage.input).toBe(100);
    expect(extracted.usage.output).toBe(50);
  });

  it('应该解析 OpenAI Chat SSE 流', async () => {
    // 模拟 OpenAI Chat SSE 流
    const events = [
      {
        data: {
          id: 'chatcmpl_123',
          object: 'chat.completion.chunk',
          model: 'gpt-4',
          choices: [{ index: 0, delta: { content: 'Hello' } }],
        },
      },
      {
        data: {
          id: 'chatcmpl_123',
          object: 'chat.completion.chunk',
          model: 'gpt-4',
          choices: [{ index: 0, delta: { content: ' world' } }],
        },
      },
      {
        data: {
          id: 'chatcmpl_123',
          object: 'chat.completion.chunk',
          model: 'gpt-4',
          choices: [{ index: 0, finish_reason: 'stop' }],
          usage: { prompt_tokens: 100, completion_tokens: 50 },
        },
      },
    ];

    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(encodeSSE(events));
        controller.close();
      },
    });

    const entry: LogEntry = {
      id: 'test_2',
      timestamp: new Date().toISOString(),
      project: 'test',
      url: 'https://api.openai.com/v1/chat/completions',
      method: 'POST',
      headers: {},
      body: null,
      response: null,
      duration: 100,
      isStream: true,
      mainAgent: true,
    };

    await extractInBackground(body, entry,
      (_e) => { /* no-op */ },
      () => { /* no-op */ },
    );

    // 新架构：使用 extractFromEntry 提取结构化信息
    const extracted = extractFromEntry(entry);
    expect(extracted.text).toBe('Hello world');
    expect(extracted.stopReason).toBe('stop');
    expect(extracted.usage.input).toBe(100);
    expect(extracted.usage.output).toBe(50);
  });

  it('应该解析包含 tool_calls 的 SSE 流', async () => {
    // 模拟带工具调用的 Anthropic SSE 流
    const events = [
      {
        event: 'message_start',
        data: {
          type: 'message_start',
          message: {
            id: 'msg_123',
            type: 'message',
            role: 'assistant',
            model: 'claude-3-opus-20240229',
            usage: { input_tokens: 100 },
          },
        },
      },
      {
        event: 'content_block_start',
        data: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu_123', name: 'bash' },
        },
      },
      {
        event: 'content_block_delta',
        data: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"command": ' },
        },
      },
      {
        event: 'content_block_delta',
        data: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '"ls"}' },
        },
      },
      {
        event: 'message_delta',
        data: {
          type: 'message_delta',
          delta: { stop_reason: 'tool_use' },
          usage: { output_tokens: 50 },
        },
      },
    ];

    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(encodeSSE(events));
        controller.close();
      },
    });

    const entry: LogEntry = {
      id: 'test_4',
      timestamp: new Date().toISOString(),
      project: 'test',
      url: 'https://api.anthropic.com/v1/messages',
      method: 'POST',
      headers: {},
      body: null,
      response: null,
      duration: 100,
      isStream: true,
      mainAgent: true,
    };

    await extractInBackground(body, entry,
      (_e) => { /* no-op */ },
      () => { /* no-op */ },
    );

    // 新架构：使用 extractFromEntry 提取结构化信息
    const extracted = extractFromEntry(entry);
    // toolCalls 数组中的元素隐含 type='tool_use'
    expect(extracted.toolCalls[0].name).toBe('bash');
    expect(extracted.toolCalls[0].input).toEqual({ command: 'ls' });
    expect(extracted.stopReason).toBe('tool_use');
  });
});