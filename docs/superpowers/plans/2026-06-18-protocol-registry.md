# 三协议 Registry 单源 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把三协议(`anthropic-messages` / `openai-chat` / `openai-responses`)的身份维度收口到 `shared/protocols.ts` 单源,消除散落在 `src/types.ts`、`server/types.ts`、`context-extractors.ts`、`server/constants.ts`、`server/routes/providers.ts` 的重复定义与漂移风险,并落地 `openspec/specs/protocol-model/spec.md` 契约。

**Architecture:** 新建 `shared/protocols.ts` 导出纯数据描述符表 `PROTOCOL_REGISTRY`(id / label / strippedPaths / defaultTestModel / schemaDocRef)。`EndpointType` 联合类型从 registry 派生,消除两份手写联合。path → protocol 检测(`matchPath` / `detectEndpointType` / 测试连接 testUrl)三处共用 registry 的 `strippedPaths` 单源。延续 `shared/sse-events.ts` 已有的"跨端共享放 shared"先例。配色/preset/SSE 提取函数体保持原位(YAGNI)。

**Tech Stack:** TypeScript(ESNext + bundler resolution)、Vitest、OpenSpec CLI、tsx。前后端通过相对路径 import `../shared/*.js` / `../../shared/*.js`(沿用 `shared/sse-events.ts` 既有模式)。

**关联 spec:** `openspec/changes/2026-06-18-protocol-registry/specs/protocol-model/spec.md`(6 条 Requirement)
**关联设计:** `docs/superpowers/specs/2026-06-18-protocol-registry-design.md`

---

## File Structure

| 文件 | 动作 | 职责 |
|---|---|---|
| `shared/protocols.ts` | **新建** | `PROTOCOL_REGISTRY` 纯数据描述符表 + `ProtocolId` / `PROTOCOL_IDS` / `ProtocolDescriptor` 类型 |
| `tsconfig.json` | 改 | `include` 加 `"shared"` |
| `src/types.ts` | 改 | `EndpointType` / `ENDPOINT_TYPES` / `ENDPOINT_LABELS` / `isEndpointType` 改为从 registry 派生 |
| `server/types.ts` | 改 | 同上(server 端一份) |
| `server/endpoint-handlers.ts` | 改 | 三处 `matchPath` 改读 `PROTOCOL_REGISTRY[type].strippedPaths` |
| `server/context-extractors.ts` | 改 | `detectEndpointType` 删除内部硬编码 path,委托 registry `inferEndpointTypeFromPath` |
| `server/constants.ts` | 改 | 删除 `TEST_MODELS` |
| `server/routes/providers.ts` | 改 | 三处 `TEST_MODELS[...]` 改读 registry;三处 testUrl 硬编码改读 registry `strippedPaths` |
| `tests/protocol-model-spec.test.ts` | **新建** | 守 spec 静态值:registry 字段完整、无手写联合、strippedPaths 无重叠、TEST_MODELS 已删 |
| `openspec/changes/2026-06-18-protocol-registry/` | 已存在(proposal + spec 草案) | 实现完成后 archive |

**刻意不动**(YAGNI,设计已确认):`src/constants/protocol-colors.ts`(前端关注点)、`src/constants/presets.ts`(已有 `provider-baseurl` spec)、SSE/context 提取函数体(业务逻辑非身份维度)、`vitest.config.ts` coverage include(非 spec 要求)。

---

## Task 1: 新建 `shared/protocols.ts` + 修 tsconfig(纯新增,零回归)

**Files:**
- Create: `shared/protocols.ts`
- Modify: `tsconfig.json:26`(`include` 数组)

- [ ] **Step 1: 写 `shared/protocols.ts`**

