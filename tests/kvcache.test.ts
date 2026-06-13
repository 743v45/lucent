/**
 * KV-Cache 解析器单元测试
 *
 * 覆盖：extractCachedContent、getContextSizeForModel、parseModelBaseName
 */

import { describe, it, expect } from 'vitest';
import { extractCachedContent, getContextSizeForModel } from '../server/kvcache.js';

// ==================== extractCachedContent ====================

describe('extractCachedContent', () => {
  it('空 body 返回零值', () => {
    const result = extractCachedContent(null as any);
    expect(result.totalCachedTokens).toBe(0);
    expect(result.cacheCreateTokens).toBe(0);
    expect(result.cacheReadTokens).toBe(0);
    expect(result.hitRate).toBe(0);
    expect(result.system).toEqual([]);
    expect(result.messages).toEqual([]);
    expect(result.tools).toEqual([]);
  });

  it('无 usage 时 token 数据为 0', () => {
    const result = extractCachedContent({ messages: [] });
    expect(result.totalCachedTokens).toBe(0);
    expect(result.hitRate).toBe(0);
  });

  it('提取 Anthropic usage 缓存 token', () => {
    const result = extractCachedContent(
      { messages: [] },
      {
        input_tokens: 1000,
        output_tokens: 200,
        cache_creation_input_tokens: 300,
        cache_read_input_tokens: 400,
      },
      { endpointType: 'anthropic-messages' },
    );
    expect(result.cacheCreateTokens).toBe(300);
    expect(result.cacheReadTokens).toBe(400);
    expect(result.totalCachedTokens).toBe(700);
    // 修正口径：read/totalInput = 400/1700 ≈ 24%
    expect(result.hitRate).toBeGreaterThan(0);
    expect(result.totalInputTokens).toBe(1700);
    expect(result.uncachedInputTokens).toBe(1000);
    expect(result.cacheMode).toBe('none');
    expect(result.provider).toBe('anthropic');
    // read>0 → hit
    expect(result.status).toBe('hit');
  });

  it('提取带 cache_control 的 system blocks', () => {
    const body = {
      system: [
        { type: 'text', text: 'You are a helpful assistant.' },
        { type: 'text', text: 'Additional context.', cache_control: { type: 'ephemeral' } },
      ],
      messages: [],
    };
    const result = extractCachedContent(body, undefined, { endpointType: 'anthropic-messages' });
    expect(result.system).toHaveLength(2);
    expect(result.system[0].text).toBe('You are a helpful assistant.');
    expect(result.system[1].text).toBe('Additional context.');
    // explicit 模式：block 带 tokens 与 kind
    expect(result.system[0].tokens).toBe(Math.max(1, Math.round('You are a helpful assistant.'.length / 4)));
    expect(result.cacheMode).toBe('explicit');
    expect(result.provider).toBe('anthropic');
  });

  it('system 为字符串时不提取缓存', () => {
    const body = { system: 'Simple system prompt', messages: [] };
    const result = extractCachedContent(body);
    expect(result.system).toEqual([]);
  });

  it('estimateTokens 对中文文本不再低估（CJK 权重高于 length/4）', () => {
    const chinese = '你好世界，这是一段用于测试中文 token 估算的文本内容';
    const body = {
      system: [{ type: 'text', text: chinese, cache_control: { type: 'ephemeral' } }],
      messages: [],
    };
    const result = extractCachedContent(body, undefined, { endpointType: 'anthropic-messages' });
    const oldLengthBasedEstimate = Math.max(1, Math.round(chinese.length / 4));
    // CJK 字符应按更高权重估算，结果须显著高于纯 length/4
    expect(result.system[0].tokens).toBeGreaterThan(oldLengthBasedEstimate);
  });

  it('提取带 cache_control 的消息', () => {
    const body = {
      messages: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: [{ type: 'text', text: 'Hi there', cache_control: { type: 'ephemeral' } }] },
      ],
    };
    const result = extractCachedContent(body, undefined, { endpointType: 'anthropic-messages' });
    expect(result.messages.length).toBeGreaterThan(0);
    const texts = result.messages.map(b => b.text);
    expect(texts).toContain('[user] Hello');
    expect(texts).toContain('[assistant] Hi there');
  });

  it('无 cache_control 的消息不提取', () => {
    const body = {
      messages: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there' },
      ],
    };
    const result = extractCachedContent(body);
    expect(result.messages).toEqual([]);
  });

  it('工具只在 system 有缓存时才被提取', () => {
    // 无 system 缓存 → 工具不提取
    const noSystemCache = {
      messages: [],
      tools: [{ name: 'bash', description: 'Run commands' }],
    };
    expect(extractCachedContent(noSystemCache).tools).toEqual([]);

    // 有 system 缓存 → 工具被提取
    const withSystemCache = {
      system: [
        { type: 'text', text: 'System', cache_control: { type: 'ephemeral' } },
      ],
      messages: [],
      tools: [{ name: 'bash', description: 'Run commands' }],
    };
    const result = extractCachedContent(withSystemCache);
    expect(result.tools.length).toBeGreaterThan(0);
  });

  it('工具自身带 cache_control 时即使 system 无缓存也提取', () => {
    const body = {
      system: [{ type: 'text', text: 'System without cache marker' }],
      messages: [],
      tools: [
        { name: 'bash', description: 'Run commands', cache_control: { type: 'ephemeral' } },
      ],
    };
    const result = extractCachedContent(body, undefined, { endpointType: 'anthropic-messages' });
    expect(result.cacheMode).toBe('explicit');
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].text).toContain('bash');
  });

  it('命中率计算正确（修正口径：命中读 / 总输入）', () => {
    const result = extractCachedContent(
      { messages: [] },
      {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 50,
        cache_read_input_tokens: 100,
      },
      { endpointType: 'anthropic-messages' },
    );
    // 修正口径：totalInputTokens = 100 + 50 + 100 = 250（不含 output）
    // hitRate = cacheRead / totalInput = 100 / 250 = 40%
    expect(result.totalInputTokens).toBe(250);
    expect(result.hitRate).toBe(40);
    expect(result.uncachedInputTokens).toBe(100);
  });

  it('OpenAI 自动缓存：cached_tokens 当作 read', () => {
    const result = extractCachedContent(
      { messages: [] },
      {
        prompt_tokens: 1000,
        prompt_tokens_details: { cached_tokens: 600 },
        completion_tokens: 200,
      },
      { endpointType: 'openai-chat' },
    );
    expect(result.provider).toBe('openai');
    expect(result.cacheMode).toBe('auto');
    // OpenAI 无 create 概念，cached 全算 read
    expect(result.cacheReadTokens).toBe(600);
    expect(result.cacheCreateTokens).toBe(0);
    expect(result.totalCachedTokens).toBe(600);
    expect(result.totalInputTokens).toBe(1000);
    expect(result.uncachedInputTokens).toBe(400);
    // hitRate = 600/1000 = 60%
    expect(result.hitRate).toBe(60);
    // read>0 → hit
    expect(result.status).toBe('hit');
  });

  it('OpenAI Responses API 同样走 auto 模式', () => {
    const result = extractCachedContent(
      { messages: [] },
      { prompt_tokens: 500, prompt_tokens_details: { cached_tokens: 0 } },
      { endpointType: 'openai-responses' },
    );
    expect(result.cacheMode).toBe('auto');
    expect(result.provider).toBe('openai');
    // read=0, create=0, mode!=none → no-data
    expect(result.status).toBe('no-data');
    expect(result.hitRate).toBe(0);
  });

  it('status 四态：first-create', () => {
    const result = extractCachedContent(
      { messages: [] },
      {
        input_tokens: 100,
        cache_creation_input_tokens: 200,
        cache_read_input_tokens: 0,
      },
      { endpointType: 'anthropic-messages' },
    );
    // create>0 且 read===0 → first-create
    expect(result.status).toBe('first-create');
    expect(result.hitRate).toBe(0);
    expect(result.totalInputTokens).toBe(300);
  });

  it('status 四态：unsupported（无缓存能力）', () => {
    const result = extractCachedContent(
      { messages: [] },
      { input_tokens: 100, output_tokens: 50 },
      // 未知 endpointType，无 cache_control 标记 → mode=none
    );
    expect(result.cacheMode).toBe('none');
    expect(result.provider).toBe('unknown');
    // read=0, create=0, mode=none → unsupported
    expect(result.status).toBe('unsupported');
  });

  it('explicit 模式下 block.kind 正确判定', () => {
    // 首次写入场景：create>0, read===0 → kind=create
    const firstWrite = extractCachedContent(
      {
        system: [{ type: 'text', text: 'cached sys', cache_control: { type: 'ephemeral' } }],
        messages: [],
      },
      { input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 0 },
      { endpointType: 'anthropic-messages' },
    );
    expect(firstWrite.system[0].kind).toBe('create');
    expect(firstWrite.status).toBe('first-create');

    // 命中场景：read>0 → kind=hit
    const hit = extractCachedContent(
      {
        system: [{ type: 'text', text: 'cached sys', cache_control: { type: 'ephemeral' } }],
        messages: [],
      },
      { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 30 },
      { endpointType: 'anthropic-messages' },
    );
    expect(hit.system[0].kind).toBe('hit');
    expect(hit.status).toBe('hit');
  });
});

