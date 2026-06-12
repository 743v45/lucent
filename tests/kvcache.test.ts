/**
 * KV-Cache 解析器单元测试
 *
 * 覆盖：extractCachedContent、getContextSizeForModel、parseModelBaseName
 */

import { describe, it, expect } from 'vitest';
import { extractCachedContent, getContextSizeForModel, parseModelBaseName } from '../server/kvcache.js';

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
    );
    expect(result.cacheCreateTokens).toBe(300);
    expect(result.cacheReadTokens).toBe(400);
    expect(result.totalCachedTokens).toBe(700);
    expect(result.hitRate).toBeGreaterThan(0);
  });

  it('提取带 cache_control 的 system blocks', () => {
    const body = {
      system: [
        { type: 'text', text: 'You are a helpful assistant.' },
        { type: 'text', text: 'Additional context.', cache_control: { type: 'ephemeral' } },
      ],
      messages: [],
    };
    const result = extractCachedContent(body);
    expect(result.system).toHaveLength(2);
    expect(result.system[0]).toBe('You are a helpful assistant.');
    expect(result.system[1]).toBe('Additional context.');
  });

  it('system 为字符串时不提取缓存', () => {
    const body = { system: 'Simple system prompt', messages: [] };
    const result = extractCachedContent(body);
    expect(result.system).toEqual([]);
  });

  it('提取带 cache_control 的消息', () => {
    const body = {
      messages: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: [{ type: 'text', text: 'Hi there', cache_control: { type: 'ephemeral' } }] },
      ],
    };
    const result = extractCachedContent(body);
    expect(result.messages.length).toBeGreaterThan(0);
    expect(result.messages).toContain('[user] Hello');
    expect(result.messages).toContain('[assistant] Hi there');
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

  it('命中率计算正确', () => {
    const result = extractCachedContent(
      { messages: [] },
      {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 50,
        cache_read_input_tokens: 100,
      },
    );
    // totalCachedTokens = 150, totalTokens = 100+50+150 = 300
    // hitRate = 150/300 * 100 = 50%
    expect(result.hitRate).toBe(50);
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

describe('parseModelBaseName', () => {
  it('标准格式', () => {
    expect(parseModelBaseName('claude-opus-4-20250514')).toBe('opus-4');
  });

  it('带日期后缀', () => {
    expect(parseModelBaseName('claude-sonnet-4-6-20250514')).toBe('sonnet-4-6');
  });

  it('空字符串', () => {
    expect(parseModelBaseName('')).toBe('unknown');
  });
});
