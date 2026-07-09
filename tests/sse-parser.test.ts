/**
 * SSE 流解析测试
 *
 * 测试 eventsource-parser 的 extractFromEvent 函数
 */

import { describe, it, expect } from 'vitest';
import { extractFromEvent, ExtractedInfo } from '../server/sse-extractor.js';

// 创建空的 ExtractedInfo 初始值
function createEmptyExtractedInfo(): ExtractedInfo {
  return {
    text: '',
    thinking: '',
    toolCalls: [],
    usage: { input: 0, output: 0, cache_read: 0, cache_create: 0 },
    stopReason: '',
    model: '',
  };
}

describe('extractFromEvent', () => {
  describe('Anthropic 格式', () => {
    it('应该解析 message_start 事件', () => {
      const acc = createEmptyExtractedInfo();
      const data = {
        type: 'message_start',
        message: {
          id: 'msg_123',
          type: 'message',
          role: 'assistant',
          model: 'claude-3-opus-20240229',
          usage: {
            input_tokens: 100,
            cache_creation_input_tokens: 50,
            cache_read_input_tokens: 20,
          },
        },
      };

      extractFromEvent('message_start', data, acc);

      expect(acc.model).toBe('claude-3-opus-20240229');
      expect(acc.usage.input).toBe(100);
      expect(acc.usage.cache_create).toBe(50);
      expect(acc.usage.cache_read).toBe(20);
    });

    it('应该解析 content_block_delta 文本事件', () => {
      const acc = createEmptyExtractedInfo();
      acc.text = 'Hello';

      const data = {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: ' world' },
      };

      extractFromEvent('content_block_delta', data, acc);

      expect(acc.text).toBe('Hello world');
    });

    it('应该解析 content_block_delta thinking 事件', () => {
      const acc = createEmptyExtractedInfo();

      const data = {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'thinking_delta', thinking: 'Let me think...' },
      };

      extractFromEvent('content_block_delta', data, acc);

      expect(acc.thinking).toBe('Let me think...');
    });

    it('应该解析 content_block_start tool_use 事件', () => {
      const acc = createEmptyExtractedInfo();

      const data = {
        type: 'content_block_start',
        index: 2,
        content_block: {
          type: 'tool_use',
          id: 'toolu_123',
          name: 'bash',
        },
      };

      extractFromEvent('content_block_start', data, acc);

      expect(acc.toolCalls.length).toBe(1);
      expect(acc.toolCalls[0].id).toBe('toolu_123');
      expect(acc.toolCalls[0].name).toBe('bash');
    });

    it('应该解析 message_delta 事件', () => {
      const acc = createEmptyExtractedInfo();
      acc.usage.input = 100;

      const data = {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 50 },
      };

      extractFromEvent('message_delta', data, acc);

      expect(acc.stopReason).toBe('end_turn');
      expect(acc.usage.output).toBe(50);
    });
  });

  describe('OpenAI Chat 格式', () => {
    it('应该解析 delta content 事件', () => {
      const acc = createEmptyExtractedInfo();
      acc.text = 'Hello';

      const data = {
        choices: [
          {
            delta: { content: ' world' },
          },
        ],
      };

      extractFromEvent('', data, acc);

      expect(acc.text).toBe('Hello world');
    });

    it('应该解析 finish_reason 事件', () => {
      const acc = createEmptyExtractedInfo();

      const data = {
        choices: [
          {
            finish_reason: 'stop',
          },
        ],
      };

      extractFromEvent('', data, acc);

      expect(acc.stopReason).toBe('stop');
    });

    it('应该解析 usage 事件', () => {
      const acc = createEmptyExtractedInfo();

      const data = {
        choices: [],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 50,
          prompt_tokens_details: { cached_tokens: 20 },
        },
      };

      extractFromEvent('', data, acc);

      expect(acc.usage.input).toBe(100);
      expect(acc.usage.output).toBe(50);
      expect(acc.usage.cache_read).toBe(20);
    });

    it('应该解析 tool_calls 事件', () => {
      const acc = createEmptyExtractedInfo();

      const data1 = {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_123',
                  function: { name: 'bash' },
                },
              ],
            },
          },
        ],
      };

      const data2 = {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: { arguments: '{"command": "ls"}' },
                },
              ],
            },
          },
        ],
      };

      extractFromEvent('', data1, acc);
      extractFromEvent('', data2, acc);

      expect(acc.toolCalls.length).toBe(1);
      expect(acc.toolCalls[0].id).toBe('call_123');
      expect(acc.toolCalls[0].name).toBe('bash');
      expect(acc.toolCalls[0].input).toBe('{"command": "ls"}');
    });
  });

  describe('OpenAI Responses API 格式', () => {
    it('应该解析 response.output_text.delta 事件', () => {
      const acc = createEmptyExtractedInfo();
      acc.text = 'Hello';

      const data = {
        type: 'response.output_text.delta',
        delta: ' world',
      };

      extractFromEvent('', data, acc);

      expect(acc.text).toBe('Hello world');
    });

    it('应该解析 response.completed 事件', () => {
      const acc = createEmptyExtractedInfo();

      const data = {
        type: 'response.completed',
        response: {
          usage: {
            input_tokens: 100,
            output_tokens: 50,
          },
        },
      };

      extractFromEvent('', data, acc);

      expect(acc.usage.input).toBe(100);
      expect(acc.usage.output).toBe(50);
    });

    it('response.completed 抽取 input_tokens_details.cached_tokens 为 cache_read（回归）', () => {
      // Responses 的 cache 命中在 input_tokens_details.cached_tokens（与 Chat 的 prompt_tokens_details 不同）。
      // 历史 bug：response.completed 只取 input/output，漏了 cached_tokens。
      const acc = createEmptyExtractedInfo();
      const data = {
        type: 'response.completed',
        response: {
          usage: {
            input_tokens: 1000,
            output_tokens: 50,
            input_tokens_details: { cached_tokens: 700 },
            output_tokens_details: { reasoning_tokens: 20 },
          },
        },
      };

      extractFromEvent('', data, acc);

      expect(acc.usage.input).toBe(1000);
      expect(acc.usage.output).toBe(50);
      expect(acc.usage.cache_read).toBe(700);
    });
  });
});