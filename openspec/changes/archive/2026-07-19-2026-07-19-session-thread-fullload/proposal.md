# 会话视图组内全量加载（sub 落 threadId + 按 threadId 全量查询）

## Why

会话视图（conversationView='session'）当前残缺：[`groupByThread`](../../src/utils/group-by-thread.ts) 是纯前端函数，
只对 `useLogs` **已加载**的 logs 分组——而 useLogs 只加载 [`PAGE_SIZE=50`](../../src/hooks/useLogs.ts#L12) 一页、
软上限 [`LOGS_SOFT_CAP=500`](../../src/hooks/useLogs.ts#L14)。后果：单个会话若请求多（长对话）或请求散落在分页之外，
会话视图里该组**只显示落在已加载范围内的部分请求**，且 sub 请求的"时间邻近附属"也只对已加载 main 生效。

根因有两个：
1. **sub 请求不打 threadId**（原设计 [2026-06-13 YAGNI 非目标](../archive/2026-07-18-2026-07-19-temp-log-mode/../../../docs/superpowers/specs/2026-06-13-conversation-threading-design.md)）——只靠前端时间邻近附属，后端无法 `WHERE thread_id=?` 全量拉一个会话。
2. **后端没有 threadId 过滤维度**——`thread_id` 列 + `idx_logs_thread` 索引建表时就有，但 `ListFilter`/`applyFilter`/`LogsQuery`/路由/前端 api 都没暴露。

## What Changes

### 后端

- **SessionTracker 加 `findRecentThread`**（[`server/session-tracker.ts`](../../server/session-tracker.ts)）：扫内存 `sessions`（anchorKey → lineages[]）所有 lineage，返回 `lastTimestamp ≤ atOrBeforeISO` 中最大者的 threadId。
- **interceptor 给 sub 落 threadId**（[`server/interceptor.ts:185`](../../server/interceptor.ts#L185)）：main 照旧 `identify`（内容寻址）；sub 调 `findRecentThread(timestamp)` 落最近 main 的 threadId，无则 undefined。这把前端 [group-by-thread.ts:67](../../src/utils/group-by-thread.ts#L67) 的时间邻近附属搬到后端，且对进程内**全量活跃 lineage** 判定（不受分页限制）。
- **threadId 过滤链**：[`ListFilter`](../../server/services/db.ts#L55) + [`applyFilter`](../../server/services/db.ts#L367) 加 `thread_id = ?`（命中 `idx_logs_thread`）；[`LogsQuery`](../../server/types.ts#L300) + [`readLogs`](../../server/services/log-reader.ts#L324) filter + [`GET /api/logs`](../../server/routes/logs.ts#L61) query 透传 threadId。复用 `/api/logs?threadId=`，不新建端点。

### 前端

- **api getLogs 加 threadId**（[`src/utils/api.ts:83`](../../src/utils/api.ts#L83)）。
- **useLogs 加 loadThread(threadId)**：按 threadId 后端拉全量（走与 visibleLogs 一致的 expiresAt 过滤）。
- **SessionListView 组内全量**（[`src/components/dashboard/LogListPanel.tsx:219`](../../src/components/dashboard/LogListPanel.tsx#L219)）：展开某组时触发 `loadThread(threadId)`，组内行替换为该会话全量 main+sub（含分页外的）。目录（有哪些会话）仍由 groupByThread 对已加载分页 logs 生成。加载中占位 + 失败回退到分页已有部分行。
- **groupByThread 收窄**（[`src/utils/group-by-thread.ts:67`](../../src/utils/group-by-thread.ts#L67)）：sub 已落 threadId，sub 时间邻近附属分支简化（sub 直接进 byThread），ungrouped 仅保留给无 threadId 且无邻近 main 的孤立请求。

### 数据迁移

**不回填历史 sub**（延续原设计 YAGNI）：历史 sub 的 body 无父引用字段，离线无法重算父 threadId（只能复刻运行期启发式，但那是 SessionTracker 内存状态）。只对新数据生效。

## Capabilities

### New Capabilities

- **`conversation-threading`**：sub 请求按时间邻近落 threadId（`findRecentThread`）+ 按 threadId 全量查询（`/api/logs?threadId=`）+ 会话视图组内全量加载（A1）。项目此前没有这个 capability 的 openspec spec（只有 docs/superpowers 设计文档），本次新建并记录"sub 打 threadId"这一 YAGNI 决策反转。

### Modified Capabilities

- **`ui-e2e-verification`**：threadId 语义从"仅 main 内容寻址"扩展为"main 内容寻址 + sub 继承父 main threadId"，会话视图组内全量加载改变了 SessionListView 的数据来源。需核对 [ui-e2e-verification spec:235-289](../specs/ui-e2e-verification/spec.md) 的 log-list-filter 契约是否仍成立（main 分组逻辑不变，应兼容）。

## Impact

- **受影响代码**：
  - 后端：`server/session-tracker.ts`（findRecentThread）、`server/interceptor.ts`（sub 落 threadId）、`server/services/db.ts`（ListFilter/applyFilter）、`server/types.ts`（LogsQuery）、`server/services/log-reader.ts`（readLogs filter）、`server/routes/logs.ts`（query 解析）。
  - 前端：`src/utils/api.ts`（getLogs threadId）、`src/hooks/useLogs.ts`（loadThread）、`src/components/dashboard/LogListPanel.tsx`（SessionListView 组内全量）、`src/utils/group-by-thread.ts`（sub 附属收窄）。
  - 测试：`tests/session-tracker.test.ts`（findRecentThread 单测）、`tests/group-by-thread.test.ts:32`（sub 不再无 threadId，重写）、`tests/conversation-e2e.test.ts:171,204`（sub fixture 重写）、新增按 threadId 查询 + 组内全量 e2e。
- **不改**：main 的 threadId 内容寻址算法（computeAnchorKey/findContinuation 不变）、转发链路、存储 schema（thread_id 列+索引早有）。
- **已知局限（A1）**：会话目录仍基于已加载分页 logs，老会话（所有 main 被挤出 500 软上限）在目录里看不到——用户可 loadMore 翻到。A2（目录也全量，新增 DISTINCT thread_id 聚合查询）作为后续迭代。
- **题外既存问题（不在本次范围）**：sub 的 threadId 是时间邻近非血缘，多 main 并行时可能附属到错误 main——但前端旧逻辑亦如此，本次不改这个语义。