```typescript
/**
 * shared/protocols.ts — 三协议身份维度单源
 *
 * Lucent 支持的三个上游协议(anthropic-messages / openai-chat / openai-responses)
 * 的身份字段在此唯一声明:id / label / strippedPaths / defaultTestModel / schemaDocRef。
 *
 * 一切「这个协议叫什么、认领哪些 path、用什么测试模型、对应哪份 schema 文档」的
 * 问题,答案都在这张表里。其他文件(types.ts / endpoint-handlers.ts /
 * context-extractors.ts / routes/providers.ts)一律从本表派生,不得手写字面量。
 *
 * 覆盖的事件提取逻辑见 shared/sse-events.ts(那是行为,这里是身份)。
 */

/** 单个协议的身份描述符 */
export interface ProtocolDescriptor {
  /** 协议标识,同时是 PROTOCOL_REGISTRY 的键 */
  id: ProtocolId;
  /** 展示名(UI label,如 "Anthropic Messages") */
  label: string;
  /**
   * 去掉 /v1 前缀后的认领路径数组。registry 的 matchPath / detectEndpointType /
   * 测试连接 testUrl 三处共用此单源。
   *
   * 不变量:任意两个协议的 strippedPaths 不得有交集(否则 inferEndpointTypeFromPath
   * 遍历时会误判)。
   */
  strippedPaths: readonly string[];
  /** 测试连接用的廉价模型(最小化 token 消耗) */
  defaultTestModel: string;
  /** 对应 docs/protocols/ 下的权威 schema 文档路径 */
  schemaDocRef: string;
}

/** 协议标识联合类型(派生源,其他文件的 EndpointType 都从此派生) */
export type ProtocolId =
  | 'anthropic-messages'
  | 'openai-chat'
  | 'openai-responses';

/** 协议注册表——三协议身份维度的唯一真相源 */
export const PROTOCOL_REGISTRY = {
  'anthropic-messages': {
    id: 'anthropic-messages',
    label: 'Anthropic Messages',
    strippedPaths: ['/messages'],
    defaultTestModel: 'claude-sonnet-4-20250514',
    schemaDocRef: 'docs/protocols/01-anthropic-messages.md',
  },
  'openai-chat': {
    id: 'openai-chat',
    label: 'OpenAI Chat',
    strippedPaths: ['/chat/completions', '/completions'],
    defaultTestModel: 'gpt-4o-mini',
    schemaDocRef: 'docs/protocols/02-openai-chat-completions.md',
  },
  'openai-responses': {
    id: 'openai-responses',
    label: 'OpenAI Responses',
    strippedPaths: ['/responses'],
    defaultTestModel: 'gpt-4o-mini',
    schemaDocRef: 'docs/protocols/03-openai-responses.md',
  },
} as const satisfies Record<ProtocolId, ProtocolDescriptor>;

/** 所有协议 id(派生自 registry,不得手写) */
export const PROTOCOL_IDS = Object.keys(PROTOCOL_REGISTRY) as ProtocolId[];
```

> 注:`ProtocolId` 这里手写联合是为了让 registry 的 `as const satisfies Record<ProtocolId, ...>` 能做完整性检查(漏一个协议键 tsc 报错)。这是**唯一允许**的手写联合——它是 registry 自身的键约束,而非散落各处的副本。Task 2 的 `EndpointType = ProtocolId` 后,业务代码不再有手写联合。

- [ ] **Step 2: 改 `tsconfig.json` 的 `include`**

把第 26 行:
```json
  "include": ["src", "server", "bin"],
```
改成:
```json
  "include": ["src", "server", "bin", "shared"],
```

- [ ] **Step 3: 验证 tsc 通过**

Run: `npx tsc --noEmit`
Expected: 无输出(退出码 0)。若报 `shared/sse-events.ts` 相关错误说明此前靠 import 顺带编译的问题暴露——但本步只新增 `protocols.ts` + 改 include,不应引入新错误。

- [ ] **Step 4: 验证现有测试不回归**

Run: `npm run test:run`
Expected: 全绿(本步纯新增 + include 扩充,不改任何现有文件逻辑)。

- [ ] **Step 5: Commit**

```bash
git add shared/protocols.ts tsconfig.json
git commit -m "feat(protocol-registry): 新建 shared/protocols.ts 单源 + tsconfig include shared

PROTOCOL_REGISTRY 纯数据描述符表(id/label/strippedPaths/defaultTestModel/schemaDocRef)。
纯新增,不接任何调用方。顺手修 tsconfig 漏 include shared 的隐患(shared/sse-events.ts
此前靠相对路径 import 顺带编译)。"
```

---

