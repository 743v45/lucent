/**
 * protocol-model spec 静态断言
 *
 * 对应 openspec/changes/2026-06-18-protocol-registry/specs/protocol-model/spec.md
 * 的 6 条 Requirement。运行时行为(路由/SSE/context/测试连接)由 verify:* 端到端
 * 覆盖;本文件只守「身份维度静态值正确」——任何人未来手写协议联合、漏写 registry
 * 字段、让 strippedPaths 跨协议重叠、复活 TEST_MODELS,本文件立刻红灯。
 *
 * 运行: npx vitest run tests/protocol-model-spec.test.ts
 */

import { describe, it, expect } from 'vitest';
import { PROTOCOL_REGISTRY, PROTOCOL_IDS } from '../shared/protocols';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

describe('protocol-model spec — registry 单源', () => {
  // Req 1: 三个协议均已在 registry 注册 + 字段完整
  it('PROTOCOL_REGISTRY contains exactly 3 protocols with all required fields', () => {
    expect(PROTOCOL_IDS).toEqual(
      expect.arrayContaining(['anthropic-messages', 'openai-chat', 'openai-responses'])
    );
    expect(PROTOCOL_IDS).toHaveLength(3);

    for (const id of PROTOCOL_IDS) {
      const d = PROTOCOL_REGISTRY[id];
      expect(d.id).toBe(id);
      expect(d.label.length).toBeGreaterThan(0);
      expect(d.strippedPaths.length).toBeGreaterThan(0);
      expect(d.defaultTestModel.length).toBeGreaterThan(0);
      expect(d.schemaDocRef.length).toBeGreaterThan(0);
    }
  });

  // Req 1: schemaDocRef 指向真实存在的文档
  it('schemaDocRef points to existing docs/protocols/ files', () => {
    for (const id of PROTOCOL_IDS) {
      const ref = PROTOCOL_REGISTRY[id].schemaDocRef;
      expect(existsSync(join(process.cwd(), ref))).toBe(true);
    }
  });

  // Req 4: strippedPaths 不得跨协议重叠
  it('strippedPaths have no overlap across protocols', () => {
    const seen = new Map<string, string>(); // path → protocol id
    for (const id of PROTOCOL_IDS) {
      for (const p of PROTOCOL_REGISTRY[id].strippedPaths) {
        if (seen.has(p)) {
          throw new Error(`strippedPath "${p}" 重叠于 ${seen.get(p)} 与 ${id}`);
        }
        seen.set(p, id);
      }
    }
  });

  // Req 1: 关键 path 字面量存在
  it('known strippedPaths are present (messages / chat+completions alias / responses)', () => {
    expect(PROTOCOL_REGISTRY['anthropic-messages'].strippedPaths).toEqual(['/messages']);
    expect(PROTOCOL_REGISTRY['openai-chat'].strippedPaths).toEqual(['/chat/completions', '/completions']);
    expect(PROTOCOL_REGISTRY['openai-responses'].strippedPaths).toEqual(['/responses']);
  });
});

describe('protocol-model spec — EndpointType 派生(无手写联合)', () => {
  // Req 2: 业务代码不得手写协议联合字面量
  it('src/types.ts and server/types.ts derive EndpointType from shared (no hand-written union)', () => {
    for (const f of ['src/types.ts', 'server/types.ts']) {
      const src = readFileSync(join(process.cwd(), f), 'utf8');
      // 禁止出现手写的三协议联合字面量
      expect(src).not.toMatch(/'anthropic-messages'\s*\|\s*'openai-chat'\s*\|\s*'openai-responses'/);
      // 必须从 shared/protocols 派生
      expect(src).toMatch(/shared\/protocols/);
    }
  });

  // Req 6: server/constants.ts 不得再导出 TEST_MODELS
  it('server/constants.ts does not export TEST_MODELS', () => {
    const src = readFileSync(join(process.cwd(), 'server/constants.ts'), 'utf8');
    expect(src).not.toMatch(/export\s+const\s+TEST_MODELS/);
  });

  // Req 6: 测试连接改读 registry
  it('server/routes/providers.ts reads test model from registry, not TEST_MODELS', () => {
    const src = readFileSync(join(process.cwd(), 'server/routes/providers.ts'), 'utf8');
    expect(src).not.toMatch(/\bTEST_MODELS\b/);
    expect(src).toMatch(/PROTOCOL_REGISTRY/);
  });
});
