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

// ==================== 系统提示词多段还原（N 段不再 join 成 1 段，TAE-90） ====================
//
// 三协议统一按「段」口径：Anthropic system 数组逐 text block 一段；OpenAI Chat 逐 system 消息一段
// （修原先只留首条、后面 continue 丢弃的 bug）；Responses instructions 单段。单段/字符串不回归。

describe('extractors — 系统提示词按段保留，不 join', () => {
  it('extractAnthropicMessages：body.system 多 text block → 每段一个元素（保序、不拼接）', () => {
    const ctx = extractAnthropicMessages({
      system: [
        { type: 'text', text: 'seg-A' },
        { type: 'text', text: 'seg-B', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 'seg-C', cache_control: { type: 'ephemeral' } },
      ],
      messages: [{ role: 'user', content: 'hi' }],
    });
    // 3 段就是 3 个元素，原文不拼接（无 '\n'）
    expect(ctx?.systemPrompt).toEqual(['seg-A', 'seg-B', 'seg-C']);
    expect(ctx?.systemPrompt?.join('')).toBe('seg-Aseg-Bseg-C');
  });

  it('extractAnthropicMessages：body.system 是字符串 → 单段数组（反向：不回归）', () => {
    const ctx = extractAnthropicMessages({
      system: 'only-segment',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(ctx?.systemPrompt).toEqual(['only-segment']);
  });

  it('extractAnthropicMessages：body.system 数组只含非 text block → undefined', () => {
    const ctx = extractAnthropicMessages({
      system: [{ type: 'image', source: {} }],
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(ctx?.systemPrompt).toBeUndefined();
  });

  it('extractOpenAIChat：多条 system 消息全保留（修原先第 2 条起被丢弃的 bug）', () => {
    const ctx = extractOpenAIChat({
      messages: [
        { role: 'system', content: 'sys-1' },
        { role: 'system', content: 'sys-2' },
        { role: 'user', content: 'hello' },
      ],
    });
    // 两条 system 消息各成一段，保序
    expect(ctx?.systemPrompt).toEqual(['sys-1', 'sys-2']);
    // system 消息不混入对话历史
    expect(ctx?.messages).toHaveLength(1);
    expect(ctx?.messages[0].role).toBe('user');
  });

  it('extractOpenAIChat：单条 system 消息（数组 content）→ 单段，段内 block join', () => {
    const ctx = extractOpenAIChat({
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] },
        { role: 'user', content: 'hi' },
      ],
    });
    // 一条 system 消息 = 一段，段内两个 text block join 成 'a\nb'
    expect(ctx?.systemPrompt).toEqual(['a\nb']);
  });

  it('extractOpenAIChat：无 system 消息 → systemPrompt undefined（反向）', () => {
    const ctx = extractOpenAIChat({
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(ctx?.systemPrompt).toBeUndefined();
  });

  it('extractOpenAIResponses：instructions 字符串 → 单段数组', () => {
    const ctx = extractOpenAIResponses({
      instructions: 'be helpful',
      input: [{ role: 'user', content: 'hi' }],
    });
    expect(ctx?.systemPrompt).toEqual(['be helpful']);
  });

  // 端到端分发：URL 命中 anthropic → 走 anthropic extractor，多段口径一致。
  it('extractContext(anthropic-messages)：3 段 system → 3 个元素', () => {
    const ctx = extractContext(
      {
        system: [
          { type: 'text', text: 's1' },
          { type: 'text', text: 's2', cache_control: { type: 'ephemeral' } },
          { type: 'text', text: 's3', cache_control: { type: 'ephemeral' } },
        ],
        messages: [{ role: 'user', content: 'hi' }],
      },
      'https://api.anthropic.com/v1/messages',
    );
    expect(ctx?.systemPrompt).toEqual(['s1', 's2', 's3']);
  });
});
