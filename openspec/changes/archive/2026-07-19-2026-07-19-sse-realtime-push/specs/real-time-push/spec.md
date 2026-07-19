# real-time-push Specification Delta

## ADDED Requirements

### Requirement: 日志落库后经 SSE 实时广播

`LogWriter.writeLogEntry`（server/services/log-writer.ts）在日志实际落库（写入队列任务执行 `insertLog` 成功）后，MUST 经 `sse-bus` 的 `broadcastLog` 向所有已连接 SSE 客户端推送 `event: log`，载荷为该条日志经 `normalizeLogEntry`（readLogs 同源转换）转换后的 LogEntry JSON。`logMode=off`（只过路）、无响应条目（response=null）、写入队列背压丢弃的条目 MUST NOT 落库亦 MUST NOT 广播。

**Rationale:** 接通此前残缺的实时推送链（/api/logs/stream 曾是骨架，sseClients 已移除）。广播点选在 writeLogEntry 的写入队列任务内（insertLog 后），因为它是所有日志落库的统一咽喉（interceptor 全部调用点都走它）。用 normalizeLogEntry 保证与 GET /api/logs 同格式，前端 formatLog 直接复用，无需第二套转换。

#### Scenario: 落库的日志广播给已连接客户端
- **GIVEN** 一个客户端已连上 /api/logs/stream（已 registerSseClient）
- **WHEN** 一条日志经 writeLogEntry 落库（logMode≠off、有响应、队列未背压）
- **THEN** 该客户端 MUST 收到一条 `event: log`，data 为该日志的 LogEntry JSON（含 id/timestamp/request/response 等同源字段）

#### Scenario: 被跳过的条目不广播
- **GIVEN** logMode=off，或某条目 response=null，或写入队列已达背压上限
- **WHEN** writeLogEntry 处理该条目
- **THEN** 该条目 MUST NOT 落库、MUST NOT 广播

#### Scenario: 广播载荷与 GET /api/logs 单条同格式
- **GIVEN** 一条日志既落库又被广播
- **WHEN** 对比 SSE 推送的 JSON 与 GET /api/logs 返回的同 id 日志
- **THEN** 两者字段结构 MUST 一致（同为 normalizeLogEntry 输出），前端 formatLog 可统一处理

### Requirement: SSE 端点客户端注册与生命周期

`GET /api/logs/stream` MUST 作为 SSE 端点：响应 `Content-Type: text/event-stream` + `Cache-Control: no-cache` + `Connection: keep-alive`，先发 `event: connected` 握手事件，并按 `heartbeatIntervalMs` 发心跳保活。连接建立时 MUST 调 `registerSseClient(res)` 加入广播集合；客户端断开（req close）时 MUST 调 `unregisterSseClient(res)` 移除并清理心跳。`broadcastLog` 向集合内客户端写 `event: log` 时，若某客户端 write 抛错 MUST 自动从集合剔除（避免残留死连接）。

**Rationale:** sse-bus 作为共享模块（被 /stream 路由与 LogWriter 共享），把客户端集合 + 广播逻辑集中。死连接剔除保证广播方不被已断开客户端拖累。

#### Scenario: 连接建立注册到广播集合
- **GIVEN** 客户端 GET /api/logs/stream
- **WHEN** 服务端接受连接、发完 connected 事件
- **THEN** 该 res MUST 已 registerSseClient 加入集合
- **AND** 后续 broadcastLog 会触达它

#### Scenario: 客户端断开从集合移除
- **GIVEN** 客户端已连接（在广播集合内）
- **WHEN** 客户端断开（req close）
- **THEN** 该 res MUST 被 unregisterSseClient 移出集合 + 心跳清理
- **AND** 后续 broadcastLog 不再触达它

#### Scenario: 广播写入失败剔除死连接
- **GIVEN** 广播集合内一个客户端的 res.write 抛错（连接已断）
- **WHEN** broadcastLog 遍历集合推送
- **THEN** 该客户端 MUST 被自动剔除
- **AND** 不影响其他客户端的推送、不抛错中断广播

### Requirement: 前端 EventSource 实时入库与过滤一致性

前端 MUST 在挂载时建立 `EventSource('/api/logs/stream')` 长连接，收到 `event: log` 后经 `formatLog` 转换并 `addLog`（prepend + ID 去重 + 软上限裁剪）入列表。为保持与列表筛选口径一致，SSE 推送的日志 MUST 经当前 `providerName`/`endpointType` 筛选检查：不合当前 provider/endpoint 的日志 MUST 丢弃（不 addLog）；当 `search` 非空（FTS 检索态）时 MUST NOT 自动加推送日志（避免污染检索结果，靠刷新重搜）。筛选值经 ref 同步读取，filter 变化 MUST NOT 重建 EventSource 连接。

**Rationale:** SSE 让新日志自动进列表，但列表可能正处在 provider/endpoint/search 筛选态——直接 addLog 会把不合筛选的日志塞进列表，与 GET /api/logs 的服务端筛选口径冲突。前端按当前 filter 客户端筛（provider/endpoint 精确比；search 态整体跳过）是最低成本的一致性方案；filter 经 ref 读以避免连接随 filter 变化反复重建。

#### Scenario: 合筛选的推送日志自动进列表
- **GIVEN** 列表未设筛选（providerName='all', endpointType='all', search 空），EventSource 已连接
- **WHEN** 后端广播一条新日志
- **THEN** 该日志 MUST 经 formatLog → addLog 出现在列表顶部（最新在上）

#### Scenario: 不合 provider 筛选的推送日志被丢弃
- **GIVEN** 列表筛了 providerName='beta'，EventSource 已连接
- **WHEN** 后端广播一条 providerName='alpha' 的日志
- **THEN** 该日志 MUST NOT 进列表（被前端丢弃）

#### Scenario: 搜索态不自动加推送日志
- **GIVEN** 列表处于 search 非空（FTS 检索态）
- **WHEN** 后端广播新日志
- **THEN** 该日志 MUST NOT 自动进列表（靠用户刷新重新检索）

#### Scenario: filter 变化不重建 EventSource
- **GIVEN** EventSource 已连接
- **WHEN** 用户切换 provider/endpoint 筛选
- **THEN** EventSource 连接 MUST 保持（不 close 重建），推送日志按新 filter 经 ref 实时筛
