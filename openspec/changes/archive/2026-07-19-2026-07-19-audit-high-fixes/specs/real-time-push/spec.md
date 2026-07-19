## ADDED Requirements

### Requirement: SSE 写操作 SHALL 容错，单连接故障 MUST NOT 终止进程

所有对 SSE 客户端 `res` 的写操作（`connected` 握手、`heartbeat` 心跳、`broadcastLog` 的 `event: log`）MUST 在 try/catch 内执行；每个已注册客户端的 `res` MUST 注册 `error` 事件监听。任一写抛错或 `res` emit `error` 时 MUST 执行统一清理（`clearInterval(heartbeat)` + 从广播集合移除 + `res.destroy()`），且 MUST NOT 让异常冒泡为进程级 `uncaughtException`。

**Rationale:** 心跳 `setInterval` 回调里的裸 `res.write` 写到半开 / 已损坏 socket 会抛 `ERR_STREAM_WRITE_AFTER_END`，无 `error` 监听即 `uncaughtException`；而进程级 `uncaughtException` 处理是 `process.exit(1)`——单个坏 SSE 连接会拖垮整个代理服务。统一容错点（`writeSse` 单点 + `res.on('error')`）消除这一可靠性单点。

#### Scenario: 心跳写到半开连接不崩溃进程
- **GIVEN** 一个已连接的 SSE 客户端，其底层 socket 已半开但 req 的 close 事件尚未触发
- **WHEN** 心跳 interval 触发 `res.write(': heartbeat')`
- **THEN** 该写抛错时 MUST 被 try/catch 捕获
- **AND** 该客户端 MUST 被 clearInterval + 移出广播集合 + destroy
- **AND** 进程 MUST NOT 触发 uncaughtException、MUST NOT 退出

#### Scenario: res emit error 触发同一清理
- **GIVEN** 一个已注册的 SSE 客户端
- **WHEN** 其 res emit `error` 事件
- **THEN** MUST 执行与心跳失败相同的统一清理
- **AND** 其他客户端的推送 MUST NOT 受影响

### Requirement: SSE 广播 SHALL 处理背压，停滞客户端 MUST 被剔除

`broadcastLog` 对每个客户端的 `res.write(payload)` MUST 处理背压：当某客户端的写返回 `false`（内部缓冲超 highWaterMark）且持续未排空时，MUST 视其为停滞并将其从广播集合移除并 `destroy`（牺牲单个慢客户端换整体稳定性），MUST NOT 无限向其缓冲堆积数据。`registerSseClient` MUST 强制客户端数量上限，超限时拒绝新连接（HTTP 503）。

**Rationale:** SSE 扇出中，背压只让 `res.write` 返回 `false`、不抛异常；若广播方忽略返回值会无限堆积内存，单个停滞客户端即可造成慢泄漏（位于每条日志的热路径）。无连接上限则可被循环 `new EventSource` 低门槛 DoS。

#### Scenario: 停滞客户端被剔除而非无限缓冲
- **GIVEN** 广播集合内一个客户端停止读取（res.write 持续返回 false）
- **WHEN** broadcastLog 连续推送多条日志
- **THEN** 该停滞客户端 MUST 被移出广播集合并 destroy
- **AND** 其内部缓冲 MUST NOT 无界增长
- **AND** 其他正常客户端 MUST 继续收到推送

#### Scenario: 超过连接上限拒绝新连接
- **GIVEN** 已注册客户端数达到上限
- **WHEN** 新客户端 GET /api/logs/stream
- **THEN** 服务端 MUST 返回 503（不注册、不进入 SSE 握手）
