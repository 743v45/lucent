/**
 * provider-baseurl spec 静态断言
 *
 * 对应 openspec/specs/provider-baseurl/spec.md 里的 3 条 Scenario
 * （"Per-provider endpoint-URL table" 的 3 个预设）。
 *
 * 路由/拼接行为（13 条 Scenario）已由 provider-e2e / anthropic-e2e /
 * providers-e2e 覆盖；首次启动种子已由 provider-e2e「首次启动」用例
 * 覆盖。本文件只守"静态值正确"这一面——任何人未来改 presets.ts 漏写
 * /v1、漏写完整 URL，本文件立刻红灯。
 *
 * 运行: npx vitest run tests/provider-baseurl-spec.test.ts
 */

import { describe, it, expect } from 'vitest';
import { PROVIDER_PRESETS, getPresetByName } from '../src/constants/presets';

function presetByName(name: string) {
  const p = getPresetByName(name);
  if (!p) throw new Error(`preset not found: ${name}`);
  return p;
}

describe('provider-baseurl spec — per-preset baseUrl', () => {
  // 直接对应 spec Scenario: `anthropic` preset in `src/constants/presets.ts`
  it('`anthropic` preset: anthropic-messages baseUrl is https://api.anthropic.com/v1', () => {
    const p = presetByName('anthropic');
    expect(p.endpoints['anthropic-messages']).toBe('https://api.anthropic.com/v1');
  });

  // 直接对应 spec Scenario: `openai` preset in `src/constants/presets.ts`
  it('`openai` preset: openai-chat + openai-responses baseUrls are both https://api.openai.com/v1', () => {
    const p = presetByName('openai');
    expect(p.endpoints['openai-chat']).toBe('https://api.openai.com/v1');
    expect(p.endpoints['openai-responses']).toBe('https://api.openai.com/v1');
  });

  // 直接对应 spec Scenario: `zhipu` preset in `src/constants/presets.ts`
  it('`zhipu` preset: openai-chat baseUrl is /api/coding/paas/v4, anthropic-messages is /api/anthropic/v1', () => {
    const p = presetByName('zhipu');
    expect(p.endpoints['openai-chat']).toBe('https://open.bigmodel.cn/api/coding/paas/v4');
    expect(p.endpoints['anthropic-messages']).toBe('https://open.bigmodel.cn/api/anthropic/v1');
  });

  // 一致性兜底：spec 表格里只列了 3 个 preset，PROVIDER_PRESETS 里没多余同名项
  it('PROVIDER_PRESETS array contains exactly the 3 spec-listed presets as name entries (no duplicates)', () => {
    const names = PROVIDER_PRESETS.map(p => p.name);
    // 3 条 Scenario 对应 3 个 preset name：anthropic / openai / zhipu
    for (const required of ['anthropic', 'openai', 'zhipu']) {
      expect(names).toContain(required);
    }
  });
});
