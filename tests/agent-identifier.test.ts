/**
 * Agent 识别模块单元测试
 *
 * 覆盖：classifyAgent、extractTokenUsage、identifyClient、calculateTokenPercentage
 */

import { describe, it, expect } from 'vitest';
import { classifyAgent, extractTokenUsage, identifyClient, calculateTokenPercentage } from '../server/agent-identifier.js';

// ==================== classifyAgent ====================
//
// 判据：system prompt 身份指纹（移植自 cc-viewer），与 messages 多轮性无关。
// fixture 取材自真实日志（~/.lucent/logs）采样的 system 前缀，确保判据对真实流量成立。

describe('classifyAgent', () => {
  describe('主 Agent', () => {
    it('Claude Code 主代理身份声明 → main（真实日志采样的标准 system）', () => {
      // 采自真实日志：318 条 main 中最常见的前缀
      const body = { system: "You are Claude Code, Anthropic's official CLI for Claude.\n\nYou are an interactive agent..." };
      expect(classifyAgent(body)).toBe('main');
    });

    it('Claude Code 主代理首请求（仅 1 条 user，无 assistant 历史）→ main', () => {
      // 修复的核心场景：旧判据因 messages.length < 2 误判为 sub
      const body = {
        system: "You are Claude Code, Anthropic's official CLI for Claude.",
        messages: [{ role: 'user', content: '帮我分析代码' }],
      };
      expect(classifyAgent(body)).toBe('main');
    });

    it('OpenAI 格式：system 在 messages[role=system] 内 → main', () => {
      const body = {
        messages: [
          { role: 'system', content: "You are Claude Code, Anthropic's official CLI for Claude." },
          { role: 'user', content: 'hello' },
        ],
        tools: [{ function: { name: 'Bash' } }],
      };
      expect(classifyAgent(body)).toBe('main');
    });

    it('Anthropic system 数组格式（[{type:text,text:...}]）→ main', () => {
      const body = {
        system: [{ type: 'text', text: 'You are Claude Code, official CLI.' }],
      };
      expect(classifyAgent(body)).toBe('main');
    });

    it('system 含裸「general-purpose agent」描述（Agent 工具类型枚举）→ main（回归：不误判为 specialist）', () => {
      // 采自真实日志：Claude Code 主代理 system 枚举 Agent 工具可用类型，
      // 描述里含「- general-purpose: General-purpose agent for ...」——裸串匹配会误伤，须锚定身份句式。
      const body = {
        system: "You are Claude Code, Anthropic's official CLI for Claude.\n\nAgent tool types:\n- general-purpose: General-purpose agent for research and multi-step tasks",
      };
      expect(classifyAgent(body)).toBe('main');
    });
  });

  describe('子 Agent（权威排除）', () => {
    it('cc_is_subagent=true 标记 → sub（cc 2.1.181+ 官方标记，即使含 Claude Code 身份也排除）', () => {
      const body = {
        system: 'You are Claude Code.\nsome-context cc_is_subagent=true;\nmore',
      };
      expect(classifyAgent(body)).toBe('sub');
    });

    it('cc_is_subagent=true 词界锚定：=truex 不误匹配', () => {
      const body = { system: 'You are Claude Code.\ncc_is_subagent=truexyz' };
      expect(classifyAgent(body)).toBe('main');
    });

    it('teammate（同进程队友）→ sub', () => {
      const body = {
        system: 'You are Claude Code.\nrunning as an agent in a team',
      };
      expect(classifyAgent(body)).toBe('sub');
    });

    it('teammate（Agent Teammate Communication）→ sub', () => {
      const body = {
        system: 'You are Claude Code.\nAgent Teammate Communication protocol',
      };
      expect(classifyAgent(body)).toBe('sub');
    });

    it('specialist（command execution）→ sub', () => {
      const body = {
        system: 'You are Claude Code.\nYou are a command execution specialist',
      };
      expect(classifyAgent(body)).toBe('sub');
    });

    it('specialist（general-purpose agent）→ sub', () => {
      const body = {
        system: 'You are Claude Code.\nYou are a general-purpose agent',
      };
      expect(classifyAgent(body)).toBe('sub');
    });
  });

  describe('兜底（非 Claude Code 第三方请求按主代理处理）', () => {
    it('SDK 身份但无子代理标记（纯 You are a Claude agent）→ main', () => {
      // 非 Claude Code 身份、无 cc_is_subagent/teammate/specialist 标记 → 按主代理处理。
      // 注：真实 SDK 派生请求都带 specialist/billing 标记会走 sub；此处覆盖无标记的边界。
      const body = {
        system: 'x-anthropic-billing-header: cc_version=2.1.186.639; cc_entrypoint=sdk-cli;You are a Claude agent, built on Anthropic\'s Claude Agent SDK.\nYou are an interactive agent...',
      };
      expect(classifyAgent(body)).toBe('main');
    });

    it('无身份声明、有 tools → main（第三方请求先按主代理）', () => {
      const body = {
        system: 'some custom system prompt without identity',
        tools: [{ function: { name: 'Bash' } }, { function: { name: 'Edit' } }],
      };
      expect(classifyAgent(body)).toBe('main');
    });

    it('无 system、无 tools → main', () => {
      expect(classifyAgent({})).toBe('main');
    });

    it('null / 非对象 → main', () => {
      expect(classifyAgent(null)).toBe('main');
      expect(classifyAgent(undefined)).toBe('main');
    });

    it('无 system 但 messages 含 assistant 历史（旧判据靠此判 main）→ main', () => {
      // 非第三方会话续轮请求：无 Claude Code 身份声明，按主代理处理。
      const body = {
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'hello' },
        ],
      };
      expect(classifyAgent(body)).toBe('main');
    });

    it('OpenAI 格式第三方请求（空 system、首条 assistant tool_calls）→ main', () => {
      // 采自真实日志：Qwen 等通过 OpenAI 兼容端点的请求
      const body = {
        max_tokens: 64000,
        model: 'openai/unsloth/Qwen3.6-27B-MTP-GGUF',
        stream: true,
        messages: [
          { role: 'assistant', content: null, tool_calls: [{ function: { name: 'Bash', arguments: '{}' } }] },
          { role: 'tool', content: 'result' },
        ],
        tools: [{ function: { name: 'Bash' } }],
      };
      expect(classifyAgent(body)).toBe('main');
    });
  });
});

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
    // 兼容 OpenAI 非流式：input_tokens 取 prompt_tokens，output_tokens 取 completion_tokens，
    // cache_read_tokens 取 prompt_tokens_details.cached_tokens（Anthropic 字段缺失时回退）。
    const result = extractTokenUsage(body);
    expect(result).toEqual({
      input_tokens: 200,
      output_tokens: 80,
      cache_read_tokens: 50,
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
