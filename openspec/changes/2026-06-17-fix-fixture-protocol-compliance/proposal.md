## Why

`tests/e2e-helpers.ts` 的 mock fixture 在多轮迭代后,部分函数与
`docs/protocols/` 三份协议文档（以及 SDK d.ts 权威源）产生了 7 处不一致。
同文件内不同 SSE 函数(如 `sse-text` vs `sse-tool-use` vs `sse-thinking`)
的字段完整度也出现分歧。

这 7 处不一致不会立即触发单测失败（单测只断言关键存在性）,但会让
"fixture 作为协议契约样本"的价值打折——下游若用严格 SDK parser 解析
mock 响应,或用 regex 校验 `request_id` 格式,会触发误报。

## What Changes

`tests/e2e-helpers.ts` 7 处修复（纯 fixture 数据,不改产品代码、不改代理逻辑、
不改现有断言）:

1. **anthropic `sse-tool-use` `message_start.usage`**: 简版 2 字段 → 补齐为
   doc § 2 的 9 字段完整 `Usage` 结构,与 `sse-text` 一致
2. **anthropic `sse-thinking` `message_start.usage`**: 同上,补齐 9 字段
3. **anthropic `sse-thinking` thinking 块**: 加 `content_block_delta` 的
   `signature_delta` 事件 + `content_block_start.content_block.signature` 字段
   （doc § 3 明确 thinking 块最后一帧必须有 signature_delta）
4. **anthropic `anthropicErrorBody` `request_id`**: `'req_' + 16 字符` →
   `'req_0' + 23 字符 base62`（doc § 4 格式 `req_01xxxxxxxxxxxx`）
5. **openai `chat-tool-calls` SSE 末尾 chunk**: 补 `service_tier: 'default'`
   字段,与 `chat-sse` 末尾 chunk 一致
6. **openai Responses SSE `response.created` payload**: response 子对象
   从 4 字段 → 补齐为 doc § 2 完整 Response（32 字段,`status='in_progress'`,
   `output=[]`,`completed_at=null`）
7. **openai Responses SSE `response.completed` payload**: response 子对象
   从 5 字段 → 补齐为完整 Response（`status='completed'`,`completed_at` 有值,
   `output_text` 自动合并）

附带: 新增内部 helper `openaiResponsesResponseObject(id, status, output, completedAt)`
消除 created/completed 两个 Response 子对象的字段重复,语义化构造 in_progress
vs completed 两种状态。

## Capabilities

### New Capabilities
无。

### Modified Capabilities
- `protocol-chain-verification`: 加一条"fixture 字段完整度"契约
  （mock fixture 的 response/error 字段必须与 docs/protocols/ 文档逐字段
  对齐,不允许同文件内函数间字段分歧）

## Impact

- 受影响代码: `tests/e2e-helpers.ts` 一个文件,纯 mock 数据层
- 不影响产品代码（server/、src/）
- 不影响代理服务运行时行为
- 不影响现有断言逻辑（单测 320/320 全绿,3 个 verify 脚本 34/34 全绿）
- 新增真实链路验收脚本 `scripts/_verify-helpers-fix.mjs`（一次性,7 处修复
  的端到端 HTTP 验收,19/19 通过）
- 消费 helpers.ts 的 6 个 test 文件零回归
