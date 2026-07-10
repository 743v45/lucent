/**
 * log-reader.buildContextFromRequest 单元测试
 *
 * 重点：contextWindow 口径须与 KV-Cache 的 totalInputTokens 一致（含 cache tokens）
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { buildContextFromRequest, applyContextCache, invalidateCache } from '../server/services/log-reader.js';
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

  it('OpenAI Chat 非流式：tokenUsage 经归一化后 KV-Cache 命中数 / 上下文占比不再为 0（回归）', () => {
    // 复现生产链路：interceptor.extractTokenUsage → DB → reconstructEntry(tokenUsage) →
    // buildContextFromRequest 归一化成 input_tokens / cache_read_input_tokens → extractCachedContent。
    // 历史 bug：归一化键与 kvcache 的 OpenAI 分支读的键对不上，命中数 / totalInputTokens 全 0，
    // 进而 contextWindow 也不算。
    const log = {
      id: 'test-openai-chat-kvcache',
      timestamp: '2026-07-09T00:00:00.000Z',
      request: { method: 'POST', url: 'https://api.openai.com/v1/chat/completions', headers: {}, body: { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] } },
      response: { status: 200, statusText: 'OK', headers: {}, body: { usage: { prompt_tokens: 1000, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 600 } } } },
      agentType: 'main',
      duration: 0,
      metadata: { model: 'gpt-4o', provider: 'openai', stream: false },
      tokenUsage: { input_tokens: 1000, output_tokens: 200, cache_read_tokens: 600 },
      endpointType: 'openai-chat',
    } as unknown as LogEntry;

    buildContextFromRequest(log);

    expect(log.kvCache?.cacheReadTokens).toBe(600);
    expect(log.kvCache?.totalInputTokens).toBe(1000);
    expect(log.kvCache?.hitRate).toBe(60);
    expect(log.kvCache?.status).toBe('hit');
    // totalInputTokens>0 后上下文占比应被计算（历史 bug 下 contextWindow 缺失）
    expect(log.context?.contextWindow).toBeDefined();
    // totalTokens = totalInputTokens(1000) + output_tokens(200) = 1200
    expect(log.context?.contextWindow?.totalTokens).toBe(1200);
  });

  it('OpenAI 多轮 tool-use：assistant content:null 不原样透传（前端按数组解构会崩）', () => {
    const log = {
      id: 'test-null-content',
      timestamp: '2026-06-12T00:00:00.000Z',
      request: {
        method: 'POST',
        url: 'https://api.openai.com/v1/chat/completions',
        headers: {},
        body: {
          model: 'gpt-4o',
          messages: [
            { role: 'user', content: '东京天气？' },
            { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"location":"Tokyo"}' } }] },
            { role: 'tool', tool_call_id: 'call_1', content: '{"temp":23}' },
          ],
        },
      },
      response: { status: 200, statusText: 'OK', headers: {}, body: {} },
      agentType: 'main',
      duration: 0,
      metadata: { model: 'gpt-4o', provider: 'openai', stream: false },
      endpointType: 'openai-chat',
    } as unknown as LogEntry;

    buildContextFromRequest(log);

    const msgs = log.context!.messages!;
    // 三条消息都进 context，assistant 的 content 被规范成数组（非 null），前端可安全 .map
    expect(msgs).toHaveLength(3);
    const asst = msgs.find(m => m.role === 'assistant')!;
    expect(asst.content).toEqual([]);
    // tool 角色计入统计
    expect(log.context!.summary!.toolMessages).toBe(1);
  });
});

/**
 * buildContextFromRequest — 系统提示词多段还原（TAE-90）
 * context.systemPrompt 必须是 string[]（N 段就 N 个元素），systemPromptLength 按段总长（含 \n）算。
 */
