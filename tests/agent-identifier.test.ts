/**
 * Agent 识别模块单元测试
 *
 * 覆盖：isMainAgentRequest、parseAgentType、extractTokenUsage、identifyClient
 */

import { describe, it, expect } from 'vitest';
import { extractTokenUsage, identifyClient, calculateTokenPercentage } from '../server/agent-identifier.js';

// ==================== extractTokenUsage ====================

describe('extractTokenUsage', () => {
  it('Anthropic 非流式响应格式', () => {
    const body = {
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 20,
        cache_read_input_tokens: 30,
      },
    };
    const result = extractTokenUsage(body);
    expect(result).toEqual({
      input_tokens: 100,
      output_tokens: 50,
      cache_read_tokens: 30,
      cache_creation_tokens: 20,
    });
  });

  it('OpenAI Chat 响应格式', () => {
    const body = {
      usage: {
        prompt_tokens: 200,
        completion_tokens: 80,
        prompt_tokens_details: { cached_tokens: 50 },
      },
    };
    // extractTokenUsage 只读 input_tokens / output_tokens，不读 prompt_tokens
    const result = extractTokenUsage(body);
    expect(result).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: undefined,
      cache_creation_tokens: undefined,
    });
  });

  it('无 usage 字段返回 undefined', () => {
    expect(extractTokenUsage({})).toBeUndefined();
    expect(extractTokenUsage(null)).toBeUndefined();
    expect(extractTokenUsage(undefined)).toBeUndefined();
  });

  it('部分 usage 字段', () => {
    const body = { usage: { input_tokens: 50 } };
    const result = extractTokenUsage(body);
    expect(result).toEqual({
      input_tokens: 50,
      output_tokens: 0,
      cache_read_tokens: undefined,
      cache_creation_tokens: undefined,
    });
  });
});

// ==================== identifyClient ====================

describe('identifyClient', () => {
  it('Claude Code CLI', () => {
    expect(identifyClient({ 'user-agent': 'claude-code/1.0' })).toBe('claude-code');
    expect(identifyClient({ 'user-agent': 'Claude-CLI/2.0' })).toBe('claude-code');
    expect(identifyClient({ 'user-agent': 'claude/3.0' })).toBe('claude-code');
  });

  it('OpenCode', () => {
    expect(identifyClient({ 'user-agent': 'opencode/1.0' })).toBe('opencode');
    expect(identifyClient({ originator: 'OpenCode' })).toBe('opencode');
  });

  it('Codex CLI', () => {
    expect(identifyClient({ 'user-agent': 'codex/1.0' })).toBe('codex');
  });

  it('Cursor', () => {
    expect(identifyClient({ 'user-agent': 'cursor/1.0' })).toBe('cursor');
  });

  it('Windsurf', () => {
    expect(identifyClient({ 'user-agent': 'windsurf/1.0' })).toBe('windsurf');
  });

  it('Test client', () => {
    expect(identifyClient({ 'user-agent': 'test-client' })).toBe('test-client');
    expect(identifyClient({ 'user-agent': 'lucent-test' })).toBe('test-client');
  });

  it('Unknown', () => {
    expect(identifyClient({ 'user-agent': 'Mozilla/5.0' })).toBe('unknown');
    expect(identifyClient({})).toBe('unknown');
  });

  it('OpenCode 优先于 Claude（有 originator header）', () => {
    // OpenCode 可能 UA 里也有 claude，但 originator 更准确
    expect(identifyClient({
      'user-agent': 'claude-code/1.0',
      originator: 'opencode',
    })).toBe('opencode');
  });
});

// ==================== calculateTokenPercentage ====================

describe('calculateTokenPercentage', () => {
  it('正常计算', () => {
    const result = calculateTokenPercentage(100, 50, 50);
    expect(result.inputPercent).toBe(50);
    expect(result.outputPercent).toBe(25);
    expect(result.cachePercent).toBe(25);
  });

  it('总 token 为 0 返回 0', () => {
    const result = calculateTokenPercentage(0, 0);
    expect(result.inputPercent).toBe(0);
    expect(result.outputPercent).toBe(0);
    expect(result.cachePercent).toBeUndefined();
  });

  it('无 cacheRead 时 cachePercent 为 undefined', () => {
    const result = calculateTokenPercentage(100, 50);
    expect(result.cachePercent).toBeUndefined();
  });
});
