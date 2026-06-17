## Why

Delta 存储机制（`server/delta-storage.ts`）是一段**写了但零消费方**的死代码，
且其设计假设从根上不成立,导致了用户报告的 bug:
"连续两次发相同 messages,日志里 body.messages 被清空为 []"。

### 根因（全量排查证据）
1. **跨协议串话**: `delta-storage.ts` 用模块级全局变量 `lastMessagesCount` /
   `lastTailFp` 跟踪"上一请求",但 anthropic-messages / openai-chat /
   openai-responses 三种协议共用这一份状态。openai-responses 协议无
   `messages` 字段(用 `input`),却与 anthropic 共享同一 delta 状态。
2. **跨 provider / 跨会话串话**: 所有 provider(hxy/zhipu/...)、所有独立
   会话共用同一份全局状态。HTTP 无状态,但 delta 假设有状态延续。
3. **零消费方**: `_deltaFormat` / `_isCheckpoint` / `_totalMessageCount` /
   `_conversationId` / `_inPlaceReplaceDetected` 这 5 个字段除了
   `delta-storage.ts` 自己写入外,**没有任何代码读取**(server/ src/
   scripts/ 全量 grep 验证)。UI 不重建、KV cache 不用、无任何下游。
4. **唯一可观测效果**: 让日志里的 `body.messages` 变空或截短——即用户
   报告的 bug。

### Delta 机制本意（为何曾经存在）
为节省磁盘,在 Claude Code 长会话场景下,连续请求只存"新增的 messages"
(delta)。但这要求"按会话隔离状态 + UI 重建"两个前提,二者都未实现。
实际效果是数据被错误截短且无法恢复。

## What Changes

- **删除** `server/delta-storage.ts` 整个文件
- **删除** `server/interceptor.ts` 里所有 delta 调用:
  `processDeltaForMainAgent` 函数、3 个 handler 的 `deltaState` 参数、
  `commitDeltaState` 调用
- **删除** `server/types.ts` 的 5 个 delta 字段定义
- **删除** `server/constants.ts` 的 `DELTA_CHECKPOINT_INTERVAL` 死常量
- **清理** `server/session-tracker.ts` 注释里对 delta-storage 的引用
- **新增 spec capability** `log-integrity`: 每次请求的 body 必须原样落盘
- **新增测试** `tests/provider-e2e.test.ts`: 连续相同请求的 body.messages
  必须完整(TDD 红→绿已验证)

## Capabilities

### New Capabilities
- `log-integrity`: 日志完整性契约——请求 body 必须原样落盘,不允许任何
  截短/清空/delta 编码

### Modified Capabilities
无。

## Impact

- 受影响代码: `server/interceptor.ts`(移除 delta 调用)、
  `server/delta-storage.ts`(删除)、`server/types.ts`(清字段)、
  `server/constants.ts`(清死常量)、`server/session-tracker.ts`(清注释)
- 受影响测试: `tests/provider-e2e.test.ts` 新增 1 个用例
- 不影响 runtime 路由/URL 拼接/协议处理(verify:e2e 12/12 仍绿)
- 磁盘成本上升: 每次请求存完整 body 而非 delta(对单用户本地场景可忽略)
- 不影响 API、依赖
- 历史 `.jsonl` 日志文件中的 `_deltaFormat` 等字段仍存在(已写入磁盘),
  但无代码读取,等同于无影响