## Task 2: 写 spec 静态断言测试(先红,驱动 Task 3-5 实现)

**Files:**
- Create: `tests/protocol-model-spec.test.ts`

> 模式参考 `tests/provider-baseurl-spec.test.ts`:守 spec 的静态值正确。本测试在 Task 3-5 完成前会红,作为 TDD 驱动。

- [ ] **Step 1: 写 `tests/protocol-model-spec.test.ts`**

```typescript
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
```

- [ ] **Step 2: 运行测试确认它红(TDD)**

Run: `npx vitest run tests/protocol-model-spec.test.ts`
Expected: FAIL。具体失败点:
- `PROTOCOL_REGISTRY contains exactly 3 protocols` 应该 PASS(Task 1 已建)
- `src/types.ts and server/types.ts derive EndpointType` 应 FAIL(当前还是手写联合)
- `server/constants.ts does not export TEST_MODELS` 应 FAIL(当前还有)
- `server/routes/providers.ts reads test model from registry` 应 FAIL(当前还用 TEST_MODELS)

> 这些红正是 Task 3-5 要绿的。若全绿说明 Task 1 多做了,或断言写错。

- [ ] **Step 3: Commit(测试先行)**

```bash
git add tests/protocol-model-spec.test.ts
git commit -m "test(protocol-registry): spec 静态断言(先红,驱动 registry 收口实现)

对应 protocol-model spec 6 条 Requirement 的静态值断言。Task 3-5 完成后转绿。"
```

---

## Task 3: `EndpointType` 派生化(核心——两份 types 收口)

**Files:**
- Modify: `src/types.ts:255-272`(EndpointType 块)
- Modify: `server/types.ts:9-17`(EndpointType 块)

- [ ] **Step 1: 改 `src/types.ts`**

找到这段(约 255-272 行):
```typescript
export type EndpointType = 'openai-chat' | 'openai-responses' | 'anthropic-messages';

/** 所有支持的端点协议类型 */
export const ENDPOINT_TYPES: EndpointType[] = ['anthropic-messages', 'openai-chat', 'openai-responses'];

/** 端点协议类型的友好名称 */
export const ENDPOINT_LABELS: Record<EndpointType, string> = {
  'openai-chat': 'OpenAI Chat',
  'openai-responses': 'OpenAI Responses',
  'anthropic-messages': 'Anthropic Messages',
};

/** 类型守卫：判断字符串是否为合法的 EndpointType */
export function isEndpointType(s: string): s is EndpointType {
  return (ENDPOINT_TYPES as string[]).includes(s);
}
```

替换为:
```typescript
// 协议身份维度单源:见 shared/protocols.ts。EndpointType 等全部从 registry 派生,
// 禁止手写协议联合字面量(protocol-model spec Req 2)。
import { ProtocolId, PROTOCOL_IDS, PROTOCOL_REGISTRY } from '../shared/protocols.js';

export type EndpointType = ProtocolId;

/** 所有支持的端点协议类型(派生自 PROTOCOL_REGISTRY) */
export const ENDPOINT_TYPES: EndpointType[] = PROTOCOL_IDS;

/** 端点协议类型的友好名称(派生自 PROTOCOL_REGISTRY) */
export const ENDPOINT_LABELS = Object.fromEntries(
  PROTOCOL_IDS.map(id => [id, PROTOCOL_REGISTRY[id].label])
) as Record<EndpointType, string>;

/** 类型守卫：判断字符串是否为合法的 EndpointType */
export function isEndpointType(s: string): s is EndpointType {
  return (ENDPOINT_TYPES as string[]).includes(s);
}
```

> `import` 放在该类型定义块上方(紧邻原注释)。若 `src/types.ts` 顶部已有其他 import,合并到一起。

- [ ] **Step 2: 改 `server/types.ts`**

找到这段(约 9-17 行):
```typescript
export type EndpointType = 'openai-chat' | 'openai-responses' | 'anthropic-messages';

/** 所有支持的端点协议类型 */
export const ENDPOINT_TYPES: EndpointType[] = ['openai-chat', 'openai-responses', 'anthropic-messages'];

/** 类型守卫：判断字符串是否为合法的 EndpointType */
export function isEndpointType(s: string): s is EndpointType {
  return (ENDPOINT_TYPES as string[]).includes(s);
}
```

