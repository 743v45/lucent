# 会话串联（Conversation Threading）设计

- 日期：2026-06-13
- 状态：已实现（v3 — 同步重建 no-op deviation）
- 关联：跨日志会话聚合（用户诉求 B）

## Spec Deviations（实现时调整）

1. **重启重建降级为 no-op**：`rebuildFromLogs` 空实现，`index.ts` 不调用。原因：jsonl 中 main 请求 `body.messages` 被 delta-storage slice（[delta-storage.ts:116](../../../server/delta-storage.ts#L116)），历史 entry 无完整 messages，重建会算错锚点。`threadId` 内容寻址已保证分组正确 + 活跃会话链随新请求自然重建，故 MVP 跳过。完整重建（需 delta 解压）留后续迭代。

## 1. 背景与目标

### 1.1 问题

Lucent 是 LLM 代理查看器，日志按 `.jsonl` 存储，每条 `LogEntry` 对应一次 HTTP 请求。Anthropic / OpenAI 三协议均**无状态**，客户端（Claude Code / Codex 等）每次请求携带完整对话历史。因此同一会话的多次请求在日志里是彼此独立的 `LogEntry`，无法看出「这些请求属于同一段对话」。

### 1.2 目标

将同一会话的多次 `main` 请求串联起来，在日志列表里按会话分组展示，可折叠/展开查看每次请求。

### 1.3 非目标（YAGNI）

- 不做「合并完整对话流」展示（后续迭代）
- 不回填历史无 `threadId` 的日志（MVP limitation，第 8 节）
- 不给 `sub` 请求算会话归属字段（时间邻近附属，第 7 节）
- 不重命名 delta-storage 误命名的 `_conversationId`（留 TODO，避免 scope 蔓延）

## 2. 现状分析

| 事实 | 位置 |
|---|---|
| 日志存储：`.jsonl`，每条 `LogEntry` 一行 | [log-manager.ts:66](../../../server/log-manager.ts#L66)、[:87](../../../server/log-manager.ts#L87) |
| `LogEntry` 无任何会话标识字段 | [src/types.ts:6](../../../src/types.ts#L6) |
| **`RawLogEntry._conversationId` 已存在但恒为 `'mainAgent'`**，是 delta 链标签，非会话 id | [delta-storage.ts:108](../../../server/delta-storage.ts#L108)、[:119](../../../server/delta-storage.ts#L119) |
| delta-storage 已做前缀增长/in-place replace 检测（单链压缩） | [delta-storage.ts:67](../../../server/delta-storage.ts#L67) `processDelta` |
| `ContextRebuilder` 是死代码（零外部引用） | [context-rebuilder.ts](../../../server/context-rebuilder.ts) |
| entry 组装点 | [interceptor.ts:217](../../../server/interceptor.ts#L217) `buildRequestEntry` |
| `agentType` 识别（main/sub） | [interceptor.ts:228](../../../server/interceptor.ts#L228) `parseAgentType` |
| delta slice 在组装**之后**发生 | [interceptor.ts:263](../../../server/interceptor.ts#L263) `processDeltaForMainAgent`（mutate `entry.body.messages`） |
| 客户端每次带完整 `messages` | 由 `extractContext` 解析，[context-extractors.ts:172](../../../server/context-extractors.ts#L172) |

**串联抓手**：同一会话第 k+1 次请求的 `messages` **严格包含**第 k 次请求的 `messages`（前缀单调增长）。这是无状态协议下识别同会话的唯一可靠信号。

## 3. 数据模型

`LogEntry` 新增**顶层**字段 `threadId`（前后端类型同步：[src/types.ts:6](../../../src/types.ts#L6) 与 `server/types.ts` `LogEntry` / `RawLogEntry`）：

```ts
export interface LogEntry {
  // ...现有字段
  /** 会话线索标识：同一对话（首条 user 消息锚定）的多次请求共享。
   *  格式 thread_<djb2base36>；同锚点分叉时加后缀 -2、-3。
   *  仅 main 请求填充；sub 请求留空（前端按时间邻近附属）。
   *  注意：与 RawLogEntry._conversationId（delta 链标签，恒 'mainAgent'）无关。 */
  threadId?: string;
}
```

- **落库**：随现有 `appendFileSync`（[log-manager.ts:87](../../../server/log-manager.ts#L87)）自然写入；jsonl 向后兼容（旧 entry 无此字段 → 视为「未归类」）
- **读取**：现有 `readLogs` 原样带出，前端 groupBy，无需新接口
- **命名避撞**：刻意用 `threadId` 而非 `conversationId`，避开 `_conversationId`（delta 标签）的视觉混淆

## 4. 会话识别算法

### 4.1 Step 1 · 锚点提取

取请求 `messages` 里首条 `role==='user'` 消息，提取文本 → normalize（去空白、截前 `CHECKPOINT_KEY_CONTENT_LENGTH=50` 字符，[constants.ts:105](../../../server/constants.ts#L105)）→ `anchorKey = thread_${djb2base36(content)}`。djb2 算法复用 [context-rebuilder.ts:226-230](../../../server/context-rebuilder.ts#L226)（已验证）。

### 4.2 Step 2 · 前缀校验（核心）

为避免逐字符比对超长 messages，用**指纹序列**比对：

```
每条 message 指纹 = hash(role + normalize(内容前 N 字符))
messages 数组 → 指纹序列 [f1, f2, ..., fk]
```

内存链 `Map<anchorKey, SessionLineage[]>`，`SessionLineage = { threadId, msgFingerprints, lastTimestamp, requestCount }`。当前请求进来：

| 情况 | 判定 | 结果 |
|---|---|---|
| **续** | lineage 里某会话的 `msgFingerprints` 是当前指纹序列的**前缀** | 归该会话，更新其 `msgFingerprints` 为当前完整序列、`requestCount++` |
| **分叉** | 同 `anchorKey` 存在，但**无**任何会话前缀匹配 | 拆新分会话 `thread_<hash>-<n>`（n 递增） |
| **新会话** | `anchorKey` 全新 | `thread_<hash>` |

多个会话同时前缀匹配（罕见，并发/重放）→ 取 `lastTimestamp` 最近的。

### 4.3 归属语义

「同会话」= 同一首条 user 消息且每次请求都在前一会话基础上单调增长（messages 只增不改）。客户端改写历史或重开同款开场白 → 前缀校验拆为分会话。

## 5. SessionTracker 模块

**新建 `server/session-tracker.ts`**（职责单一，替代死代码 `ContextRebuilder`）：

```ts
class SessionTracker {
  private sessions = new Map<string, SessionLineage[]>();  // 内存会话链

  /** 核心：给定请求，返回 threadId（或 undefined=未归类）。
   *  必须传入【完整原始 body】（delta slice 之前），因 delta 格式下 body.messages 被截断。 */
  identify(body: unknown, url: string, timestamp: string): string | undefined
  /** 启动重建：replay 所有 entry 重建链 */
  rebuildFromLogs(entries: LogEntry[]): void
  reset(): void  // 测试用
}
export const globalSessionTracker = new SessionTracker();
```

**纯函数拆分**（单测友好，仿 `buildAccessLines` 抽纯函数的做法）：
- `computeAnchorKey(messages)` / `computeFingerprintSeq(messages)` / `findContinuation(lineage, fpSeq)`

**常量**：`MAX_SESSIONS`（新加 [constants.ts](../../../server/constants.ts)，值参考 `MAX_CONTEXT_CHECKPOINTS=100`，[constants.ts:104](../../../server/constants.ts#L104)）；复用 `CHECKPOINT_KEY_CONTENT_LENGTH`、`MAX_LOG_FILES_TO_READ`。

**调用点（关键约束）**：[interceptor.ts:217](../../../server/interceptor.ts#L217) `buildRequestEntry` 中，[:228](../../../server/interceptor.ts#L228) 拿到 `agentType` 后——若 `main`，调 `globalSessionTracker.identify(body, urlStr, timestamp)` 填 `entry.threadId`。

> **必须在 `processDeltaForMainAgent`（[:263](../../../server/interceptor.ts#L263)）之前完成**——`processDelta` 会 mutate `entry.body.messages`（slice 成增量，[delta-storage.ts:116-121](../../../server/delta-storage.ts#L116)）。`identify` 接收的是函数参数 `body`（原始完整），不是 `entry.body`，故即使后续 slice 也不影响。`buildRequestEntry` 内调用天然满足此约束。

**重启重建（MVP no-op，见开头 Spec Deviations #1）**：`rebuildFromLogs` 空实现，`index.ts` 不调用。`threadId` 内容寻址保证重启后 id 稳定，活跃会话链随新请求自然重建。

**删死代码**：`server/context-rebuilder.ts`（已确认零引用）。

## 6. 与 delta-storage 的边界

两者都观察 `messages` 增长，但职责完全不同，**MVP 不合并**：

| 维度 | delta-storage | SessionTracker |
|---|---|---|
| 职责 | 存储压缩（省空间） | 会话归属（分组） |
| 状态 | 模块级全局单链（`lastMessagesCount`/`lastTailFp`） | 多会话 `Map<anchorKey, lineage[]>` |
| 决策 | checkpoint vs delta slice | 续/分叉/新会话 |
| 标识字段 | `_conversationId`（恒 `'mainAgent'`） | `threadId`（内容寻址，每会话不同） |

**协作约束**：`SessionTracker.identify` 必须读完整 body（delta slice 前）；执行顺序 = `buildRequestEntry`（含 identify）→ `processDeltaForMainAgent`（slice）。两者独立，identify 的输出 `threadId` 不影响 delta 压缩逻辑。

**遗留**：`_conversationId`（delta 标签）是历史误命名，重命名为 `_deltaChainId` 留 TODO，不在本 scope。

## 7. 前端列表分组

**接入** [LogListPanel.tsx](../../../src/components/dashboard/LogListPanel.tsx)，顶部加视图切换：

```
[ 时间线 ] [ 会话 ]   ← toggle，选择持久化进 Preferences
```

- **时间线视图** = 现状，不动
- **会话视图**：
  - 纯前端对已加载 logs 按 `threadId` groupBy（零新接口，entry 已带字段）
  - 每个会话一个**可折叠节点**，标题行：首条 user 摘要 · `(N 请求)` · token 汇总 · 时间跨度
  - 展开后：该会话每次 `main` 请求一行（时间/模型/token/状态），点击 → 现有 [DetailPanel](../../../src/components/viewer/DetailPanel.tsx)
  - **sub 请求附属**：无 `threadId`，归属到 `timestamp` **不晚于它**的最近一个 main 会话节点下（sub 是该会话 main 请求调度产生的，向前归属语义正确）；纯时间序，无归属算法
  - 无 `threadId` 又无邻近 main 的孤立请求 → 「未归类」组（折叠在底部）

**Preferences 持久化**：新增 `conversationView: 'timeline' | 'session'`，仿 [types.ts:200](../../../src/types.ts#L200) 现有 `autoCollapse` 同款机制。

**纯函数** `groupByThread(logs)`：分组/未归类/sub 时间邻近附属逻辑集中于此，单测覆盖。

## 8. 错误处理 / 边界

| 边界 | 处理 |
|---|---|
| **三协议 messages 字段位置不同** | `identify(body, url, ts)` 内部复用 [extractContext](../../../server/context-extractors.ts#L172) 统一提取（OpenAI-Responses 在 `body.input`，[:150](../../../server/context-extractors.ts#L150)），调用方只传原始 body+url |
| **delta 格式 entry** | identify 永远收完整原始 body（调用约束，第 5 节），不受 delta slice 影响 |
| **首条 user 缺失** | `identify` 返回 `undefined` → 不填字段 → 前端归「未归类」 |
| **threadId 稳定性（关键优点）** | id 由首条 user 内容**内容寻址**生成。内存链全清/重启后，同会话重算 id 完全一致——LRU 清理与重建不打乱分组 |
| **分叉后又切回原分支** | lineage 每个分会话独立维护 `msgFingerprints`，切回原分支仍前缀匹配原主会话 |
| **并发请求**（同历史快速连发） | messages 相同 → 同 anchorKey 同指纹 → 都归同一会话，`requestCount` 各计，无竞争 |
| **内存链上限** `MAX_SESSIONS` | LRU 清最旧 anchorKey；id 内容寻址，清理后下次同会话请求重算出相同 id |
| **重启重建范围** | 扫最近 20 个文件。超长会话跨 >20 文件（≈4GB 日志）时中间可能断链成分会话——可接受极端情况 |
| **历史日志无 threadId**（MVP limitation） | 旧 entry 不回填，前端归「未归类」。后续可加批量回填 |

## 9. 验收清单

### 9.1 功能验收清单

| 编号 | 验收项 | 验证方式 |
|---|---|---|
| AC1 | 同一会话多次 main 请求共享同一 `threadId` | 单测 `identify` 续场景 |
| AC2 | 同锚点但 messages 分叉 → 生成不同分会话 id（`-2`、`-3`） | 单测 `identify` 分叉场景 |
| AC3 | 首条 user 缺失 → `threadId` 为空 → 归「未归类」 | 单测 + e2e |
| AC4 | 仅 main 请求填字段，sub 请求留空 | 单测 + e2e |
| AC5 | 三协议（anthropic/openai-chat/openai-responses）均正确提取首条 user | 单测 |
| AC6 | **delta 格式下识别仍正确**：identify 收到完整 body，不受 slice 影响 | 单测（mock delta 前后 body） |
| AC7 | `threadId` 内容寻址：重启/清空内存链后重算 id 一致（重建为 no-op，见 Deviations #1） | 单测 `identify` reset 后一致 |
| AC8 | `threadId` 内容寻址：清空内存链重算，id 一致 | 单测 |
| AC9 | 列表会话视图：同会话请求折叠成一组，可展开看每条 | e2e |
| AC10 | sub 请求按时间邻近附属于 main 会话节点 | e2e |
| AC11 | 视图切换（时间线/会话）持久化进 Preferences | e2e |
| AC12 | 孤立请求归「未归类」组 | e2e |
| AC13 | 死代码 `ContextRebuilder` 已删除，全项目无残留引用 | grep 验证 |
| AC14 | `threadId` 与 `_conversationId` 字段并存无冲突 | 类型检查 + grep |

### 9.2 测试轮次记录

| 轮次 | 日期 | 结果 | 备注 |
|---|---|---|---|
| 第 1 轮 | 2026-06-15 | 通过 | tsc clean；298 测试全过（session-tracker 14 / group-by-thread 4 / conversation-e2e 5 + 现有 275）；final review APPROVED |

## 10. 测试策略

**单测（vitest，[vitest.config.ts](../../../vitest.config.ts)，目录 `tests/*.test.ts`）**：
- `tests/session-tracker.test.ts`：`computeAnchorKey`（正常/无 user/system-only/空）、`computeFingerprintSeq`（string vs ContentBlock[]）、`identify`（续/分叉/新会话/未归类/delta 完整 body）、`rebuildFromLogs` id 稳定性、三协议 messages 提取
- `tests/group-by-thread.test.ts`（前端纯函数）：分组/未归类/sub 时间邻近附属

**e2e（Playwright，`tests/*-e2e.test.ts` 同目录约定）**：会话视图渲染、折叠展开、点请求进详情、视图切换持久化

## 11. 实施顺序（建议）

1. 类型：`LogEntry.threadId` / `RawLogEntry.threadId`（前后端）
2. `SessionTracker` + 纯函数 + 单测
3. interceptor 接入：`buildRequestEntry` 内、main 请求、`processDeltaForMainAgent` 之前调 identify
4. index.ts 启动重建
5. 删 `context-rebuilder.ts`
6. 前端 `groupByThread` + 单测
7. LogListPanel 会话视图 + Preferences
8. e2e
