## Why

`add-anthropic-chain-verification` change 建立了协议链路验收能力,但只覆盖
anthropic-messages。openai-chat / openai-responses 两个协议的"请求 → 响应 →
日志 → API → UI 渲染"链路仍无验收保护。

这两个协议与 anthropic 的关键差异未被任何测试覆盖:
- openai-chat: 响应体结构不同(choices[0].message.content),SSE 用裸 data
  + [DONE](无 event: 前缀)
- openai-responses: **请求 body 用 input 不是 messages**,响应用 output/
  output_text 结构,SSE 事件是 response.output_text.delta/response.completed

## What Changes

- 新增 scripts/verify-openai-chat-e2e.mjs(npm run verify:openai-chat)
- 新增 scripts/verify-openai-responses-e2e.mjs(npm run verify:openai-responses)
- 各覆盖 5 环节 × 2 模式 = 10 断言组
- `protocol-chain-verification` spec 加 2 条 Requirement(MODIFIED → 实际
  ADDED,因为之前 spec 只约束 anthropic,现扩展到 3 协议)

## Capabilities

### Modified Capabilities
- `protocol-chain-verification`: 扩展覆盖到 openai-chat / openai-responses

## Impact

- 受影响代码: 无
- 受影响脚本: + 2 个新 verify 脚本
- 受影响 npm scripts: + verify:openai-chat / verify:openai-responses
- 不影响 runtime 行为、API、依赖
