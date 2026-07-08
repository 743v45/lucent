/**
 * token-bucket 分类单测（TTFT 口径单源）
 *
 * 校验 classifySSEEventTokenBucket 对三协议（anthropic-messages / openai-chat /
 * openai-responses）的「思考 token / 回答 token」判定口径，与 stream-timing spec 对齐。
 * 生命周期/结构事件、工具调用 delta、refusal、空内容首 chunk 一律 neither。
 */

import { describe, it, expect } from 'vitest';
import { classifySSEEventTokenBucket } from '../shared/sse-events.js';
import type { ProtocolId } from '../shared/protocols.js';

const NONE = { thinking: false, answer: false };

describe('classifySSEEventTokenBucket — anthropic-messages', () => {
  const ep: ProtocolId | null = 'anthropic-messages';
  const ev = (type: string, delta: Record<string, unknown> = {}) =>
    classifySSEEventTokenBucket('content_block_delta', { delta: { type, ...delta } }, ep);

  it('thinking_delta 非空 → thinking', () => {
    expect(ev('thinking_delta', { thinking: 'hm' })).toEqual({ thinking: true, answer: false });
  });
  it('text_delta 非空 → answer', () => {
    expect(ev('text_delta', { text: 'H' })).toEqual({ thinking: false, answer: true });
  });
  it('thinking_delta 空 → neither', () => {
    expect(ev('thinking_delta', { thinking: '' })).toEqual(NONE);
  });
  it('text_delta 空 → neither', () => {
    expect(ev('text_delta', { text: '' })).toEqual(NONE);
  });
  it('input_json_delta（工具参数）→ neither', () => {
    expect(ev('input_json_delta', { partial_json: '{"a":' })).toEqual(NONE);
  });
  it('signature_delta → neither', () => {
    expect(ev('signature_delta', { signature: 'x' })).toEqual(NONE);
  });
  it('生命周期/结构事件 → neither', () => {
    expect(classifySSEEventTokenBucket('message_start', { message: {} }, ep)).toEqual(NONE);
    expect(classifySSEEventTokenBucket('content_block_start', { content_block: { type: 'text' } }, ep)).toEqual(NONE);
    expect(classifySSEEventTokenBucket('content_block_stop', {}, ep)).toEqual(NONE);
    expect(classifySSEEventTokenBucket('message_delta', { delta: { stop_reason: 'end_turn' } }, ep)).toEqual(NONE);
  });
});

describe('classifySSEEventTokenBucket — openai-chat', () => {
  const ep: ProtocolId | null = 'openai-chat';
  const chunk = (delta: Record<string, unknown>) =>
    classifySSEEventTokenBucket('', { choices: [{ delta }] }, ep);

  it('reasoning_content 非空 → thinking', () => {
    expect(chunk({ reasoning_content: 'r' })).toEqual({ thinking: true, answer: false });
  });
  it('reasoning 非空 → thinking', () => {
    expect(chunk({ reasoning: 'r' })).toEqual({ thinking: true, answer: false });
  });
  it('content 非空 → answer', () => {
    expect(chunk({ content: 'Hi' })).toEqual({ thinking: false, answer: true });
  });
  it('同时有 reasoning + content → 两桶都 true', () => {
    expect(chunk({ reasoning: 'r', content: 'H' })).toEqual({ thinking: true, answer: true });
  });
  it('空 content 的 role 首 chunk → neither', () => {
    expect(chunk({ role: 'assistant' })).toEqual(NONE);
    expect(chunk({ content: '' })).toEqual(NONE);
  });
  it('tool_calls → neither', () => {
    expect(chunk({ tool_calls: [{ index: 0, function: { name: 'f' } }] })).toEqual(NONE);
  });
  it('refusal → neither', () => {
    expect(chunk({ refusal: 'no' })).toEqual(NONE);
  });
  it('无 choices → neither', () => {
    expect(classifySSEEventTokenBucket('', { usage: {} }, ep)).toEqual(NONE);
  });
});

describe('classifySSEEventTokenBucket — openai-responses', () => {
  const ep: ProtocolId | null = 'openai-responses';
  const evt = (type: string, data: Record<string, unknown> = {}) =>
    classifySSEEventTokenBucket('', { type, ...data }, ep);

  it('response.output_text.delta 非空 → answer', () => {
    expect(evt('response.output_text.delta', { delta: 'H' })).toEqual({ thinking: false, answer: true });
  });
  it('response.text.delta 非空 → answer（兼容变体）', () => {
    expect(evt('response.text.delta', { delta: 'H' })).toEqual({ thinking: false, answer: true });
  });
  it('response.reasoning.delta 非空 → thinking', () => {
    expect(evt('response.reasoning.delta', { delta: 'r' })).toEqual({ thinking: true, answer: false });
  });
  it('response.reasoning_text.delta 非空 → thinking（慧星云兼容）', () => {
    expect(evt('response.reasoning_text.delta', { delta: 'r' })).toEqual({ thinking: true, answer: false });
  });
  it('response.reasoning_summary_text.delta 非空 → thinking', () => {
    expect(evt('response.reasoning_summary_text.delta', { delta: 'r' })).toEqual({ thinking: true, answer: false });
  });
  it('delta 空 → neither', () => {
    expect(evt('response.output_text.delta', { delta: '' })).toEqual(NONE);
    expect(evt('response.reasoning.delta', { delta: '' })).toEqual(NONE);
  });
  it('生命周期事件 → neither', () => {
    expect(evt('response.created')).toEqual(NONE);
    expect(evt('response.in_progress')).toEqual(NONE);
    expect(evt('response.queued')).toEqual(NONE);
    expect(evt('response.output_item.added')).toEqual(NONE);
    expect(evt('response.content_part.added')).toEqual(NONE);
    expect(evt('response.completed', { response: { usage: {} } })).toEqual(NONE);
  });
  it('工具调用 / refusal delta → neither', () => {
    expect(evt('response.function_call_arguments.delta', { delta: '{', call_id: 'c' })).toEqual(NONE);
    expect(evt('response.mcp_call_arguments.delta', { delta: '{', call_id: 'c' })).toEqual(NONE);
    expect(evt('response.refusal.delta', { delta: 'no' })).toEqual(NONE);
  });
});

describe('classifySSEEventTokenBucket — endpointType 缺省（结构 fallback）', () => {
  it('anthropic 结构事件在 null 下仍识别', () => {
    expect(classifySSEEventTokenBucket('content_block_delta', { delta: { type: 'text_delta', text: 'H' } }, null))
      .toEqual({ thinking: false, answer: true });
  });
  it('chat choices 在 null 下仍识别', () => {
    expect(classifySSEEventTokenBucket('', { choices: [{ delta: { content: 'H' } }] }, null))
      .toEqual({ thinking: false, answer: true });
  });
  it('responses type 在 null 下仍识别', () => {
    expect(classifySSEEventTokenBucket('', { type: 'response.output_text.delta', delta: 'H' }, null))
      .toEqual({ thinking: false, answer: true });
  });
});