// ==================== getContextSizeForModel ====================

describe('getContextSizeForModel', () => {
  it('Opus 模型返回 1M 上下文', () => {
    expect(getContextSizeForModel('claude-opus-4-20250514')).toBe(1_000_000);
    expect(getContextSizeForModel('claude-opus-4-6-20250514')).toBe(1_000_000);
  });

  it('Sonnet-4 模型返回 1M 上下文', () => {
    expect(getContextSizeForModel('claude-sonnet-4-20250514')).toBe(1_000_000);
  });

  it('Sonnet 3.5 模型返回 200K 上下文', () => {
    expect(getContextSizeForModel('claude-3-5-sonnet-20241022')).toBe(200_000);
  });

  it('Haiku 模型返回 200K 上下文', () => {
    expect(getContextSizeForModel('claude-haiku-4-5-20251001')).toBe(200_000);
  });

  it('空模型名返回 200K', () => {
    expect(getContextSizeForModel('')).toBe(200_000);
  });

  it('非 Claude 模型返回 200K', () => {
    expect(getContextSizeForModel('gpt-4o')).toBe(200_000);
  });

  it('Mythos 模型返回 1M', () => {
    expect(getContextSizeForModel('claude-mythos-5')).toBe(1_000_000);
  });
});

// ==================== parseModelBaseName ====================
// 已删除：parseModelBaseName 为死代码（无生产调用），随函数一并清理
