/**
 * UsageGuide 接入指令格式 e2e
 *
 * 验证 buildAccessLines 生成的 URL 字符串符合"使用说明"对外契约的格式要求
 * - 预设供应商: http://{host}:{port}/{name}(无 /api/ 也无 /custom/)
 * - 自定义供应商: http://{host}:{port}/custom/{name}
 * - OpenAI 端点: 末尾 /v1
 * - 完整 export 命令格式: export ENV_VAR=URL
 *
 * 注: 真实路由端到端测试需要 e2e-helpers 支持 LUCENT_CONFIG_DIR(目前未实现,
 *     plan 范围外)。弹窗的"用 curl 验证"留给手动验证。
 *
 * 运行: npx vitest run tests/usage-guide-e2e.test.ts
 */

import { describe, it, expect } from 'vitest';
import { buildAccessLines } from '../src/components/common/UsageGuide';

describe('UsageGuide 生成命令格式契约', () => {
  it('生成的命令符合 "export ENV_VAR=URL" 格式', () => {
    const lines = buildAccessLines('127.0.0.1', 7048, [
      { name: 'a', presetName: 'a', endpoints: { 'anthropic-messages': 'x' } },
    ]);
    expect(lines[0].cmd).toMatch(/^export [A-Z_]+=http:\/\/[\d.]+:\d+\/.+$/);
  });

  it('弹窗对外契约：不出现 /api/ 前缀（弹窗专用）', () => {
    const lines = buildAccessLines('127.0.0.1', 7048, [
      { name: 'a', presetName: 'a', endpoints: { 'anthropic-messages': 'x', 'openai-chat': 'y' } },
      { name: 'b', presetName: null, endpoints: { 'anthropic-messages': 'x' } },
    ]);
    for (const l of lines) expect(l.cmd).not.toMatch(/^export [A-Z_]+=http:\/\/.+\/api\//);
  });

  it('弹窗对外契约：自定义供应商 URL 必含 /custom/', () => {
    const lines = buildAccessLines('127.0.0.1', 7048, [
      { name: 'a', presetName: null, endpoints: { 'anthropic-messages': 'x' } },
    ]);
    expect(lines[0].cmd).toContain('/custom/a');
  });

  it('弹窗对外契约：预设供应商 URL 不含 /custom/', () => {
    const lines = buildAccessLines('127.0.0.1', 7048, [
      { name: 'openai', presetName: 'openai', endpoints: { 'openai-chat': 'x' } },
    ]);
    expect(lines[0].cmd).not.toContain('/custom/');
    expect(lines[0].cmd).toContain('/openai');
  });

  it('弹窗对外契约：所有 OpenAI 端点 URL 末尾 /v1', () => {
    const lines = buildAccessLines('127.0.0.1', 7048, [
      { name: 'a', presetName: 'a', endpoints: { 'openai-chat': 'x', 'openai-responses': 'y' } },
    ]);
    expect(lines.every((l) => l.cmd.endsWith('/v1'))).toBe(true);
  });
});