替换为:
```typescript
// 协议身份维度单源:见 shared/protocols.ts。EndpointType 等全部从 registry 派生,
// 禁止手写协议联合字面量(protocol-model spec Req 2)。
import { ProtocolId, PROTOCOL_IDS } from '../shared/protocols.js';

export type EndpointType = ProtocolId;

/** 所有支持的端点协议类型(派生自 PROTOCOL_REGISTRY) */
export const ENDPOINT_TYPES: EndpointType[] = PROTOCOL_IDS;

/** 类型守卫：判断字符串是否为合法的 EndpointType */
export function isEndpointType(s: string): s is EndpointType {
  return (ENDPOINT_TYPES as string[]).includes(s);
}
```

> server/types.ts 不需要 `ENDPOINT_LABELS`(原本就没有),只派生 `EndpointType` / `ENDPOINT_TYPES` / `isEndpointType`。

- [ ] **Step 3: 验证 tsc**

Run: `npx tsc --noEmit`
Expected: 退出码 0。注意检查:`server/endpoint-handlers.ts:11` 的 `import { ENDPOINT_TYPES } from './types.js'` 仍有效(派生后仍是 `EndpointType[]`);`src/components/settings/SettingsModal.tsx` / `LogListPanel.tsx` / `DetailPanel.tsx` 对 `ENDPOINT_TYPES`/`ENDPOINT_LABELS` 的 import 仍有效。

- [ ] **Step 4: 运行 spec 断言测试,确认 Req 2 部分转绿**

Run: `npx vitest run tests/protocol-model-spec.test.ts`
Expected: `EndpointType 派生(无手写联合)` 组的 "src/types.ts and server/types.ts derive EndpointType" 由 FAIL → PASS。其余两条(TEST_MODELS 相关)仍 FAIL,留给 Task 5。

- [ ] **Step 5: 运行全量单测确认无回归**

Run: `npm run test:run`
Expected: 全绿。

- [ ] **Step 6: Commit**

```bash
git add src/types.ts server/types.ts
git commit -m "refactor(protocol-registry): EndpointType 从 PROTOCOL_REGISTRY 派生

src/types.ts + server/types.ts 的 EndpointType/ENDPOINT_TYPES/ENDPOINT_LABELS/
isEndpointType 全部改为从 shared/protocols.ts 派生,消除两份手写联合字面量。
(protocol-model spec Req 2)"
```

---

## Task 4: path 单源——`endpoint-handlers.matchPath` + `context-extractors.detectEndpointType`

**Files:**
- Modify: `server/endpoint-handlers.ts:18,91,165`(三处 matchPath)
- Modify: `server/context-extractors.ts:43-62`(detectEndpointType)
- Modify: `server/endpoint-registry.ts`(新增导出 `getStrippedPaths` 辅助)

> **风险提示:** 这一步合并两套 path 规则,是整个计划的高风险点。Task 6 的全套 verify 兜底。

- [ ] **Step 1: 在 `server/endpoint-registry.ts` 增加从 registry 读 strippedPaths 的能力**

在 `server/endpoint-registry.ts` 顶部 import 块加:
```typescript
import { PROTOCOL_REGISTRY } from '../shared/protocols.js';
import type { EndpointType } from './types.js';
```

在文件末尾(`inferEndpointTypeFromPath` 函数之后)新增:
```typescript
/**
 * 返回某协议的所有 strippedPaths(单源取自 PROTOCOL_REGISTRY)。
 * 供 endpoint-handlers.matchPath / context-extractors / 测试连接共用,
 * 避免 path 字面量散落(protocol-model spec Req 3)。
 */
export function getStrippedPaths(type: EndpointType): readonly string[] {
  return PROTOCOL_REGISTRY[type].strippedPaths;
}
```

> 注意:不修改 `inferEndpointTypeFromPath` 的现有遍历逻辑(它遍历 registry 的 handler.matchPath)。本步只是让 matchPath 自身从 registry 取字面量,这样遍历时的判断依据和 registry 描述符是同一份。

