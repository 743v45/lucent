# Anthropic Messages API 完整 Schema

> 来源: `https://platform.claude.com/docs/en/api/messages/{create,streaming,errors}` + `@anthropic-ai/sdk` d.ts
> 抓取时间: 2026-06-18

## 端点

```
POST /v1/messages
```

**Headers**:
- `content-type: application/json`
- `x-api-key: <API_KEY>`
- `anthropic-version: 2023-06-01`

---

## 1. 请求 Schema

### 必填字段 (3 个)

| 字段 | 类型 | 说明 |
|---|---|---|
| `model` | string 或枚举 | `claude-opus-4-8`, `claude-sonnet-4-6`, `claude-haiku-4-5` 等 |
| `max_tokens` | number | "The maximum number of tokens to generate before stopping."（设为 `0` 可仅预热 prompt cache） |
| `messages` | `Array<MessageParam>` | 单请求上限 100,000 messages |

### 可选字段 (完整列表)

| 字段 | 类型 | 说明 |
|---|---|---|
| `system` | `string \| Array<TextBlockParam>` | 系统提示，可字符串或文本块数组 |
| `tools` | `Array<ToolUnion>` | 工具定义 |
| `tool_choice` | `ToolChoice` (auto/any/tool/none) | 工具选择策略 |
| `stream` | `boolean` | 是否 SSE 流式 |
| `thinking` | `ThinkingConfigParam` (enabled/disabled/adaptive) | 扩展思考配置 |
| `temperature` | number | 默认 1.0，范围 0.0-1.0 |
| `top_p` | number | nucleus sampling |
| `top_k` | number | top-K sampling |
| `stop_sequences` | `Array<string>` | 自定义停止序列 |
| `metadata` | `Metadata { user_id?: string }` | 请求元数据 |
| `service_tier` | `"auto" \| "standard_only"` | 服务层级 |
| `cache_control` | `CacheControlEphemeral` | 顶层缓存控制（自动应用到最后一个可缓存 block） |
| `container` | string | 容器标识符（跨请求复用） |
| `inference_geo` | string | 推理区域 |
| `output_config` | `OutputConfig { effort, format }` | 输出配置 |

### `messages[]` 中每个 `MessageParam` 的 schema

```typescript
{
  role: "user" | "assistant" | "system",  // 注意: input messages 无 "system" role
  content: string | Array<ContentBlockParam>
}
```

字符串与数组等价示例:
```json
{"role": "user", "content": "Hello, Claude"}
{"role": "user", "content": [{"type": "text", "text": "Hello, Claude"}]}
```

### `ContentBlockParam` 完整类型（输入）

15 种 block 类型（联合类型）:

| type | 关键字段 |
|---|---|
| `text` | `text`, `cache_control?`, `citations?` |
| `image` | `source: Base64ImageSource \| URLImageSource`, `cache_control?`，媒体类型 `image/jpeg \| image/png \| image/gif \| image/webp` |
| `document` | `source: Base64PDFSource \| PlainTextSource \| ContentBlockSource \| URLPDFSource`, `cache_control?`, `citations?`, `context?`, `title?` |
| `search_result` | `content: TextBlockParam[]`, `source`, `title`, `cache_control?`, `citations?` |
| `thinking` | `signature`, `thinking` |
| `redacted_thinking` | `data` |
| `tool_use` | `id`, `input`, `name`, `cache_control?`, `caller?` |
| `tool_result` | `tool_use_id`, `cache_control?`, `content?`, `is_error?` |
| `server_tool_use` | `id`, `input`, `name`（web_search / web_fetch / code_execution / bash_code_execution / text_editor_code_execution / tool_search_tool_regex / tool_search_tool_bm25）|
| `web_search_tool_result` | `content`, `tool_use_id`, `cache_control?`, `caller?` |
| `web_fetch_tool_result` | 同上 |
| `code_execution_tool_result` | 同上 |
| `bash_code_execution_tool_result` | 同上 |
| `text_editor_code_execution_tool_result` | 同上 |
| `tool_search_tool_result` | 同上 |
| `container_upload` | `file_id`, `cache_control?` |
| `mid_conv_system` | `content`, `cache_control?` |

`cache_control: CacheControlEphemeral { type: "ephemeral", ttl?: "5m" | "1h" }`，默认 `5m`