describe('buildContextFromRequest — 系统提示词按段保留', () => {
  it('Anthropic body.system 多段 → context.systemPrompt 为数组、count=3、不拼接', () => {
    const log = {
      id: 'test-sys-multi',
      timestamp: '2026-07-10T00:00:00.000Z',
      request: {
        method: 'POST',
        url: 'https://api.anthropic.com/v1/messages',
        headers: {},
        body: {
          model: 'glm-5.2',
          system: [
            { type: 'text', text: 'seg-0' },
            { type: 'text', text: 'seg-1', cache_control: { type: 'ephemeral' } },
            { type: 'text', text: 'seg-2', cache_control: { type: 'ephemeral' } },
          ],
          messages: [{ role: 'user', content: 'hi' }],
        },
      },
      response: { status: 200, statusText: 'OK', headers: {}, body: {} },
      agentType: 'main',
      duration: 0,
      metadata: { model: 'glm-5.2', provider: 'claude', stream: false },
      endpointType: 'anthropic-messages',
    } as unknown as LogEntry;

    buildContextFromRequest(log);

    // 3 段就是 3 个元素，原文不拼接
    expect(log.context?.systemPrompt).toEqual(['seg-0', 'seg-1', 'seg-2']);
    // 段总长口径：'seg-0\nseg-1\nseg-2'.length = 18
    expect(log.context?.summary?.systemPromptLength).toBe('seg-0\nseg-1\nseg-2'.length);
  });

  it('Anthropic body.system 字符串 → 单段数组（反向：单段不回归）', () => {
    const log = {
      id: 'test-sys-single',
      timestamp: '2026-07-10T00:00:00.000Z',
      request: {
        method: 'POST',
        url: 'https://api.anthropic.com/v1/messages',
        headers: {},
        body: {
          model: 'glm-5.2',
          system: 'only-one-segment',
          messages: [{ role: 'user', content: 'hi' }],
        },
      },
      response: { status: 200, statusText: 'OK', headers: {}, body: {} },
      agentType: 'main',
      duration: 0,
      metadata: { model: 'glm-5.2', provider: 'claude', stream: false },
      endpointType: 'anthropic-messages',
    } as unknown as LogEntry;

    buildContextFromRequest(log);

    expect(log.context?.systemPrompt).toEqual(['only-one-segment']);
    expect(log.context?.summary?.systemPromptLength).toBe('only-one-segment'.length);
  });

  it('OpenAI Chat 多条 system 消息 → 多段（修原先只留首条的丢弃 bug）', () => {
    const log = {
      id: 'test-sys-chat',
      timestamp: '2026-07-10T00:00:00.000Z',
      request: {
        method: 'POST',
        url: 'https://api.openai.com/v1/chat/completions',
        headers: {},
        body: {
          model: 'gpt-4o',
          messages: [
            { role: 'system', content: 'sys-A' },
            { role: 'system', content: 'sys-B' },
            { role: 'user', content: 'hi' },
          ],
        },
      },
      response: { status: 200, statusText: 'OK', headers: {}, body: {} },
      agentType: 'main',
      duration: 0,
      metadata: { model: 'gpt-4o', provider: 'openai', stream: false },
      endpointType: 'openai-chat',
    } as unknown as LogEntry;

    buildContextFromRequest(log);

    expect(log.context?.systemPrompt).toEqual(['sys-A', 'sys-B']);
    // 两条 system 消息不混入对话历史（只留 user）
    expect(log.context?.messages).toHaveLength(1);
  });
});

/**
 * applyContextCache：读路径按 log.id 记忆提取结果。
 * 日志不可变 → 同 id 第二次读应命中缓存、贴回同一份 context/kvCache，不再重提。
 * 见 TAE-73（迁移后刷新页面重复触发上下文提取）。
 */
describe('applyContextCache — 提取结果记忆', () => {
  beforeEach(() => {
    invalidateCache();
  });

  function makeLog(id: string): LogEntry {
    return {
      id,
      timestamp: '2026-07-08T00:00:00.000Z',
      request: { method: 'POST', url: 'https://api.anthropic.com/v1/messages', headers: {}, body: { model: 'claude-3-5-sonnet-20241022', messages: [{ role: 'user', content: 'hi' }] } },
      response: { status: 200, statusText: 'OK', headers: {}, body: { usage: { input_tokens: 10, output_tokens: 5 } } },
      agentType: 'main',
      duration: 0,
      metadata: { model: 'claude-3-5-sonnet-20241022', provider: 'claude', stream: false },
      endpointType: 'anthropic-messages',
    } as unknown as LogEntry;
  }

  it('同 id 第二次读命中缓存：贴回同一份 context（不重提）', () => {
    const first = makeLog('cache-hit');
    applyContextCache(first);
    const firstContext = first.context;

    expect(firstContext).toBeDefined();

    // 第二个全新 entry，同 id —— 应直接贴缓存里的同一份 context
    const second = makeLog('cache-hit');
    applyContextCache(second);
    expect(second.context).toBe(firstContext);
    expect(second.kvCache).toBe(first.kvCache);
  });

  it('不同 id 互不影响，各自提取', () => {
    const a = makeLog('cache-a');
    const b = makeLog('cache-b');
    applyContextCache(a);
    applyContextCache(b);

    expect(a.context).toBeDefined();
    expect(b.context).toBeDefined();
    expect(a.context).not.toBe(b.context);
  });

  it('invalidateCache 后重新提取（得到新对象）', () => {
    const first = makeLog('cache-invalidate');
    applyContextCache(first);

    invalidateCache();

    const second = makeLog('cache-invalidate');
    applyContextCache(second);
    expect(second.context).not.toBe(first.context);
  });
});