- [ ] **Step 2: 改 `server/endpoint-handlers.ts` 三处 matchPath**

在顶部 import 块(第 10-13 行)加:
```typescript
import { getStrippedPaths } from './endpoint-registry.js';
```

Anthropic Messages(第 17-20 行)的:
```typescript
registerEndpoint('anthropic-messages', {
  matchPath(strippedPath: string): boolean {
    return strippedPath === '/messages';
  },
```
改成:
```typescript
registerEndpoint('anthropic-messages', {
  matchPath(strippedPath: string): boolean {
    return getStrippedPaths('anthropic-messages').includes(strippedPath);
  },
```

OpenAI Chat(第 90-93 行)的:
```typescript
registerEndpoint('openai-chat', {
  matchPath(strippedPath: string): boolean {
    return strippedPath === '/chat/completions' || strippedPath === '/completions';
  },
```
改成:
```typescript
registerEndpoint('openai-chat', {
  matchPath(strippedPath: string): boolean {
    return getStrippedPaths('openai-chat').includes(strippedPath);
  },
```

OpenAI Responses(第 164-167 行)的:
```typescript
registerEndpoint('openai-responses', {
  matchPath(strippedPath: string): boolean {
    return strippedPath === '/responses';
  },
```
改成:
```typescript
registerEndpoint('openai-responses', {
  matchPath(strippedPath: string): boolean {
    return getStrippedPaths('openai-responses').includes(strippedPath);
  },
```

- [ ] **Step 3: 改 `server/context-extractors.ts` 的 `detectEndpointType`**

在顶部 import 块(第 7 行后)加:
```typescript
import { inferEndpointTypeFromPath, getStrippedPaths } from './endpoint-registry.js';
import { PROTOCOL_REGISTRY } from '../shared/protocols.js';
```

找到 `detectEndpointType`(第 43-62 行):
```typescript
export function detectEndpointType(url: string): EndpointType | null {
  if (!url || typeof url !== 'string') return null;

  // /custom/{name}/{rest} 格式 → 从 rest 解析
  const customMatch = /^\/custom\/[a-zA-Z0-9_-]+(\/.*)$/.exec(new URL(url, 'http://x').pathname);
  if (customMatch) {
    const rest = customMatch[1];
    if (rest === '/v1/messages') return 'anthropic-messages';
    if (rest === '/v1/chat/completions' || rest === '/v1/completions') return 'openai-chat';
    if (rest === '/v1/responses') return 'openai-responses';
    return null;
  }

  // 老路径 → 直接检测（兼容历史日志）
  if (url.includes('/v1/messages')) return 'anthropic-messages';
  if (url.includes('/v1/chat/completions') || url.includes('/v1/completions')) return 'openai-chat';
  if (url.includes('/v1/responses')) return 'openai-responses';

  return null;
}
```

替换为:
```typescript
export function detectEndpointType(url: string): EndpointType | null {
  if (!url || typeof url !== 'string') return null;

  // /custom/{name}/{rest} 格式 → 剥出 strippedPath 后委托 registry 推断
  // (path 字面量单源取自 PROTOCOL_REGISTRY,protocol-model spec Req 3)
  const customMatch = /^\/custom\/[a-zA-Z0-9_-]+(\/.*)$/.exec(new URL(url, 'http://x').pathname);
  if (customMatch) {
    const strippedPath = stripLeadingV1(customMatch[1]);
    return inferEndpointTypeFromPath(strippedPath);
  }

  // 老路径 → 直接检测（兼容历史日志:旧日志无 endpointType 字段,需从 URL 反推）
  // 匹配常量从 registry 派生,不再手写字面量。
  for (const id of PROTOCOL_IDS_LOCAL) {
    for (const p of getStrippedPaths(id)) {
      if (url.includes(`/v1${p}`)) return id;
    }
  }

  return null;
}

/** 去掉单个前导 /v1 段(与 proxy.ts 的 strip 逻辑一致) */
function stripLeadingV1(rest: string): string {
  return rest.startsWith('/v1/') ? rest.slice(3) : rest;
}

// 仅本文件用的 id 遍历引用(避免顶部 import 名字污染)
const PROTOCOL_IDS_LOCAL: EndpointType[] = PROTOCOL_REGISTRY_KEYS;

// PROTOCOL_REGISTRY 的键,等价于 PROTOCOL_IDS,但避免额外 import 循环
const PROTOCOL_REGISTRY_KEYS = Object.keys(PROTOCOL_REGISTRY) as EndpointType[];
```