---

## 2. 响应 Schema（非流式）

### `Message` 完整字段

```typescript
{
  id: string,                              // msg_01...
  type: "message",                         // 固定
  role: "assistant",                       // 固定
  content: Array<ContentBlock>,
  model: Model,
  stop_reason: StopReason | null,          // 非流式总是非 null
  stop_sequence: string | null,
  container: Container | null,             // { id, expires_at } 用于 code execution
  stop_details: RefusalStopDetails | null, // { category, explanation, type:"refusal" }
  usage: Usage,
}
```

### `StopReason` 枚举

`end_turn | max_tokens | stop_sequence | tool_use | pause_turn | refusal`

### `Usage` 完整结构

> 权威源: `@anthropic-ai/sdk` `resources/messages/messages.d.ts:1395` `interface Usage`
> SDK 顶层 8 字段; 此处文档多列 `output_tokens_details`（thinking 扩展字段, SDK 某些版本 + 官方示例会出现）。fixture 实现按 9 字段完整对齐。

```typescript
{
  input_tokens: number,
  output_tokens: number,
  cache_creation_input_tokens: number,
  cache_read_input_tokens: number,
  cache_creation: {
    ephemeral_1h_input_tokens: number,
    ephemeral_5m_input_tokens: number,
  },
  inference_geo: string,
  output_tokens_details: { thinking_tokens: number },
  server_tool_use: {
    web_fetch_requests: number,
    web_search_requests: number,
  },
  service_tier: "standard" | "priority" | "batch",
}
```

注: Total input tokens = `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`

### `MessageDeltaUsage` 结构（`message_delta` 事件的累计 usage）

> 权威源: `messages.d.ts:659` `interface MessageDeltaUsage`
> ⚠️ 所有字段都是**累计值（cumulative）**, 与非流式 `Usage` 不同——`input_tokens`/`cache_*` 在 `MessageDeltaUsage` 里是 `number | null`（首帧后可能不再变化）, `output_tokens` 是 `number`（持续累加）。

```typescript
{
  input_tokens: number | null,
  output_tokens: number,
  cache_creation_input_tokens: number | null,
  cache_read_input_tokens: number | null,
  server_tool_use: ServerToolUsage | null,
}
```

### `ContentBlock`（响应）类型

`text | thinking | redacted_thinking | tool_use | server_tool_use | web_search_tool_result | web_fetch_tool_result | code_execution_tool_result | bash_code_execution_tool_result | text_editor_code_execution_tool_result | tool_search_tool_result | container_upload`

---

## 3. SSE 流式事件

> 原文: "future may add new event types, code should gracefully handle unknown types."

| 事件 | 说明 |
|---|---|
| `message_start` | 含带空 `content` 的 `Message` 对象 |
| `content_block_start` | 内容块开始 |
| `content_block_delta` | 内容块增量（可多个） |
| `content_block_stop` | 内容块结束 |
| `message_delta` | 顶层 Message 变更（可多个） |
| `message_stop` | 流结束 |
| `ping` | 任意时刻可出现 |
| `error` | 错误事件 |

### 各事件 data 字段

**`message_start`**:
```json
{
  "type": "message_start",
  "message": {
    "id": "msg_01...", "type": "message", "role": "assistant",
    "content": [], "model": "claude-opus-4-8",
    "stop_reason": null, "stop_sequence": null,
    "usage": { "input_tokens": 25, "output_tokens": 1 }
  }
}
```

**`content_block_start`** (文本/thinking/tool_use/server_tool_use/web_search_tool_result):
```json
{"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}
```

**`content_block_delta.delta` 的 union 类型**:

| delta.type | 字段 |
|---|---|
| `text_delta` | `text` |
| `input_json_delta` | `partial_json`（分片 JSON 字符串）|
| `thinking_delta` | `thinking` |
| `signature_delta` | `signature`（thinking 块最后一帧，验证完整性用）|

**`SignatureDelta` 精确结构**（权威源 `messages.d.ts`）:
```typescript
{ signature: string, type: 'signature_delta' }
```

