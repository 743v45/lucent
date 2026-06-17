# 上游协议 Schema 完整参考

> **目的**: 这份文档是 Lucent（透明代理）的**事实参考**——记录三个上游协议的**精确 schema**（请求 / 响应 / 流式事件 / 错误），让所有 verify 脚本、产品代码、UI 渲染都有权威依据。
>
> **不**是变更提案（变更走 `openspec/changes/`），而是**只读知识库**。

## 来源

| 协议 | 来源 | 抓取方式 |
|---|---|---|
| **Anthropic Messages** | `https://platform.claude.com/docs/en/api/messages/{create,streaming,errors}` | WebFetch（官方文档） |
| **OpenAI Chat Completions** | `openai@6.26.0` npm SDK `src/resources/chat/completions/completions.ts` + `src/resources/shared.ts` | 本地 SDK d.ts 读取（SPA 文档 WebFetch 拿不到） |
| **OpenAI Responses** | `openai@6.26.0` npm SDK `src/resources/responses/responses.ts` | 本地 SDK d.ts 读取 |
| **Anthropic Errors** | `@anthropic-ai/sdk/core/error.d.ts` + `resources/shared.d.ts` | 本地 SDK d.ts 读取 |

抓取时间: 2026-06-18
SDK 版本: `openai@6.26.0`, `@anthropic-ai/sdk@0.x`（最新）
WebFetch 时间: 2026-06-18

## 索引

- [01-anthropic-messages.md](./01-anthropic-messages.md) — Anthropic Messages API（请求 / 响应 / 流式 / 错误）
- [02-openai-chat-completions.md](./02-openai-chat-completions.md) — OpenAI Chat Completions API
- [03-openai-responses.md](./03-openai-responses.md) — OpenAI Responses API

## 三协议关键差异速查

| 维度 | anthropic-messages | openai-chat | openai-responses |
|---|---|---|---|
| 端点 | `POST /v1/messages` | `POST /v1/chat/completions` | `POST /v1/responses` |
| 对话历史字段 | `messages[]` | `messages[]` | **`input`**（非 messages）|
| input 形态 | array | array | **string OR array** |
| 流式事件格式 | `event: xxxx\ndata: ...` | `data: ...\n\n` | `event: response.xxxx\ndata: ...` |
| 流式结束标记 | `message_stop` 事件 | `data: [DONE]` | `response.completed` 事件 |
| 鉴权 header | `x-api-key` | `authorization: Bearer` | `authorization: Bearer` |
| 工具调用命名 | `tool_use` / `tool_result` | `tool_calls` / `tool` 消息 | `function_call` / `function_call_output` |
| 停止原因字段 | `stop_reason` | `finish_reason` | `status` (enum) |
| 错误字段 | `error: {type, message}` | `error: {message, type, code, param}` | `error: {code, message}`（code 是精确枚举）|
| 协议特有概念 | `system` (string or blocks), `thinking` | `tools`, `response_format`, `logprobs` | `instructions`, `reasoning`, `tools[]` (built-in + custom) |

## 维护规则

1. **新协议/新字段**: 用 WebFetch + SDK d.ts 验证后更新本目录
2. **不要写简化版**: 任何省略的字段都应该在 PR description 里说明"省略原因"
3. **协议变更**: SDK 升级时跑 `npm outdated` 检查 changelog，对应字段更新文档
4. **与 verify 脚本的关系**: `scripts/verify-*.mjs` 的 mock fixture 必须与本文档一致

## 何时更新

- OpenAI/Anthropic 协议**重大版本**变化（OpenAI o1/o3 系列引入的新参数、Anthropic Claude 4+ 引入的 extended thinking 调整等）
- Lucent 新增协议支持时（必须先补完整 schema 文档）
- verify 脚本中 mock fixture 与实际协议不符时
