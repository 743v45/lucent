## ADDED Requirements

### Requirement: SSE 响应 SHALL 不被 compression 中间件缓冲

全局 `compression()` 中间件 MUST 通过 `filter` 跳过 `text/event-stream` 响应（SSE 路由），或 SSE 路由的每次写之后 MUST 触发 flush（`res.flush()`）。SSE 的 `event: log` / `: heartbeat` / `event: connected` MUST 即时下发，MUST NOT 被 zlib 内部缓冲积累到一定量才发送。

**Rationale:** `compression()` 默认对 `compressible('text/event-stream') === true` 的响应做流式 zlib 压缩，默认不在每次 write 后 flush，导致 SSE 数据堆积在 zlib 内部 buffer，实时推送被破坏（前端表现为日志延迟成批到达、心跳长时间收不到）。

#### Scenario: SSE 推送不被 compression 缓冲
- **GIVEN** 全局挂载了 compression 中间件，一个客户端连上 /api/logs/stream
- **WHEN** 后端 broadcastLog 推送一条 `event: log`，或心跳 `: heartbeat`
- **THEN** 该数据 MUST 即时到达客户端（不被 zlib 缓冲延迟成批下发）
- **AND** 心跳 MUST 按正常周期到达