**thinking 块的 `content_block_start.content_block` 必须带 `signature` 字段**（权威源 `messages.d.ts` `interface ThinkingBlock`）:
```typescript
{ type: 'thinking', thinking: string, signature: string }
```
即 thinking 块的 `content_block_start` 帧 content_block 也应含 `signature: ''`（占位）, thinking_delta 帧填充 thinking 内容, 最后 signature_delta 帧填充 signature。

**`content_block_stop`**:
```json
{"type": "content_block_stop", "index": 0}
```

**`message_delta`**:
```json
{
  "type": "message_delta",
  "delta": {"stop_reason": "end_turn", "stop_sequence": null},
  "usage": {"output_tokens": 15}
}
```
⚠️ `message_delta.usage` 是**累计值（cumulative）**。

**`message_stop`**:
```json
{"type": "message_stop"}
```

**`ping`**:
```json
{"type": "ping"}
```

**`error`**:
```json
{"type": "error", "error": {"type": "overloaded_error", "message": "Overloaded"}}
```

### 特殊说明

- `input_json_delta.partial_json` 是**分片 JSON 字符串**，最终 `tool_use.input` 才是 object；推荐用 Pydantic 之类的 partial JSON 解析。
- 当 `display: "omitted"` 时，**不发送** `thinking_delta` 事件，thinking 块只会收到一个 `signature_delta` 后直接关闭。

---

## 4. 错误响应

### HTTP 状态码与 `error.type` 映射

| HTTP 状态码 | `error.type` | 原文描述 |
|---|---|---|
| 400 | `invalid_request_error` | "There was an issue with the format or content of your request. This error type may also be used for other 4XX status codes not listed in this section." |
| 401 | `authentication_error` | "There's an issue with your API key. On Claude Platform on AWS, this can also indicate a problem with your AWS credentials or SigV4 signature." |
| 402 | `billing_error` | "There's an issue with your billing or payment information." |
| 403 | `permission_error` | "Your API key does not have permission to use the specified resource." |
| 404 | `not_found_error` | "The requested resource was not found." |
| 413 | `request_too_large` | "Request exceeds the maximum allowed number of bytes." |
| 429 | `rate_limit_error` | "Your account has hit a rate limit." |
| 500 | `api_error` | "An unexpected error has occurred internal to Anthropic's systems." |
| 504 | `timeout_error` | "The request timed out while processing." |
| 529 | `overloaded_error` | "The API is temporarily overloaded." |

**注**: ErrorType 枚举（9 种）:
`invalid_request_error | authentication_error | permission_error | not_found_error | rate_limit_error | timeout_error | overloaded_error | api_error | billing_error`

**`request_too_large` 不在 ErrorType 枚举里**——它是 HTTP 413 状态码的语义名称，错误体仍使用 `invalid_request_error` 之类。

### 错误响应体 JSON Schema

```json
{
  "type": "error",
  "error": {
    "type": "not_found_error",
    "message": "The requested resource could not be found."
  },
  "request_id": "req_011CSHoEeqs5C35K2UUqR7Fy"
}
```

**顶层字段**:
- `type`: 固定为 `"error"`
- `error.type`: 上述 9 种 ErrorType 之一
- `error.message`: 人类可读错误消息
- `request_id`: 形如 `req_` + 24 字符 base62 的 ID（官方示例 `req_011CSHoEeqs5C35K2UUqR7Fy` 总长 28 字符）

**Header 还携带 `request-id`** (同格式)，AWS 部署时还会包含 `x-amzn-requestid`。

### 特殊说明 (SSE 流式)

原文: "When receiving a streaming response over SSE, it's possible that an error can occur after returning a 200 response, in which case error handling wouldn't follow these standard mechanisms."

---

## 5. 完整 curl 示例

```bash
curl https://api.anthropic.com/v1/messages \
    -H 'Content-Type: application/json' \
    -H 'anthropic-version: 2023-06-01' \
    -H "X-Api-Key: $ANTHROPIC_API_KEY" \
    --max-time 600 \
    -d '{
          "max_tokens": 1024,
          "messages": [{"content": "Hello, world", "role": "user"}],
          "model": "claude-opus-4-6",
          "system": [{"text": "Today's date is 2024-06-01.", "type": "text"}],
          "temperature": 1,
          "thinking": {"type": "adaptive"},
          "tools": [{"input_schema": {...}, "name": "name"}],
          "top_k": 5,
          "top_p": 0.7
        }'
```