> **简化建议:** 如果觉得 `PROTOCOL_IDS_LOCAL` / `PROTOCOL_REGISTRY_KEYS` 两个中间变量绕,直接从 `shared/protocols.js` import `PROTOCOL_IDS` 用即可。上面写法是为了显式标注;更干净的版本:
>
> 顶部 import 改成:
> ```typescript
> import { PROTOCOL_REGISTRY, PROTOCOL_IDS } from '../shared/protocols.js';
> ```
> 函数体里:
> ```typescript
>   for (const id of PROTOCOL_IDS) {
>     for (const p of getStrippedPaths(id)) {
>       if (url.includes(`/v1${p}`)) return id;
>     }
>   }
> ```
> **用这个干净版本**,删掉 `PROTOCOL_IDS_LOCAL` / `PROTOCOL_REGISTRY_KEYS`。

- [ ] **Step 4: 验证 tsc**

Run: `npx tsc --noEmit`
Expected: 退出码 0。

- [ ] **Step 5: 运行全量单测(重点看 context-extractors 相关)**

Run: `npm run test:run`
Expected: 全绿。特别关注:`tests/sse-parser.test.ts`、任何用到 `detectEndpointType` 的测试。

- [ ] **Step 6: Commit**

```bash
git add server/endpoint-registry.ts server/endpoint-handlers.ts server/context-extractors.ts
git commit -m "refactor(protocol-registry): path 单源——matchPath/detectEndpointType 共用 registry

endpoint-handlers 三处 matchPath 改读 getStrippedPaths(type)(registry 派生);
context-extractors.detectEndpointType 删除内部硬编码 path,剥 strippedPath 后委托
inferEndpointTypeFromPath;旧日志兼容路径的匹配常量从 registry 派生。
消除 /messages /chat/completions /completions /responses 字面量散落。
(protocol-model spec Req 3)"
```

---

## Task 5: `TEST_MODELS` 并入 registry + 测试连接 testUrl 单源

**Files:**
- Modify: `server/constants.ts:69-74`(删 TEST_MODELS)
- Modify: `server/routes/providers.ts:24,205,213,221,202,211,219`(改读 registry)

> **发现:** providers.ts 的 switch 里 testUrl 也硬编码了 `/messages` `/chat/completions` `/responses`——这是 path 字面量的**第三处**散落。本 Task 一并收口,否则 Req 3 的"path 单源"不彻底。

- [ ] **Step 1: 改 `server/routes/providers.ts` 顶部 import**

找到第 24 行附近的:
```typescript
  TEST_MODELS,
```
从 import 列表中**删除** `TEST_MODELS`(它来自 `server/constants.ts`)。

在 import 块新增(与其他 server import 一起):
```typescript
import { PROTOCOL_REGISTRY, getStrippedPaths } from '../../shared/protocols.js';
```

> 注:`getStrippedPaths` 实际从 `server/endpoint-registry.js` 导出(Task 4 加的)。若想直接从 shared 取,可在 shared 加一个同名导出——但为避免 shared 变成「啥都有」的工具堆,保持路径:`import { getStrippedPaths } from '../endpoint-registry.js'`(providers.ts 在 server/routes/,所以是 `../endpoint-registry.js`)。**用这个相对路径**,不要从 shared 取。
>
> 最终 import(确认相对路径):
> ```typescript
> import { PROTOCOL_REGISTRY } from '../../shared/protocols.js';
> import { getStrippedPaths } from '../endpoint-registry.js';
> ```

- [ ] **Step 2: 改 switch 块(第 200-225 行)**

