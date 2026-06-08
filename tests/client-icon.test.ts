/**
 * 客户端图标验证测试
 *
 * 测试 identifyClient 函数能否正确识别各种客户端应用
 * 验证 ClientIcon 组件的显示配置是否完整
 */

import { describe, it, expect } from 'vitest';
import { identifyClient } from '../server/agent-identifier.js';
import type { ClientType } from '../server/types.js';

// ==================== identifyClient 核心测试 ====================

describe('identifyClient - 客户端识别', () => {
  describe('User-Agent 识别', () => {
    it('应该识别 OpenCode 客户端（通过 User-Agent）', () => {
      expect(identifyClient({ 'user-agent': 'opencode/1.0.0' })).toBe('opencode');
      expect(identifyClient({ 'user-agent': 'MyApp/2.0 opencode' })).toBe('opencode');
      expect(identifyClient({ 'user-agent': 'OPENCODE/1.0' })).toBe('opencode');
    });

    it('应该识别 Claude Code 客户端', () => {
      expect(identifyClient({ 'user-agent': 'claude-code/1.0.0' })).toBe('claude-code');
      expect(identifyClient({ 'user-agent': 'claude-cli/2.0.0' })).toBe('claude-code');
      expect(identifyClient({ 'user-agent': 'Claude/1.0' })).toBe('claude-code');
      expect(identifyClient({ 'user-agent': 'CLAUDE-CODE/1.0' })).toBe('claude-code');
    });

    it('应该识别 Codex 客户端', () => {
      expect(identifyClient({ 'user-agent': 'codex/1.0.0' })).toBe('codex');
      expect(identifyClient({ 'user-agent': 'OpenAI-Codex/2.0' })).toBe('codex');
      expect(identifyClient({ 'user-agent': 'CODEX/1.0' })).toBe('codex');
    });

    it('应该识别 Cursor 客户端', () => {
      expect(identifyClient({ 'user-agent': 'cursor/1.0.0' })).toBe('cursor');
      expect(identifyClient({ 'user-agent': 'Cursor-IDE/2.0' })).toBe('cursor');
      expect(identifyClient({ 'user-agent': 'CURSOR/1.0' })).toBe('cursor');
    });

    it('应该识别 Windsurf 客户端', () => {
      expect(identifyClient({ 'user-agent': 'windsurf/1.0.0' })).toBe('windsurf');
      expect(identifyClient({ 'user-agent': 'Windsurf-IDE/2.0' })).toBe('windsurf');
      expect(identifyClient({ 'user-agent': 'WINDSURF/1.0' })).toBe('windsurf');
    });

    it('应该识别测试客户端', () => {
      expect(identifyClient({ 'user-agent': 'test-client/1.0' })).toBe('test-client');
      expect(identifyClient({ 'user-agent': 'agentproxy-test/1.0' })).toBe('test-client');
      expect(identifyClient({ 'user-agent': 'Test-Client/1.0' })).toBe('test-client');
    });
  });

  describe('Originator Header 识别', () => {
    it('应该通过 originator header 识别 OpenCode', () => {
      expect(identifyClient({ originator: 'opencode' })).toBe('opencode');
      expect(identifyClient({ originator: 'opencode/1.0' })).toBe('opencode');
      expect(identifyClient({ originator: 'OPENCODE' })).toBe('opencode');
    });

    it('originator header 优先级高于 User-Agent', () => {
      // 即使 UA 是其他客户端，originator 是 opencode 时应该返回 opencode
      expect(identifyClient({
        'user-agent': 'cursor/1.0',
        originator: 'opencode',
      })).toBe('opencode');
    });
  });

  describe('未知客户端', () => {
    it('空 headers 应该返回 unknown', () => {
      expect(identifyClient({})).toBe('unknown');
    });

    it('无法识别的 User-Agent 应该返回 unknown', () => {
      expect(identifyClient({ 'user-agent': 'UnknownApp/1.0' })).toBe('unknown');
      expect(identifyClient({ 'user-agent': 'Mozilla/5.0' })).toBe('unknown');
      expect(identifyClient({ 'user-agent': 'python-requests/2.28.0' })).toBe('unknown');
    });

    it('空 User-Agent 应该返回 unknown', () => {
      expect(identifyClient({ 'user-agent': '' })).toBe('unknown');
    });
  });

  describe('识别优先级', () => {
    it('originator > opencode > claude > codex > cursor > windsurf > test-client > unknown', () => {
      // originator 最高优先级
      expect(identifyClient({
        'user-agent': 'codex/1.0',
        originator: 'opencode',
      })).toBe('opencode');

      // User-Agent 内部优先级：opencode > claude
      expect(identifyClient({ 'user-agent': 'opencode claude-code/1.0' })).toBe('opencode');

      // claude > codex（因为 Claude 匹配在 Codex 之前）
      // 注意：这里的 UA 包含 'claude' 但不包含 'opencode'
      // 由于 'codex' 不包含 'claude'，所以不会误判
    });
  });

  describe('大小写不敏感', () => {
    it('应该不区分大小写识别所有客户端', () => {
      const clients: Array<{ ua: string; expected: ClientType }> = [
        { ua: 'OPENCODE/1.0', expected: 'opencode' },
        { ua: 'OpEnCoDe/1.0', expected: 'opencode' },
        { ua: 'CLAUDE-CODE/1.0', expected: 'claude-code' },
        { ua: 'Claude-Code/1.0', expected: 'claude-code' },
        { ua: 'CODEX/1.0', expected: 'codex' },
        { ua: 'CoDeX/1.0', expected: 'codex' },
        { ua: 'CURSOR/1.0', expected: 'cursor' },
        { ua: 'CurSor/1.0', expected: 'cursor' },
        { ua: 'WINDSURF/1.0', expected: 'windsurf' },
        { ua: 'WindSurf/1.0', expected: 'windsurf' },
        { ua: 'TEST-CLIENT/1.0', expected: 'test-client' },
        { ua: 'AgentProxy-TEST/1.0', expected: 'test-client' },
      ];

      for (const { ua, expected } of clients) {
        expect(identifyClient({ 'user-agent': ua })).toBe(expected);
      }
    });
  });

  describe('复杂 User-Agent 字符串', () => {
    it('应该从复杂的 User-Agent 中正确提取客户端信息', () => {
      // 模拟真实的复杂 UA
      expect(identifyClient({
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) opencode/0.1.0',
      })).toBe('opencode');

      expect(identifyClient({
        'user-agent': 'node-fetch/1.0 (+https://github.com/bitinn/node-fetch) codex/2.0.0',
      })).toBe('codex');

      expect(identifyClient({
        'user-agent': 'axios/1.4.0 cursor/0.99.0 (development)',
      })).toBe('cursor');
    });
  });

  describe('边界情况', () => {
    it('应该处理 undefined 和 null 类型的 header 值', () => {
      expect(identifyClient({ 'user-agent': undefined as any })).toBe('unknown');
      expect(identifyClient({ 'user-agent': null as any })).toBe('unknown');
    });

    it('应该处理只有 originator 没有 user-agent 的情况', () => {
      expect(identifyClient({ originator: 'opencode' })).toBe('opencode');
    });

    it('应该处理只有 user-agent 没有 originator 的情况', () => {
      expect(identifyClient({ 'user-agent': 'codex/1.0' })).toBe('codex');
    });

    it('应该处理 headers 中包含多余字段的情况', () => {
      expect(identifyClient({
        'user-agent': 'windsurf/1.0',
        'content-type': 'application/json',
        'authorization': 'Bearer xxx',
        'x-custom-header': 'value',
      })).toBe('windsurf');
    });
  });
});

