## Why

本会话用户要求按真实协议完整化所有 mock fixture:
- 之前 verify 脚本的 mock 是凭"训练数据知识"简化, 缺字段(如 anthropic cache_creation, openai responses SSE 8 事件链只发 3 个)
- 错误体 type 字段写死错(401 错误之前返 invalid_request_error 而不是 authentication_error)
- 后果: 协议行为偏差时 fixture 看不出来, UI 展示验证漏

按 docs/protocols/ 文档(从 openai@6.26.0 SDK d.ts + Anthropic 官方文档抓)逐字段对照, 全部补齐.

## What Changes

- tests/e2e-helpers.ts: 增强 5 协议 fixture (anthropic/openai-chat/openai-responses/chat-json/responses-json) 按 docs 补完整字段
- 新增 openaiErrorByStatus(status, code, message) 函数, 按 HTTP status 自动映射正确 error.type (修复 401/429/500 错误体 type bug)
- scripts/verify-anthropic-e2e.mjs: SSE 事件 6→8 (加 ping+error), 扩 usage 详细
- scripts/verify-openai-chat-e2e.mjs: 扩 usage 详细
- scripts/verify-openai-responses-e2e.mjs: SSE 事件 3→9 完整链, 修 fetch 提前 resolve bug, 加防御
- 协议链验收能力 (protocol-chain-verification) 加 Requirement

## Capabilities

### Modified Capabilities
- `protocol-chain-verification`: 加 "mock fixture 必须与 docs/protocols/ 文档字段一致" Requirement

## Impact

- 受影响测试: vitest 320/320 + 6 verify 脚本 568 验收点全绿
- 受影响文档: docs/protocols/ (3 协议 schema 完整)
- 不影响 runtime 行为、API