找到:
```typescript
      switch (endpointType) {
        case 'anthropic-messages':
          testUrl = `${baseUrl}/messages`;
          headers['anthropic-version'] = ANTHROPIC_API_VERSION;
          testBody = {
            model: TEST_MODELS['anthropic-messages'],
            max_tokens: TEST_MAX_TOKENS,
            messages: [{ role: 'user', content: TEST_REQUEST_CONTENT }],
          };
          break;
        case 'openai-chat':
          testUrl = `${baseUrl}/chat/completions`;
          testBody = {
            model: TEST_MODELS['openai-chat'],
            max_tokens: TEST_MAX_TOKENS,
            messages: [{ role: 'user', content: TEST_REQUEST_CONTENT }],
          };
          break;
        case 'openai-responses':
          testUrl = `${baseUrl}/responses`;
          testBody = {
            model: TEST_MODELS['openai-responses'],
            input: TEST_REQUEST_CONTENT,
          };
          break;
      }
```

替换为:
```typescript
      // path 单源:从 registry 取首个 strippedPath 拼到 baseUrl 后(protocol-model spec Req 3)。
      // model 单源:从 registry 取 defaultTestModel(Req 6)。
      const strippedPath = getStrippedPaths(endpointType)[0];
      testUrl = `${baseUrl}${strippedPath}`;
      switch (endpointType) {
        case 'anthropic-messages':
          headers['anthropic-version'] = ANTHROPIC_API_VERSION;
          testBody = {
            model: PROTOCOL_REGISTRY['anthropic-messages'].defaultTestModel,
            max_tokens: TEST_MAX_TOKENS,
            messages: [{ role: 'user', content: TEST_REQUEST_CONTENT }],
          };
          break;
        case 'openai-chat':
          testBody = {
            model: PROTOCOL_REGISTRY['openai-chat'].defaultTestModel,
            max_tokens: TEST_MAX_TOKENS,
            messages: [{ role: 'user', content: TEST_REQUEST_CONTENT }],
          };
          break;
        case 'openai-responses':
          testBody = {
            model: PROTOCOL_REGISTRY['openai-responses'].defaultTestModel,
            input: TEST_REQUEST_CONTENT,
          };
          break;
      }
```

> 注意:openai-chat 的 testUrl 用 `getStrippedPaths('openai-chat')[0]` = `/chat/completions`(registry 里第一个,与原硬编码一致)。openai-responses 用 `/responses`。anthropic 用 `/messages`。三个 baseUrl 已含 `/v1`(provider-baseurl spec 保证),拼上 strippedPath 正好 `/v1/messages` 等。

- [ ] **Step 3: 删 `server/constants.ts` 的 `TEST_MODELS`**

找到第 68-74 行:
```typescript
// ==================== 测试连接模型 ====================
/** 各 API 类型用于「测试连接」功能的廉价模型 */
export const TEST_MODELS = {
  'anthropic-messages': 'claude-sonnet-4-20250514',
  'openai-chat': 'gpt-4o-mini',
  'openai-responses': 'gpt-4o-mini',
} as const;
```

整段删除。

- [ ] **Step 4: 验证 tsc + 全局搜索确认无残留引用**

Run: `npx tsc --noEmit`
Expected: 退出码 0。

Run: `grep -rn "TEST_MODELS" server/ src/ shared/`
Expected: 无输出(已彻底移除)。

- [ ] **Step 5: 运行 spec 断言测试,确认全绿**

Run: `npx vitest run tests/protocol-model-spec.test.ts`
Expected: 全 PASS。至此 Task 2 的所有断言转绿。

- [ ] **Step 6: 运行全量单测**

Run: `npm run test:run`
Expected: 全绿。特别关注 `tests/providers-e2e.test.ts` / `tests/provider-e2e.test.ts`(测试连接相关)。

- [ ] **Step 7: Commit**

```bash
git add server/constants.ts server/routes/providers.ts
git commit -m "refactor(protocol-registry): TEST_MODELS 并入 registry + 测试连接 testUrl 单源

删除 server/constants.ts 的 TEST_MODELS,改读 PROTOCOL_REGISTRY[type].defaultTestModel;
routes/providers.ts 的 testUrl 硬编码(/messages 等)改读 getStrippedPaths(type)[0],
消除 path 字面量第三处散落。(protocol-model spec Req 3 + Req 6)"
```

---

## Task 6: 全套 verify 端到端兜底(高风险合并的回归门禁)