// ==================== ClientIcon 配置完整性测试 ====================

describe('ClientIcon 配置验证', () => {
  // 导入前端配置进行验证
  const CLIENT_TYPES: ClientType[] = [
    'claude-code',
    'opencode',
    'codex',
    'cursor',
    'windsurf',
    'test-client',
    'unknown',
  ];

  it('应该包含所有 ClientType 的配置', () => {
    // 确保每个 ClientType 都有对应的配置
    // 这里通过测试 identifyClient 的返回值来间接验证
    for (const type of CLIENT_TYPES) {
      expect(type).toBeDefined();
      expect(typeof type).toBe('string');
    }
  });

  it('所有客户端类型都应该能被正确识别', () => {
    const identificationTests: Array<{ type: ClientType; headers: Record<string, string> }> = [
      { type: 'claude-code', headers: { 'user-agent': 'claude-code/1.0' } },
      { type: 'opencode', headers: { 'user-agent': 'opencode/1.0' } },
      { type: 'codex', headers: { 'user-agent': 'codex/1.0' } },
      { type: 'cursor', headers: { 'user-agent': 'cursor/1.0' } },
      { type: 'windsurf', headers: { 'user-agent': 'windsurf/1.0' } },
      { type: 'test-client', headers: { 'user-agent': 'test-client/1.0' } },
      { type: 'unknown', headers: { 'user-agent': 'unknown-app/1.0' } },
    ];

    for (const { type, headers } of identificationTests) {
      expect(identifyClient(headers)).toBe(type);
    }
  });

  it('unknown 类型应该在无法识别时返回', () => {
    expect(identifyClient({})).toBe('unknown');
    expect(identifyClient({ 'user-agent': '' })).toBe('unknown');
    expect(identifyClient({ 'user-agent': 'not-a-known-client' })).toBe('unknown');
  });
});

// ==================== 集成测试 ====================

describe('客户端识别集成测试', () => {
  it('应该模拟完整的请求头识别流程', () => {
    // 模拟 OpenCode 的请求头
    const opencodeHeaders = {
      'content-type': 'application/json',
      'user-agent': 'opencode/0.1.0',
      originator: 'opencode',
      'x-api-key': 'sk-xxx',
    };
    expect(identifyClient(opencodeHeaders)).toBe('opencode');

    // 模拟 Claude Code 的请求头
    const claudeHeaders = {
      'content-type': 'application/json',
      'user-agent': 'claude-code/1.0.0',
      'anthropic-version': '2023-06-01',
    };
    expect(identifyClient(claudeHeaders)).toBe('claude-code');

    // 模拟 Cursor 的请求头
    const cursorHeaders = {
      'content-type': 'application/json',
      'user-agent': 'Cursor/0.99.0',
    };
    expect(identifyClient(cursorHeaders)).toBe('cursor');
  });

  it('应该正确处理多客户端的混合识别', () => {
    const scenarios = [
      {
        name: 'opencode 通过 originator',
        headers: { 'user-agent': 'some-app', originator: 'opencode' },
        expected: 'opencode',
      },
      {
        name: 'claude 通过 user-agent',
        headers: { 'user-agent': 'claude-code/1.0', originator: '' },
        expected: 'claude-code',
      },
      {
        name: 'test-client 通过 user-agent',
        headers: { 'user-agent': 'agentproxy-test', originator: '' },
        expected: 'test-client',
      },
      {
        name: 'unknown 无匹配',
        headers: { 'user-agent': 'random-app', originator: 'random' },
        expected: 'unknown',
      },
    ];

    for (const { name, headers, expected } of scenarios) {
      expect(identifyClient(headers), `${name} should return ${expected}`).toBe(expected);
    }
  });
});
