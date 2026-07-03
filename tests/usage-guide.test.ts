/**
 * UsageGuide 接入指令生成纯函数单测
 *
 * 核心不变量：弹窗里展示的 Base URL 必须与 server 实际行为一致
 * - 预设供应商: http://{host}:{port}/{name}
 * - 自定义供应商: http://{host}:{port}/custom/{name}
 * - OpenAI 端点: 末尾加 /v1
 *
 * 运行: npx vitest run tests/usage-guide.test.ts
 */

import { describe, it, expect } from 'vitest';
import { buildAccessLines, type AccessLineInput } from '../src/components/common/UsageGuide';

function preset(name: string, endpoints: Record<string, string> = {}) {
  return { name, presetName: name, endpoints };
}
function custom(name: string, endpoints: Record<string, string> = {}) {
  return { name, presetName: null as unknown as string, endpoints };
}

const HOST = '127.0.0.1';
const PORT = 7048;

describe('buildAccessLines', () => {
  it('预设供应商生成的 Base URL 不含 /api/ 也不含 /custom/', () => {
    const lines = buildAccessLines(HOST, PORT, [
      preset('anthropic', { 'anthropic-messages': 'https://api.anthropic.com' }),
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0].cmd).toBe('export ANTHROPIC_BASE_URL=http://127.0.0.1:7048/anthropic');
    expect(lines[0].cmd).not.toContain('/api/');
    expect(lines[0].cmd).not.toContain('/custom/');
  });

  it('自定义供应商生成的 Base URL 含 /custom/', () => {
    const lines = buildAccessLines(HOST, PORT, [
      custom('my-glm', { 'anthropic-messages': 'https://open.bigmodel.cn/api/coding/paas/v4' }),
    ]);
    expect(lines[0].cmd).toBe('export ANTHROPIC_BASE_URL=http://127.0.0.1:7048/custom/my-glm');
  });

  it('OpenAI 端点 (openai-chat) 末尾加 /v1', () => {
    const lines = buildAccessLines(HOST, PORT, [
      preset('openai', { 'openai-chat': 'https://api.openai.com' }),
    ]);
    expect(lines[0].cmd).toBe('export OPENAI_BASE_URL=http://127.0.0.1:7048/openai/v1');
  });

  it('OpenAI Responses 端点末尾也加 /v1', () => {
    const lines = buildAccessLines(HOST, PORT, [
      preset('openai', { 'openai-responses': 'https://api.openai.com' }),
    ]);
    expect(lines[0].cmd).toBe('export OPENAI_BASE_URL=http://127.0.0.1:7048/openai/v1');
  });

  it('按 clientName 分组：anthropic → Claude Code，openai-* → Codex / OpenAI', () => {
    const lines = buildAccessLines(HOST, PORT, [
      preset('a', { 'anthropic-messages': 'x' }),
      preset('b', { 'openai-chat': 'y' }),
      preset('c', { 'openai-responses': 'z' }),
    ]);
    expect(lines.find(l => l.providerName === 'a')?.clientName).toBe('Claude Code');
    expect(lines.find(l => l.providerName === 'b')?.clientName).toBe('Codex / OpenAI');
    expect(lines.find(l => l.providerName === 'c')?.clientName).toBe('Codex / OpenAI');
  });

  it('同一供应商多端点：anthropic + openai 各生成一行', () => {
    const lines = buildAccessLines(HOST, PORT, [
      preset('hybrid', { 'anthropic-messages': 'x', 'openai-chat': 'y' }),
    ]);
    expect(lines).toHaveLength(2);
    expect(lines.map(l => l.cmd).sort()).toEqual([
      'export ANTHROPIC_BASE_URL=http://127.0.0.1:7048/hybrid',
      'export OPENAI_BASE_URL=http://127.0.0.1:7048/hybrid/v1',
    ]);
  });

  it('空 providers 数组返回空数组', () => {
    expect(buildAccessLines(HOST, PORT, [])).toEqual([]);
  });

  it('openai 双端点(chat + responses)只生成一条 OPENAI 命令（去重，与 server banner 一致）', () => {
    const lines = buildAccessLines(HOST, PORT, [
      preset('openai', {
        'openai-chat': 'https://api.openai.com/v1',
        'openai-responses': 'https://api.openai.com/v1',
        'anthropic-messages': '',
      }),
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0].cmd).toBe('export OPENAI_BASE_URL=http://127.0.0.1:7048/openai/v1');
  });

  it('openai 双端点但上游不同：仍只一条命令（单一 OPENAI_BASE_URL 由 proxy 按路径分流）', () => {
    const lines = buildAccessLines(HOST, PORT, [
      preset('hybrid-oai', {
        'openai-chat': 'https://api.deepseek.com/v1',
        'openai-responses': 'https://api.openai.com/v1',
      }),
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0].cmd).toBe('export OPENAI_BASE_URL=http://127.0.0.1:7048/hybrid-oai/v1');
  });

  it('端点 URL 为空的端点不生成指令', () => {
    const lines = buildAccessLines(HOST, PORT, [
      preset('p', { 'anthropic-messages': '', 'openai-chat': 'y' }),
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0].endpointType).toBe('openai-chat');
  });
});