**Files:** 无改动,纯验证。

> 这一步不产代码,是 Task 4(path 单源)+ Task 5(testUrl 单源)的回归保险。任何一项红都必须回去修,不得跳过进入 Task 7。

- [ ] **Step 1: 路由/URL 拼接层**

Run: `npm run verify:e2e`
Expected: `14/14 通过, 0 失败`,退出码 0。

> 若失败,最可能是 testUrl 拼接(Task 5)或 detectEndpointType(Task 4)对某 path 判断出错。看失败项的实际 vs 期望 URL。

- [ ] **Step 2: 三协议五环节(流式 + 非流式)**

Run: `npm run verify:anthropic`
Expected: 全绿,退出码 0。

Run: `npm run verify:openai-chat`
Expected: 全绿,退出码 0。

Run: `npm run verify:openai-responses`
Expected: 全绿,退出码 0。

- [ ] **Step 3: 自定义供应商多协议 + 错误路径**

Run: `npm run verify:custom`
Expected: 60 验收点全绿,退出码 0。

Run: `npm run verify:custom-errors`
Expected: 120 验收点全绿,退出码 0。

- [ ] **Step 4: 若全绿,无 commit(纯验证步);若任一红,回到对应 Task 修复后重跑**

---

## Task 7: openspec validate + archive

**Files:**
- 验证 + 归档 `openspec/changes/2026-06-18-protocol-registry/`

- [ ] **Step 1: 校验 change 格式**

Run: `openspec validate 2026-06-18-protocol-registry`
Expected: `Change '2026-06-18-protocol-registry' is valid`

- [ ] **Step 2: 归档 change(落地成 spec)**

Run: `openspec archive 2026-06-18-protocol-registry`
Expected: 成功,`openspec/changes/2026-06-18-protocol-registry/` 移至 `openspec/changes/archive/`,且生成/更新 `openspec/specs/protocol-model/spec.md`。

- [ ] **Step 3: 确认落地 spec 存在**

Run: `openspec show protocol-model`
Expected: 显示 `protocol-model` spec 内容,含 6 条 Requirement + 各自 Scenario。

Run: `openspec validate protocol-model`
Expected: `valid`。

- [ ] **Step 4: 更新 `AGENTS.md` 的「已落地契约」清单**

在 `AGENTS.md` 的「已落地契约」列表(约第 41-44 行)加一条:
```markdown
- [`protocol-model`](openspec/specs/protocol-model/spec.md) — 三协议身份维度单源(PROTOCOL_REGISTRY)
```

- [ ] **Step 5: Commit**

```bash
git add openspec/changes/archive/2026-06-18-protocol-registry/ openspec/specs/protocol-model/ AGENTS.md
git rm -r openspec/changes/2026-06-18-protocol-registry/  # archive 已移动,清掉原位置(若 archive 命令未自动删)
git commit -m "chore(openspec): 归档 protocol-registry change → 落地 protocol-model spec

6 条 Requirement:registry 单源 / EndpointType 派生 / path 单源 / strippedPaths 不重叠 /
TEST_MODELS 并入 / tsconfig include shared。实现 + 全套 verify 通过。"
```

> 注:`openspec archive` 通常会自动移动目录;Step 5 的 `git rm` 仅在原目录仍残留时执行。先 `git status` 看实际状态再决定。

---

## 完成标准(Definition of Done)

- [ ] `shared/protocols.ts` 存在,`PROTOCOL_REGISTRY` 含 3 协议完整字段
- [ ] 全项目 `grep -rn "'anthropic-messages' | 'openai-chat' | 'openai-responses'"` 在 src/types.ts / server/types.ts 中无命中(已派生)
- [ ] 全项目 `grep -rn "TEST_MODELS"` 无命中
- [ ] `/messages` `/chat/completions` `/completions` `/responses` 字面量只在 `shared/protocols.ts` 出现
- [ ] `tests/protocol-model-spec.test.ts` 全绿
- [ ] `npm run test:run` 全绿
- [ ] 全套 `verify:*`(6 个脚本)全绿
- [ ] `openspec validate protocol-model` valid
- [ ] `AGENTS.md` 已落地契约清单含 protocol-model
