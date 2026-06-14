# 会话串联（Conversation Threading）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 同一会话的多次 `main` 请求打上 `threadId`，日志列表新增「会话视图」按 `threadId` 分组折叠展示。

**Architecture:** 后端 `SessionTracker`（内存多会话链）在 `buildRequestEntry` 内、delta slice 之前，用「首条 user 指纹 + messages 前缀校验」算出内容寻址的 `threadId` 落进 entry；前端 `groupByThread` 纯函数对已加载 logs 分组，`LogListPanel` 加视图切换。

**Tech Stack:** TypeScript（server ESM `.js` 导入 / 前端相对路径）、vitest（`tests/*.test.ts`，globals）、React + antd + Tailwind、Playwright e2e。

---

## Spec Deviations（对 spec v2 的调整）

1. **重启重建降级为 no-op**：jsonl 中 main 请求 `body.messages` 被 delta-storage slice（[delta-storage.ts:116](../../../server/delta-storage.ts#L116)），历史 entry 无完整 messages，重建会算错锚点。`threadId` 内容寻址已保证分组正确 + 活跃会话链自然重建，故 `rebuildFromLogs` 留空实现，`index.ts` 不调用。spec AC7 调整为「`threadId` 内容寻址稳定」。
2. 其余完全遵循 [spec v2](../specs/2026-06-13-conversation-threading-design.md)。

## File Structure

| 文件 | 责任 | 动作 |
|---|---|---|
| `src/types.ts` | 前端类型：`LogEntry.threadId`、`Preferences.conversationView` | 改 |
| `server/types.ts` | 后端类型：`LogEntry.threadId`、`RawLogEntry.threadId` | 改 |
| `server/constants.ts` | `MAX_SESSIONS` 常量 | 改 |
| `server/session-tracker.ts` | 会话识别器（纯函数 + `SessionTracker` 类 + 单例） | 新建 |
| `tests/session-tracker.test.ts` | 纯函数 + identify 单测 | 新建 |
| `server/interceptor.ts` | `buildRequestEntry` 接入 identify | 改 |
| `server/services/log-reader.ts` | `normalizeLogEntry` 透传 `threadId` | 改 |
| `src/hooks/useLogs.ts` | `formatLog` 透传 `threadId` | 改 |
| `server/context-rebuilder.ts` | 死代码 | 删 |
| `src/utils/group-by-thread.ts` | 前端分组纯函数 | 新建 |
| `tests/group-by-thread.test.ts` | 分组单测 | 新建 |
| `src/contexts/SettingsContext.tsx` | `conversationView` 默认值 | 改 |
| `src/components/dashboard/LogListPanel.tsx` | 会话视图渲染分支 | 改 |
| `src/App.tsx`（或 LogListPanel 父组件） | 视图切换 toggle + 传 prop | 改 |
| `tests/conversation-e2e.test.ts` | e2e | 新建 |

---

## Task 1: 类型字段与常量（基础）

**Files:**
- Modify: `src/types.ts`（`LogEntry` ~L6、`Preferences` ~L200）
- Modify: `server/types.ts`（`LogEntry` L88、`RawLogEntry` L159）
- Modify: `server/constants.ts`（上下文重建节 L103）

- [ ] **Step 1: 改 `src/types.ts` `LogEntry` 加 `threadId`**

在 [src/types.ts:23](../../../src/types.ts#L23) `providerName?: string;` 之后加：

```ts
  /** 会话线索标识：同一对话（首条 user 锚定）的多次 main 请求共享。仅 main 填充。 */
  threadId?: string;
```

- [ ] **Step 2: 改 `src/types.ts` `Preferences` 加 `conversationView`**

在 [src/types.ts:204](../../../src/types.ts#L204) `showFullTools: boolean;` 之后加：

```ts
  conversationView: 'timeline' | 'session';
```

- [ ] **Step 3: 改 `server/types.ts` `LogEntry` 加 `threadId`**

在 [server/types.ts:152](../../../server/types.ts#L152) `endpointType?: EndpointType;` 之后、`isTest?: boolean;` 之前加：

```ts
  /** 会话线索标识（与 RawLogEntry._conversationId 无关） */
  threadId?: string;
```

- [ ] **Step 4: 改 `server/types.ts` `RawLogEntry` 加 `threadId`**

在 [server/types.ts:197](../../../server/types.ts#L197) `endpointType?: EndpointType;` 之后加：

```ts
  /** 会话线索标识（内容寻址，仅 main；与 _conversationId delta 标签无关） */
  threadId?: string;
```

- [ ] **Step 5: 改 `server/constants.ts` 加 `MAX_SESSIONS`**

在 [server/constants.ts:105](../../../server/constants.ts#L105) `CHECKPOINT_KEY_CONTENT_LENGTH` 行之后加：

```ts
/** SessionTracker 内存会话链最大条数（LRU 清理） */
export const MAX_SESSIONS = 100;
```

- [ ] **Step 6: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无新增错误（旧错误若有记录基线）

- [ ] **Step 7: Commit**

```bash
git add src/types.ts server/types.ts server/constants.ts
git commit -m "feat(thread): LogEntry/RawLogEntry 加 threadId 字段 + MAX_SESSIONS 常量"
```

---

## Task 2: SessionTracker 纯函数 + 单测

**Files:**
- Create: `server/session-tracker.ts`
- Create: `tests/session-tracker.test.ts`

- [ ] **Step 1: 写失败测试 `tests/session-tracker.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { computeAnchorKey, computeFingerprintSeq, findContinuation } from '../server/session-tracker.js';

describe('computeAnchorKey', () => {
  it('首条 user 文本生成稳定锚点', () => {
    const msgs = [{ role: 'user', content: '帮我重构代码' }];
    const key = computeAnchorKey(msgs as any);
    expect(key).toMatch(/^thread_[a-z0-9]+$/);
    expect(computeAnchorKey(msgs as any)).toBe(key); // 稳定
  });

  it('空白/大小写不影响锚点（normalize 后）', () => {
    const a = computeAnchorKey([{ role: 'user', content: '帮我 重构' }] as any);
    const b = computeAnchorKey([{ role: 'user', content: '帮我重构' }] as any);
    expect(a).toBe(b);
  });

  it('ContentBlock[] 内容也能提取文本', () => {
    const msgs = [{ role: 'user', content: [{ type: 'text', text: '你好' }] }];
    expect(computeAnchorKey(msgs as any)).toMatch(/^thread_/);
  });

  it('无 user 消息返回 undefined', () => {
    expect(computeAnchorKey([{ role: 'assistant', content: 'x' }] as any)).toBeUndefined();
    expect(computeAnchorKey([] as any)).toBeUndefined();
  });

  it('首条 user 内容为空返回 undefined', () => {
    expect(computeAnchorKey([{ role: 'user', content: '' }] as any)).toBeUndefined();
  });
});

describe('computeFingerprintSeq', () => {
  it('每条 message 一个指纹，长度等于 messages', () => {
    const msgs = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
    ];
    const seq = computeFingerprintSeq(msgs as any);
    expect(seq).toHaveLength(2);
    expect(seq[0]).not.toBe(seq[1]);
  });
});

describe('findContinuation', () => {
  it('前缀匹配返回该 lineage', () => {
    const lineages = [{ threadId: 'thread_x', msgFingerprints: ['u:1', 'a:2'], lastTimestamp: '2026-01-01', requestCount: 1 }];
    // 当前指纹序列以前缀增长
    const fpSeq = ['u:1', 'a:2', 'u:3'];
    expect(findContinuation(lineages as any, fpSeq)).toBe(lineages[0]);
  });

  it('无前缀匹配返回 undefined', () => {
    const lineages = [{ threadId: 'thread_x', msgFingerprints: ['u:1', 'a:2'], lastTimestamp: '2026-01-01', requestCount: 1 }];
    expect(findContinuation(lineages as any, ['u:9', 'a:8'])).toBeUndefined();
  });

  it('多个匹配取最近时间戳', () => {
    const lineages = [
      { threadId: 'thread_x', msgFingerprints: ['u:1'], lastTimestamp: '2026-01-01', requestCount: 1 },
      { threadId: 'thread_x-2', msgFingerprints: ['u:1'], lastTimestamp: '2026-01-02', requestCount: 1 },
    ];
    const got = findContinuation(lineages as any, ['u:1', 'a:2']);
    expect(got?.threadId).toBe('thread_x-2');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/session-tracker.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `server/session-tracker.ts` 纯函数部分**

```ts
/**
 * 会话识别器：用「首条 user 指纹 + messages 前缀校验」给 main 请求打 threadId。
 * 与 delta-storage（存储压缩）独立，identify 必须收完整原始 body（delta slice 之前）。
 */
import { CHECKPOINT_KEY_CONTENT_LENGTH, MAX_SESSIONS } from './constants.js';
import { extractContext } from './context-extractors.js';
import createDebug from 'debug';
const dbg = createDebug('lucent:session');

interface LikeMessage {
  role: string;
  content: unknown;
}

export interface SessionLineage {
  threadId: string;
  msgFingerprints: string[];
  lastTimestamp: string;
  requestCount: number;
}

/** djb2 哈希（复用 context-rebuilder 已验证实现）→ base36 */
function djb2Hash(s: string): string {
  let hash = 5381;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) + hash + s.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}

/** 从 string 或 ContentBlock[] 提取纯文本 */
function normalizeText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b: any) => (b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string' ? b.text : ''))
      .join('');
  }
  return '';
}

/** 单条 message 指纹 = role + 去空白截断内容的 hash */
function fingerprintMsg(msg: LikeMessage): string {
  const text = normalizeText(msg.content).replace(/\s/g, '').slice(0, CHECKPOINT_KEY_CONTENT_LENGTH);
  return `${msg.role}:${djb2Hash(text)}`;
}

/** 纯函数：首条 user 消息 → 锚点 key（thread_<hash>）。无 user/空内容返回 undefined */
export function computeAnchorKey(messages: LikeMessage[]): string | undefined {
  const firstUser = messages.find(m => m.role === 'user');
  if (!firstUser) return undefined;
  const text = normalizeText(firstUser.content).replace(/\s/g, '').slice(0, CHECKPOINT_KEY_CONTENT_LENGTH);
  if (!text) return undefined;
  return `thread_${djb2Hash(text)}`;
}

/** 纯函数：messages → 指纹序列 */
export function computeFingerprintSeq(messages: LikeMessage[]): string[] {
  return messages.map(fingerprintMsg);
}

function isPrefix(prefix: string[], full: string[]): boolean {
  if (prefix.length === 0 || prefix.length > full.length) return false;
  return prefix.every((fp, i) => fp === full[i]);
}

/** 纯函数：在 lineage 列表中找前缀匹配的续会话；多个匹配取最近时间戳 */
export function findContinuation(lineages: SessionLineage[], fpSeq: string[]): SessionLineage | undefined {
  const matches = lineages.filter(l => isPrefix(l.msgFingerprints, fpSeq));
  if (matches.length === 0) return undefined;
  if (matches.length === 1) return matches[0];
  return matches.sort((a, b) =>
    new Date(b.lastTimestamp).getTime() - new Date(a.lastTimestamp).getTime()
  )[0];
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/session-tracker.test.ts`
Expected: PASS（computeAnchorKey 5、computeFingerprintSeq 1、findContinuation 3）

- [ ] **Step 5: Commit**

```bash
git add server/session-tracker.ts tests/session-tracker.test.ts
git commit -m "feat(thread): SessionTracker 纯函数(锚点/指纹/前缀) + 单测"
```

---

## Task 3: SessionTracker 类 identify + 单测

**Files:**
- Modify: `server/session-tracker.ts`（追加类）
- Modify: `tests/session-tracker.test.ts`（追加测试）

- [ ] **Step 1: 追加失败测试**

在 `tests/session-tracker.test.ts` 末尾追加：

```ts
import { SessionTracker } from '../server/session-tracker.js';

describe('SessionTracker.identify', () => {
  it('续：同会话第二次请求返回相同 threadId', () => {
    const t = new SessionTracker();
    const body1 = { messages: [{ role: 'user', content: '你好' }] };
    const body2 = { messages: [
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '嗨' },
      { role: 'user', content: '再见' },
    ] };
    const id1 = t.identify(body1, 'https://api.anthropic.com/v1/messages', '2026-01-01T00:00:00Z');
    const id2 = t.identify(body2, 'https://api.anthropic.com/v1/messages', '2026-01-01T00:00:01Z');
    expect(id1).toMatch(/^thread_/);
    expect(id2).toBe(id1);
  });

  it('分叉：同首条 user 但前缀不匹配 → 分会话 -2', () => {
    const t = new SessionTracker();
    const body1 = { messages: [{ role: 'user', content: '你好' }, { role: 'assistant', content: 'A' }] };
    const body2 = { messages: [{ role: 'user', content: '你好' }, { role: 'assistant', content: 'B' }] };
    const id1 = t.identify(body1, 'https://api.anthropic.com/v1/messages', '2026-01-01T00:00:00Z');
    const id2 = t.identify(body2, 'https://api.anthropic.com/v1/messages', '2026-01-01T00:00:01Z');
    expect(id2).toBe(`${id1}-2`);
  });

  it('无 user → undefined（未归类）', () => {
    const t = new SessionTracker();
    expect(t.identify({ messages: [{ role: 'assistant', content: 'x' }] }, 'u', 't')).toBeUndefined();
  });

  it('内容寻址：reset 后重算 id 一致', () => {
    const t = new SessionTracker();
    const body = { messages: [{ role: 'user', content: '稳定锚点' }] };
    const id1 = t.identify(body, 'u', '2026-01-01');
    t.reset();
    const id2 = t.identify(body, 'u', '2026-01-02');
    expect(id2).toBe(id1);
  });

  it('OpenAI-Responses 协议（body.input）也能识别', () => {
    const t = new SessionTracker();
    const body = { input: [{ role: 'user', content: 'resp 协议' }] };
    const id = t.identify(body, 'https://api.openai.com/v1/responses', '2026-01-01');
    expect(id).toMatch(/^thread_/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/session-tracker.test.ts`
Expected: FAIL（`SessionTracker` 未导出）

- [ ] **Step 3: 追加 `SessionTracker` 类到 `server/session-tracker.ts`**

在文件末尾追加：

```ts
export class SessionTracker {
  private sessions = new Map<string, SessionLineage[]>(); // anchorKey → lineages

  /** 给一个请求算 threadId（undefined=未归类）。必须传完整原始 body。 */
  identify(body: unknown, url: string, timestamp: string): string | undefined {
    const extracted = extractContext(body, url);
    if (!extracted || !extracted.messages.length) return undefined;
    const messages = extracted.messages as LikeMessage[];
    const anchorKey = computeAnchorKey(messages);
    if (!anchorKey) return undefined;
    const fpSeq = computeFingerprintSeq(messages);

    const lineages = this.sessions.get(anchorKey) ?? [];
    const cont = findContinuation(lineages, fpSeq);

    let threadId: string;
    if (cont) {
      cont.msgFingerprints = fpSeq;
      cont.lastTimestamp = timestamp;
      cont.requestCount++;
      threadId = cont.threadId;
    } else {
      const n = lineages.length + 1;
      threadId = n === 1 ? anchorKey : `${anchorKey}-${n}`;
      lineages.push({ threadId, msgFingerprints: fpSeq, lastTimestamp: timestamp, requestCount: 1 });
      this.sessions.set(anchorKey, lineages);
      this.cleanup();
    }
    dbg('identify threadId=%s anchor=%s fpLen=%d', threadId, anchorKey, fpSeq.length);
    return threadId;
  }

  /** MVP no-op：delta 格式历史 entry 无完整 messages，重建会算错锚点；
   *  threadId 内容寻址已保证分组正确，活跃会话链自然重建。 */
  rebuildFromLogs(_entries: unknown[]): void {
    // 故意留空，见 spec deviation #1
  }

  reset(): void {
    this.sessions.clear();
  }

  private cleanup(): void {
    if (this.sessions.size <= MAX_SESSIONS) return;
    const sorted = [...this.sessions.entries()].sort((a, b) => {
      const aLast = Math.max(...a[1].map(l => new Date(l.lastTimestamp).getTime() || 0));
      const bLast = Math.max(...b[1].map(l => new Date(l.lastTimestamp).getTime() || 0));
      return aLast - bLast;
    });
    for (const [key] of sorted.slice(0, this.sessions.size - MAX_SESSIONS)) {
      this.sessions.delete(key);
    }
  }
}

export const globalSessionTracker = new SessionTracker();
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/session-tracker.test.ts`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add server/session-tracker.ts tests/session-tracker.test.ts
git commit -m "feat(thread): SessionTracker.identify（续/分叉/未归类）+ 内容寻址单测"
```

---

## Task 4: interceptor 接入

**Files:**
- Modify: `server/interceptor.ts`（`buildRequestEntry` L217-261）

- [ ] **Step 1: 在 `buildRequestEntry` 里接入 identify**

在 [server/interceptor.ts:228](../../../server/interceptor.ts#L228) `const { agentType, subAgentType } = parseAgentType(...)` 之后插入：

```ts
  const threadId = agentType === 'main'
    ? globalSessionTracker.identify(body, urlStr, new Date().toISOString())
    : undefined;
```

在文件顶部 import 区（其他 `import ... from './...'` 旁）加：

```ts
import { globalSessionTracker } from './session-tracker.js';
```

在 [server/interceptor.ts:241-260](../../../server/interceptor.ts#L241) 的 `return { ... }` 对象里，`endpointType: endpointType || undefined,` 之后加：

```ts
    threadId,
```

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无新增错误

- [ ] **Step 3: 跑全量单测确认未破坏**

Run: `npx vitest run`
Expected: 全部 PASS（含现有 tests/log-reader.test.ts 等）

- [ ] **Step 4: 手动验证（可选）**

启动代理 `npm run dev` 或对应脚本，用测试客户端发 2 次同会话请求，检查 jsonl 里两条 entry 的 `threadId` 相同。

- [ ] **Step 5: Commit**

```bash
git add server/interceptor.ts
git commit -m "feat(thread): interceptor 在 buildRequestEntry(delta前) 给 main 请求填 threadId"
```

---

## Task 5: 数据透传链（后端 normalize + 前端 formatLog）

**Files:**
- Modify: `server/services/log-reader.ts`（`normalizeLogEntry` L98-140）
- Modify: `src/hooks/useLogs.ts`（`formatLog` L21-48）

- [ ] **Step 1: 后端 `normalizeLogEntry` 透传**

在 [server/services/log-reader.ts:138](../../../server/services/log-reader.ts#L138) `endpointType: raw.endpointType,` 之后加：

```ts
    threadId: raw.threadId,
```

- [ ] **Step 2: 前端 `formatLog` 透传**

在 [src/hooks/useLogs.ts:47](../../../src/hooks/useLogs.ts#L47) `endpointType: log.endpointType as LogEntry['endpointType'],` 之后加：

```ts
    threadId: log.threadId,
```

- [ ] **Step 3: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无新增错误

- [ ] **Step 4: Commit**

```bash
git add server/services/log-reader.ts src/hooks/useLogs.ts
git commit -m "feat(thread): threadId 透传（normalizeLogEntry + formatLog）"
```

---

## Task 6: 删除死代码 context-rebuilder

**Files:**
- Delete: `server/context-rebuilder.ts`

- [ ] **Step 1: 再次确认零引用**

Run: `grep -rn "context-rebuilder\|ContextRebuilder" server src tests bin scripts --include="*.ts" --include="*.tsx" | grep -v "server/context-rebuilder.ts"`
Expected: 无输出

- [ ] **Step 2: 删除文件**

Run: `git rm server/context-rebuilder.ts`

- [ ] **Step 3: 类型检查 + 测试**

Run: `npx tsc --noEmit && npx vitest run`
Expected: 无错误，全部 PASS

- [ ] **Step 4: Commit**

```bash
git commit -m "refactor(thread): 删除死代码 ContextRebuilder（被 SessionTracker 取代）"
```

---

## Task 7: 前端 groupByThread 纯函数 + 单测

**Files:**
- Create: `src/utils/group-by-thread.ts`
- Create: `tests/group-by-thread.test.ts`

- [ ] **Step 1: 写失败测试 `tests/group-by-thread.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { groupByThread } from '../src/utils/group-by-thread.js';
import type { LogEntry } from '../src/types.js';

function mkLog(partial: Partial<LogEntry>): LogEntry {
  return {
    id: partial.id ?? 'x',
    timestamp: partial.timestamp ?? '2026-01-01T00:00:00Z',
    request: partial.request ?? { method: 'POST', url: 'u', headers: {}, body: { model: 'm', messages: [] } },
    response: partial.response ?? { status: 200, statusText: 'OK', headers: {}, body: {} },
    agentType: partial.agentType ?? 'main',
    duration: partial.duration ?? 0,
    metadata: partial.metadata ?? { model: 'm', provider: 'claude', stream: false },
    ...partial,
  } as LogEntry;
}

describe('groupByThread', () => {
  it('同 threadId 的 main 请求归一组', () => {
    const logs = [
      mkLog({ id: '1', threadId: 'thread_a', timestamp: '2026-01-01T00:00:00Z' }),
      mkLog({ id: '2', threadId: 'thread_a', timestamp: '2026-01-01T00:00:01Z' }),
      mkLog({ id: '3', threadId: 'thread_b', timestamp: '2026-01-01T00:00:02Z' }),
    ];
    const { groups, ungrouped } = groupByThread(logs);
    expect(groups).toHaveLength(2);
    const a = groups.find(g => g.threadId === 'thread_a')!;
    expect(a.mainLogs).toHaveLength(2);
    expect(a.mainLogs.map(l => l.id)).toEqual(['1', '2']); // 组内时间升序
  });

  it('无 threadId 的 sub 归属时间不晚于它的最近 main 会话', () => {
    const logs = [
      mkLog({ id: 'm1', threadId: 'thread_a', agentType: 'main', timestamp: '2026-01-01T00:00:00Z' }),
      mkLog({ id: 's1', threadId: undefined, agentType: 'sub', timestamp: '2026-01-01T00:00:01Z' }),
      mkLog({ id: 'm2', threadId: 'thread_a', agentType: 'main', timestamp: '2026-01-01T00:00:02Z' }),
    ];
    const { groups } = groupByThread(logs);
    const a = groups.find(g => g.threadId === 'thread_a')!;
    expect(a.subLogs.map(l => l.id)).toEqual(['s1']);
  });

  it('无 threadId 且无邻近 main → ungrouped', () => {
    const logs = [mkLog({ id: 's1', threadId: undefined, agentType: 'sub', timestamp: '2026-01-01T00:00:00Z' })];
    const { groups, ungrouped } = groupByThread(logs);
    expect(groups).toHaveLength(0);
    expect(ungrouped.map(l => l.id)).toEqual(['s1']);
  });

  it('token 汇总与时间跨度正确', () => {
    const logs = [
      mkLog({ id: '1', threadId: 'thread_a', timestamp: '2026-01-01T00:00:00Z', tokenUsage: { input_tokens: 100, output_tokens: 50 } }),
      mkLog({ id: '2', threadId: 'thread_a', timestamp: '2026-01-01T00:10:00Z', tokenUsage: { input_tokens: 200, output_tokens: 50 } }),
    ];
    const { groups } = groupByThread(logs);
    const a = groups[0];
    expect(a.totalTokens).toBe(400);
    expect(a.startTime).toBe('2026-01-01T00:00:00Z');
    expect(a.endTime).toBe('2026-01-01T00:10:00Z');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/group-by-thread.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `src/utils/group-by-thread.ts`**

```ts
import type { LogEntry } from '../types';

export interface ThreadGroup {
  threadId: string;
  title: string;
  mainLogs: LogEntry[];
  subLogs: LogEntry[];
  totalTokens: number;
  startTime: string;
  endTime: string;
}

export interface GroupResult {
  groups: ThreadGroup[];
  ungrouped: LogEntry[];
}

function tokenSum(log: LogEntry): number {
  const u = log.tokenUsage;
  return (u?.input_tokens ?? 0) + (u?.output_tokens ?? 0);
}

/** 首条 user 文本摘要作标题 */
function deriveTitle(logs: LogEntry[]): string {
  for (const log of logs) {
    const msgs = (log.request?.body as any)?.messages;
    if (Array.isArray(msgs)) {
      const u = msgs.find((m: any) => m.role === 'user');
      const text = typeof u?.content === 'string' ? u.content
        : Array.isArray(u?.content) ? (u.content as any[]).map((b: any) => b?.text ?? '').join('')
        : '';
      if (text) return text.replace(/\s+/g, ' ').slice(0, 40);
    }
  }
  return '（无标题）';
}

/**
 * 按 threadId 分组。sub 请求（无 threadId）归属 timestamp 不晚于它的最近 main 会话。
 * 输入 logs 通常按时间倒序（来自 useLogs），组内统一转升序便于展示。
 */
export function groupByThread(logs: LogEntry[]): GroupResult {
  const byThread = new Map<string, LogEntry[]>();
  const ungrouped: LogEntry[] = [];

  // 先收集所有 main（有 threadId），按时间升序处理以正确归属 sub
  const ascending = [...logs].sort((a, b) =>
    new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  const threadStart: { threadId: string; time: number }[] = [];
  for (const log of ascending) {
    if (log.threadId) {
      if (!byThread.has(log.threadId)) {
        byThread.set(log.threadId, []);
        threadStart.push({ threadId: log.threadId, time: new Date(log.timestamp).getTime() });
      }
      byThread.get(log.threadId)!.push(log);
    }
  }
  threadStart.sort((a, b) => a.time - b.time);

  const subAssign = new Map<string, LogEntry[]>(); // threadId → subs
  for (const log of ascending) {
    if (log.threadId) continue;
    // 归属 timestamp 不晚于 sub 的最近 main 会话
    const t = new Date(log.timestamp).getTime();
    let target: string | undefined;
    for (const ts of threadStart) {
      if (ts.time <= t) target = ts.threadId;
      else break;
    }
    if (target) {
      if (!subAssign.has(target)) subAssign.set(target, []);
      subAssign.get(target)!.push(log);
    } else {
      ungrouped.push(log);
    }
  }

  const groups: ThreadGroup[] = [];
  for (const [threadId, mainLogs] of byThread) {
    const subs = subAssign.get(threadId) ?? [];
    const all = [...mainLogs, ...subs];
    const totalTokens = all.reduce((sum, l) => sum + tokenSum(l), 0);
    const times = all.map(l => new Date(l.timestamp).getTime());
    groups.push({
      threadId,
      title: deriveTitle(mainLogs),
      mainLogs,
      subLogs: subs,
      totalTokens,
      startTime: mainLogs[0]?.timestamp ?? '',
      endTime: mainLogs[mainLogs.length - 1]?.timestamp ?? '',
    });
  }
  // 组按 startTime 降序（最新会话在前）
  groups.sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime());

  return { groups, ungrouped };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/group-by-thread.test.ts`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add src/utils/group-by-thread.ts tests/group-by-thread.test.ts
git commit -m "feat(thread): 前端 groupByThread 纯函数(分组/sub时间邻近附属) + 单测"
```

---

## Task 8: Preferences conversationView 默认值

**Files:**
- Modify: `src/contexts/SettingsContext.tsx`（默认 preferences）

- [ ] **Step 1: 加默认值**

在 [src/contexts/SettingsContext.tsx:10](../../../src/contexts/SettingsContext.tsx#L10) `autoCollapse: true,` 所在的默认 preferences 对象里加：

```ts
    conversationView: 'timeline',
```

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无新增错误（`conversationView` 类型已在 Task 1 加进 `Preferences`）

- [ ] **Step 3: Commit**

```bash
git add src/contexts/SettingsContext.tsx
git commit -m "feat(thread): Preferences 默认 conversationView='timeline'"
```

---

## Task 9: LogListPanel 会话视图

**Files:**
- Modify: `src/components/dashboard/LogListPanel.tsx`
- Modify: LogListPanel 的父组件（先定位——`grep -rn "LogListPanel" src` 找渲染处，大概率 `src/App.tsx`）

- [ ] **Step 1: 定位父组件**

Run: `grep -rn "<LogListPanel" src`
确认在哪个文件渲染、props 怎么传。记录文件:行号。

- [ ] **Step 2: `LogListPanel` 加 props 与视图分支**

在 [src/components/dashboard/LogListPanel.tsx:14](../../../src/components/dashboard/LogListPanel.tsx#L14) `interface LogListPanelProps` 末尾（`onEndpointFilterChange` 后）加：

```ts
  conversationView: 'timeline' | 'session';
  onConversationViewChange: (v: 'timeline' | 'session') => void;
```

在文件顶部 import 区加：

```ts
import { groupByThread } from '../../utils/group-by-thread';
import type { ThreadGroup } from '../../utils/group-by-thread';
```

在 [src/components/dashboard/LogListPanel.tsx:98](../../../src/components/dashboard/LogListPanel.tsx#L98) 解构 props 处加 `conversationView, onConversationViewChange`。

在 Header（[:157](../../../src/components/dashboard/LogListPanel.tsx#L157) `<Text>通信记录</Text>` 旁的 `ml-auto` 容器最前）插入视图切换：

```tsx
          <div className="flex items-center rounded-md border border-border-subtle overflow-hidden shrink-0">
            <button
              onClick={() => onConversationViewChange('timeline')}
              className={`px-2.5 py-0.5 text-[13px] font-[510] transition-colors ${
                conversationView === 'timeline' ? 'bg-bg-active text-text-primary' : 'text-text-quaternary hover:text-text-secondary bg-bg-deep'
              }`}
            >时间线</button>
            <button
              onClick={() => onConversationViewChange('session')}
              className={`px-2.5 py-0.5 text-[13px] font-[510] transition-colors ${
                conversationView === 'session' ? 'bg-bg-active text-text-primary' : 'text-text-quaternary hover:text-text-secondary bg-bg-deep'
              }`}
            >会话</button>
          </div>
```

- [ ] **Step 3: 抽出单个 log 行渲染为 `LogRow` 子组件（DRY，两种视图复用）**

在 `LogListPanel` 函数前加：

```tsx
function LogRow({
  log, isSelected, onSelect, getAgentTypeTag, shortenModel, shortenUrl, formatDuration,
}: {
  log: LogEntry;
  isSelected: boolean;
  onSelect: (id: string) => void;
  getAgentTypeTag: (a: AgentType) => { tag: JSX.Element; color: string };
  shortenModel: (m: string) => string;
  shortenUrl: (u: string) => string;
  formatDuration: (ms: number) => string;
}) {
  const { tag: agentTag, color: agentColor } = getAgentTypeTag(log.agentType);
  return (
    <div
      onClick={() => onSelect(log.id)}
      className={`mb-2 p-2 rounded-lg flex flex-col gap-1.5 cursor-pointer transition-colors duration-150 border ml-3 ${
        isSelected ? 'bg-bg-elevated border-brand-accent' : 'bg-bg-surface border-border-subtle hover:border-border-primary'
      }`}
    >
      <div className="flex items-center gap-1.5 text-sm leading-[1.3] min-w-0">
        {agentTag}
        <span className={`truncate flex-1 min-w-0 font-[510] ${agentColor}`} title={log.metadata.model}>
          {shortenModel(log.metadata.model)}
        </span>
        <span className={`shrink-0 text-xs px-1 rounded border ${
          resolveResponseType(log.response?.headers['content-type'], log.metadata.stream) === 'sse'
            ? 'text-brand-accent border-brand-accent/30' : 'text-text-quaternary border-border-subtle'
        }`}>
          {resolveResponseType(log.response?.headers['content-type'], log.metadata.stream) === 'sse' ? 'SSE' : 'JSON'}
        </span>
        <TimeWithTooltip timestamp={log.timestamp} />
      </div>
      <div className="flex items-center gap-1 text-[13px] leading-[1.3] min-w-0">
        <span className="shrink-0"><ProviderIcon providerName={log.providerName || ''} size={14} /></span>
        <span className="text-text-quaternary truncate flex-1 min-w-0" title={log.request.url}>{shortenUrl(log.request.url)}</span>
        <span className="shrink-0 text-text-tertiary text-right">{log.duration > 0 ? formatDuration(log.duration) : '-'}</span>
        {log.response && <span className={`font-[510] shrink-0 ${getStatusColor(log.response.status)}`}>{log.response.status}</span>}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: 把现有 `logs.map` 列表替换为「按视图分支」**

将 [src/components/dashboard/LogListPanel.tsx:234-306](../../../src/components/dashboard/LogListPanel.tsx#L234) 的 `{logs.map((log) => { ... })}` 替换为：

```tsx
          {conversationView === 'timeline' ? (
            logs.map((log) => (
              <LogRow key={log.id} log={log} isSelected={selectedId === log.id} onSelect={onSelectLog}
                getAgentTypeTag={getAgentTypeTag} shortenModel={shortenModel}
                shortenUrl={shortenUrl} formatDuration={formatDuration} />
            ))
          ) : (
            <SessionListView logs={logs} selectedId={selectedId} onSelectLog={onSelectLog}
              getAgentTypeTag={getAgentTypeTag} shortenModel={shortenModel}
              shortenUrl={shortenUrl} formatDuration={formatDuration} />
          )}
```

- [ ] **Step 5: 新增 `SessionListView` 组件（同文件，`LogListPanel` 前）**

```tsx
function SessionListView({ logs, selectedId, onSelectLog, getAgentTypeTag, shortenModel, shortenUrl, formatDuration }: {
  logs: LogEntry[];
  selectedId: string | null;
  onSelectLog: (id: string) => void;
  getAgentTypeTag: (a: AgentType) => { tag: JSX.Element; color: string };
  shortenModel: (m: string) => string;
  shortenUrl: (u: string) => string;
  formatDuration: (ms: number) => string;
}) {
  const { groups, ungrouped } = useMemo(() => groupByThread(logs), [logs]);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const toggle = (id: string) => setCollapsed(p => ({ ...p, [id]: !p[id] }));

  return (
    <>
      {groups.map((g) => (
        <div key={g.threadId} className="mb-2">
          <button onClick={() => toggle(g.threadId)}
            className="w-full flex items-center gap-2 p-2 rounded-lg bg-bg-surface border border-border-subtle hover:border-border-primary text-left">
            <ChevronIcon expanded={!collapsed[g.threadId]} />
            <span className="truncate flex-1 min-w-0 text-[13px] font-[510] text-text-secondary">{g.title}</span>
            <span className="shrink-0 text-xs text-text-quaternary">{g.mainLogs.length + g.subLogs.length} 请求</span>
            <span className="shrink-0 text-xs text-text-quaternary tabular-nums">{g.totalTokens} tok</span>
          </button>
          {!collapsed[g.threadId] && (
            <div className="mt-1">
              {[...g.mainLogs, ...g.subLogs]
                .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
                .map((log) => (
                  <LogRow key={log.id} log={log} isSelected={selectedId === log.id} onSelect={onSelectLog}
                    getAgentTypeTag={getAgentTypeTag} shortenModel={shortenModel}
                    shortenUrl={shortenUrl} formatDuration={formatDuration} />
                ))}
            </div>
          )}
        </div>
      ))}
      {ungrouped.length > 0 && (
        <div className="mt-2">
          <button onClick={() => toggle('__ungrouped')}
            className="w-full flex items-center gap-2 p-2 rounded-lg bg-bg-surface border border-border-subtle text-left">
            <ChevronIcon expanded={!collapsed['__ungrouped']} />
            <span className="text-[13px] font-[510] text-text-quaternary">未归类 ({ungrouped.length})</span>
          </button>
          {!collapsed['__ungrouped'] && ungrouped.map((log) => (
            <LogRow key={log.id} log={log} isSelected={selectedId === log.id} onSelect={onSelectLog}
              getAgentTypeTag={getAgentTypeTag} shortenModel={shortenModel}
              shortenUrl={shortenUrl} formatDuration={formatDuration} />
          ))}
        </div>
      )}
    </>
  );
}
```

> `ChevronIcon` 已在 [DetailPanel.tsx:39](../../../src/components/viewer/DetailPanel.tsx#L39) 定义——把它抽到 `src/components/common/ChevronIcon.tsx` 导出，两处共用；或在本文件内联一个等效 svg。执行时选其一，保持 DRY。
>
> **import 修正**：[LogListPanel.tsx:1](../../../src/components/dashboard/LogListPanel.tsx#L1) 的 `import { useState, useEffect, useRef } from 'react'` 改为 `import { useState, useEffect, useRef, useMemo } from 'react'`（`SessionListView` 用 `useMemo`）；`getStatusColor`、`resolveResponseType`、`ProviderIcon` 已在文件内引入。

- [ ] **Step 6: 父组件传 props + toggle**

在 Step 1 定位的父组件（如 `src/App.tsx`）里：
- 从 `useSettings()`（或对应 hook）取 `preferences.conversationView` 与 `updatePreferences`
- 给 `<LogListPanel>` 传 `conversationView={preferences.conversationView}` 和 `onConversationViewChange={(v) => updatePreferences({ conversationView: v })}`

- [ ] **Step 7: 类型检查 + 构建**

Run: `npx tsc --noEmit && npm run build`
Expected: 无错误

- [ ] **Step 8: Commit**

```bash
git add src/components/dashboard/LogListPanel.tsx src/App.tsx src/components/common/ChevronIcon.tsx
git commit -m "feat(thread): LogListPanel 会话视图（视图切换 + 分组折叠 + sub 附属）"
```

---

## Task 10: e2e 测试

**Files:**
- Create: `tests/conversation-e2e.test.ts`（参考现有 `tests/*-e2e.test.ts` 风格）

- [ ] **Step 1: 先读一个现有 e2e 摸清启动/访问约定**

Run: `sed -n '1,60p' tests/anthropic-e2e.test.ts`（或 Read）
记录：如何起服务、注入测试日志（`LUCENT_CONFIG_DIR` 隔离）、访问页面、断言。

- [ ] **Step 2: 写 e2e**

覆盖：
- 注入 2 条同 `threadId` 的 main 日志 + 1 条 sub → 会话视图出现一组含 2 main + 1 sub，点开能选中
- 视图切到「会话」后刷新页面，仍停留在「会话」（Preferences 持久化）
- 切回「时间线」恢复 flat 列表

（具体代码依 Step 1 的约定编写，注入固定 `threadId` 的 jsonl fixture）

- [ ] **Step 3: 跑 e2e**

Run: `npx vitest run tests/conversation-e2e.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add tests/conversation-e2e.test.ts
git commit -m "test(thread): 会话视图 e2e（分组/附属/视图持久化）"
```

---

## 完成验证（全部任务后）

- [ ] `npx tsc --noEmit` 无错误
- [ ] `npx vitest run` 全绿（含 session-tracker、group-by-thread、conversation-e2e + 现有测试）
- [ ] `npm run build` 成功
- [ ] spec 验收清单 AC1-AC6、AC8-AC14 全部满足（AC7 按 deviation 调整）
- [ ] 更新 spec 第 9.2 测试轮次记录表

## 并发执行建议（subagent-driven）

- **Wave 1**: Task 1（基础，阻塞）
- **Wave 2（并发 5 路）**: Task 2 / Task 5 / Task 6 / Task 7 / Task 8
- **Wave 3**: Task 3（依赖 2）
- **Wave 4（并发 2 路）**: Task 4（依赖 3）/ Task 9 前半可启动（依赖 7、8）
- **Wave 5**: Task 9 完成 + Task 10
