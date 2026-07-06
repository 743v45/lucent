/**
 * context-extractors 单元测试
 *
 * 锁定契约：三个协议 extractor 产出的 messages[*].content MUST 满足
 * `string | ContentBlock[]`，不得透传 null / undefined。
 *
 * 背景：OpenAI Chat 的 assistant 消息发起 tool_calls 时 content === null，
 * 原样透传到前端 ContextTab 会让 .map() 崩溃（白屏）。
 * 见 openspec change 2026-06-18-fix-context-content-null。
 */

import { describe, it, expect } from 'vitest';
import {
  extractContext,
  extractAnthropicMessages,
  extractOpenAIChat,
  extractOpenAIResponses,
} from '../server/context-extractors.js';

// ==================== content 归一化契约（防白屏回归） ====================

describe('extractors — content MUST be string | ContentBlock[], never null/undefined', () => {
  it('extractAnthropicMessages：content === null 归一化为 []', () => {
    const ctx = extractAnthropicMessages({
      messages: [{ role: 'assistant', content: null, tool_calls: [] }],
    });
    expect(ctx?.messages[0].content).toEqual([]);
  });

  it('extractAnthropicMessages：content === undefined 归一化为 []', () => {
    const ctx = extractAnthropicMessages({
      messages: [{ role: 'assistant' }],
    });
    expect(ctx?.messages[0].content).toEqual([]);
  });

  it('extractOpenAIChat：assistant content === null（tool_calls 回合）归一化为 []', () => {
    const ctx = extractOpenAIChat({
      messages: [
        { role: 'user', content: '查天气' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{}' } }] },
      ],
    });
    expect(ctx?.messages[1].content).toEqual([]);
  });

  it('extractOpenAIChat：content === undefined 归一化为 []', () => {
    const ctx = extractOpenAIChat({
      messages: [{ role: 'assistant' }],
    });
    expect(ctx?.messages[0].content).toEqual([]);
  });

  it('extractOpenAIResponses：input item content === null 归一化为 []', () => {
    const ctx = extractOpenAIResponses({
      input: [{ role: 'assistant', content: null }],
    });
    expect(ctx?.messages[0].content).toEqual([]);
  });

  it('extractOpenAIResponses：input item content === undefined 归一化为 []', () => {
    const ctx = extractOpenAIResponses({
      input: [{ type: 'message', role: 'assistant' }],
    });
    expect(ctx?.messages[0].content).toEqual([]);
  });

  // 端到端路径：extractContext 按 URL 分发到对应 extractor，
  // 任意协议的 null content 都必须被归一化。
  it('extractContext(openai-chat)：assistant content === null 归一化为 []', () => {
    const ctx = extractContext(
      { messages: [{ role: 'assistant', content: null }] },
      'https://api.openai.com/v1/chat/completions',
    );
    expect(ctx?.messages[0].content).toEqual([]);
  });

  it('extractContext(openai-responses)：assistant content === null 归一化为 []', () => {
    const ctx = extractContext(
      { input: [{ role: 'assistant', content: null }] },
      'https://api.openai.com/v1/responses',
    );
    expect(ctx?.messages[0].content).toEqual([]);
  });
});

// ==================== 不破坏既有 happy path ====================

describe('extractors — happy path（正常 content 不受影响）', () => {
  it('extractOpenAIChat：字符串 content 原样保留', () => {
    const ctx = extractOpenAIChat({
      messages: [{ role: 'user', content: '你好' }],
    });
    expect(ctx?.messages[0].content).toBe('你好');
  });

  it('extractAnthropicMessages：数组 content 原样保留', () => {
    const ctx = extractAnthropicMessages({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    });
    expect(ctx?.messages[0].content).toEqual([{ type: 'text', text: 'hi' }]);
  });
});
