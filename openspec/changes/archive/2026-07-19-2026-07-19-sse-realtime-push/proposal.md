# SSE 实时推送接通（日志落库后自动进列表）

## Why

`/api/logs/stream` 此前是 SSE 骨架：`sseClients` 集合已移除（无广播方、无前端 EventSource 消费者），仅保留端点（connected 事件 + 心跳）维持对外契约。后果：新日志落库后**前端列表不会自动更新**，只能靠手动点顶栏 refresh-btn 或定时自动刷新（轮询）重新拉首页——实时性差，活跃会话场景体验割裂。

前端 [`useLogs.addLog`](../../../src/hooks/useLogs.ts) 当初就是为 SSE 推送设计的（带 ID 去重 + 软上限裁剪），但一直无调用方。本次接通这条链。

## What Changes

### 后端

- **新建 sse-bus**（[`server/sse-bus.ts`](../../../server/sse-bus.ts)）：模块级 `clients: Set<Response>` + `registerSseClient`/`unregisterSseClient`/`broadcastLog`。被 `/api/logs/stream` 路由（注册/注销）与 `LogWriter`（广播）共享。写入失败的客户端自动剔除。
- **LogWriter 落库后广播**（[`server/services/log-writer.ts`](../../../server/services/log-writer.ts)）：`writeLogEntry` 的写入队列任务在 `insertLog` 成功后，`broadcastLog(normalizeLogEntry(entry))` 向所有已连接客户端推 `event: log`。`normalizeLogEntry` 是 readLogs 同源转换，前端 `formatLog` 直接复用。`logMode=off`/无响应/背压丢弃的条目不落库亦不广播。
- **`/api/logs/stream` 注册客户端**（[`server/routes/logs.ts`](../../../server/routes/logs.ts)）：保留 SSE headers + connected 事件 + 心跳；连接建立时 `registerSseClient(res)`，断开时 `unregisterSseClient(res)`。删掉"未接通"TODO。

### 前端

- **EventSource 实时入库**（[`src/hooks/useLogs.ts`](../../../src/hooks/useLogs.ts)）：mount 时建 `EventSource('/api/logs/stream')`，`event: log` → `formatLog` → `addLog`（prepend + ID 去重 + 软上限）。`formatLog` 提模块级（纯函数，供 loadLogs/loadThread/SSE 共享）；`addLog` 改 `useCallback` 稳定引用供 SSE `useEffect` 依赖。
- **过滤一致性**：`filterRef` 同步当前 `providerName/endpointType/search`；SSE 推送的日志若不合当前 provider/endpoint 筛选 MUST 丢弃；搜索态（search 非空）不自动加（避免污染 FTS 检索结果，靠刷新重搜）。filter 变化经 ref 读取，不重建 EventSource 连接。

### dev 工具链

- **vite dev proxy SSE 修复**（[`vite.config.ts`](../../../vite.config.ts)）：vite 的 http-proxy 默认对压缩响应缓冲，导致 `/api/logs/stream` 的事件被攒在 proxy 缓冲区、前端 EventSource 一直 CONNECTING。proxy 加 `configure: proxyReq.setHeader('accept-encoding', 'identity')` + `compression: false`。**仅影响 dev**，生产 build 同源直达 backend 不经 vite proxy。

### 测试

- **新增 sse-bus 单测**（[`tests/sse-bus.test.ts`](../../../tests/sse-bus.test.ts)）：广播 / 无客户端 no-op / 失败剔除 / unregister。
- **e2e 契约翻转**（[`e2e/global-interactions.spec.ts`](../../../e2e/global-interactions.spec.ts)）：原"实时推送未接通"（断言第二条不自动出现）→ "SSE 已接通"（断言第二条自动出现）；原"refresh-btn 刷新才进列表"→ "refresh-btn 全量对齐兜底"（SSE 接通后新请求自动进，刷新转为全量重拉首页对齐）。

## Capabilities

### New Capabilities

- **`real-time-push`**：日志落库后经 SSE 实时广播到已连接前端、自动进列表（带 provider/endpoint/search 过滤一致性）。项目此前无此 capability 的 openspec spec。

### Modified Capabilities

- **`ui-e2e-verification`**：global-interactions 的"实时推送" + "刷新按钮"两条契约语义翻转（未接通→接通、刷新才进→全量对齐兜底）。相关 spec 断言已同步更新。

## Impact

- **受影响代码**：
  - 后端：`server/sse-bus.ts`（新）、`server/services/log-writer.ts`（insertLog 后广播）、`server/routes/logs.ts`（/stream register/unregister）。
  - 前端：`src/hooks/useLogs.ts`（EventSource + formatLog 模块级 + addLog useCallback + filterRef）。
  - 工具链：`vite.config.ts`（proxy accept-encoding identity + compression false）。
  - 测试：`tests/sse-bus.test.ts`（新）、`e2e/global-interactions.spec.ts`（两条契约翻转）、`e2e/log-list-filter.spec.ts`（注释同步）。
- **不改**：日志写入路径（interceptor → writeLogEntry 不变，只在 insertLog 后加广播）、存储 schema、`/api/logs` 查询语义、auto-refresh（与 SSE 互补：增量推送 + 全量对齐兜底）。
- **已知局限**：
  - SSE 是增量推送，不重传丢失事件——刷新 / auto-refresh 作为全量对齐兜底。
  - SSE 推送的日志不合当前 filter 的被前端丢弃（客户端筛）；切 filter 后建议刷新重拉首页对齐。
  - dev 环境需 vite proxy 的 `accept-encoding: identity` 才能流式（生产同源无此问题）。
