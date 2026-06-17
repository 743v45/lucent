# OpenAI Responses API 完整 Schema

> 来源: `openai@6.26.0` SDK `src/resources/responses/responses.ts` + `input-items.ts` + `ws.ts`
> 抓取时间: 2026-06-18
> **注**: platform.openai.com 文档是 SPA，WebFetch 拿不到。从 SDK d.ts 抓取（机器可读权威）
> **官方**: Responses API 是 2025 年推出的新协议，逐步替代 Chat Completions

## 端点

```
POST /v1/responses
```

**Headers**:
- `content-type: application/json`
- `authorization: Bearer <API_KEY>`

---

## 1. 请求 Schema

### 必填字段 (1 个)

| 字段 | 类型 | 说明 |
|---|---|---|
| `model` | `Shared.ResponsesModel` | `gpt-4o`, `gpt-5.1`, `o3`, `o4-mini` 等 |
| `input` | `string \| Array<ResponseInputItem>` | **关键**: 不是 `messages`！|

### 可选字段（按类别分组）

#### 输出控制
| 字段 | 类型 | 说明 |
|---|---|---|
| `instructions` | `string \| Array<ResponseInputItem>` | 系统提示 |
| `max_output_tokens` | integer | 包含 reasoning tokens |
| `temperature` | number [0, 2] | |
| `top_p` | number [0, 1] | |
| `text` | `ResponseTextConfig { format, verbosity }` | 文本输出配置 |
| `truncation` | `'auto' \| 'disabled' \| null` | auto=超长自动截断 |
| `parallel_tool_calls` | boolean | 并行工具调用 |

#### 推理模型（gpt-5.1 / o 系列）
| 字段 | 类型 | 说明 |
|---|---|---|
| `reasoning` | `Shared.Reasoning { effort, summary }` | effort: `none \| minimal \| low \| medium \| high \| xhigh` |

#### 工具
| 字段 | 类型 | 说明 |
|---|---|---|
| `tools` | `Array<Tool>` | built-in (web_search, file_search, code_interpreter, image_generation, mcp, local_shell, computer_use) + custom (function) + apply_patch |
| `tool_choice` | `ToolChoiceOptions \| ToolChoiceAllowed \| ToolChoiceTypes \| ToolChoiceFunction \| ToolChoiceMcp \| ToolChoiceCustom \| ToolChoiceApplyPatch \| ToolChoiceShell` | |

#### 流式
| 字段 | 类型 | 说明 |
|---|---|---|
| `stream` | boolean | SSE 流式 |

#### 缓存/路由
| 字段 | 类型 | 说明 |
|---|---|---|
| `prompt_cache_key` | string | 缓存 key |
| `prompt_cache_retention` | `'in-memory' \| '24h' \| null` | 缓存保留 |
| `safety_identifier` | string | 滥用检测 |
| `service_tier` | `'auto' \| 'default' \| 'flex' \| 'scale' \| 'priority'` | |
| `store` | boolean | 是否存储（用于 evals/distillation）|
| `background` | boolean | 后台执行 |
| `metadata` | `Shared.Metadata` | ≤16 对 key-value |
| `include` | `Array<Include>` | 额外返回字段（reasoning.encrypted_content 等）|
| `prompt` | `ResponsePrompt` | prompt 模板引用 |

#### 会话
| 字段 | 类型 | 说明 |
|---|---|---|
| `previous_response_id` | string | 多轮对话前序 response ID |
| `conversation` | `Response.Conversation` | 对话 ID |

#### User（已废弃）
| 字段 | 类型 | 说明 |
|---|---|---|
| `user` ⚠️ | string | 已废弃, 用 `prompt_cache_key` |

### ⚠️ 关键: `input` 字段 schema

**可以是 `string`（用户文本）或 `Array<ResponseInputItem>`（27 种 union）**。

**简化用例**:
```json
// 字符串 input (最简)
{"model": "gpt-4o", "input": "What is latin for Ant?"}

// 数组 input (多轮/复杂)
{"model": "gpt-4o", "input": [
  {"type": "message", "role": "user", "content": "Hi"},
  {"type": "message", "role": "assistant", "content": "Hello!"},
  {"type": "message", "role": "user", "content": "Tell me a joke"}
]}
```

### `ResponseInputItem` 完整联合（27 种）

| type 名称 | 关键字段 | 来源 |
|---|---|---|
| `message` (EasyInputMessage) | `role: user/developer/system`, `content: string \| Array<ResponseInputContent>`, `type: "message"` | 输入消息（最简） |
| `message` (ResponseInputItem.Message) | `role: assistant`, `content: ResponseInputMessageContentList`, `status` | 历史 assistant 消息（多轮） |
| `ResponseOutputMessage` | (id, type, role, status, content) | 引用历史 output |
| `ResponseFileSearchToolCall` | (queries, results) | file_search 工具调用 |
| `ResponseComputerToolCall` | (action, pending_safety_checks) | computer_use 工具 |
| `ResponseInputItem.ComputerCallOutput` | (call_id, output: SafetyCheck) | computer_use 输出 |
| `ResponseFunctionWebSearch` | (action, sources) | web_search 函数 |
| `ResponseFunctionToolCall` | (arguments, call_id, name) | function 工具调用 |
| `ResponseInputItem.FunctionCallOutput` | (call_id, output: string \| Array<item>) | function 工具输出 |
| `ResponseInputItem.ToolSearchCall` | (name, input) | 工具搜索 |
| `ResponseToolSearchOutputItemParam` | (tools, status) | 工具搜索结果 |
| `ResponseReasoningItem` | (summary, content, encrypted_content) | **推理过程** |
| `ResponseCompactionItemParam` | (encrypted_content) | 压缩推理 |
| `ResponseInputItem.ImageGenerationCall` | (id, result, status) | 图片生成 |
| `ResponseCodeInterpreterToolCall` | (code, container_id) | 代码解释器 |
| `ResponseInputItem.LocalShellCall` | (action) | 本地 shell |
| `ResponseInputItem.LocalShellCallOutput` | (output) | local_shell 输出 |
| `ResponseInputItem.ShellCall` | (action) | shell call |
| `ResponseInputItem.ShellCallOutput` | (output) | shell 输出 |
| `ResponseInputItem.ApplyPatchCall` | (call_id, input) | apply_patch |
| `ResponseInputItem.ApplyPatchCallOutput` | (output) | apply_patch 输出 |
| `ResponseInputItem.McpListTools` | (server_label, tools) | MCP 列工具 |
| `ResponseInputItem.McpApprovalRequest` | (id, name, args, server_label) | MCP 审批 |
| `ResponseInputItem.McpApprovalResponse` | (approval_request_id, approve) | MCP 审批响应 |
| `ResponseInputItem.McpCall` | (server_label, name, arguments) | MCP 调用 |
| `ResponseCustomToolCallOutput` | (call_id, output) | custom 工具输出 |
| `ResponseCustomToolCall` | (call_id, name, input) | custom 工具调用 |
| `ResponseInputItem.ItemReference` | (id) | **引用历史 output item** |

### `ResponseInputContent` 联合（content 数组的 item）

3 种:
- `ResponseInputText { type: "input_text", text }`
- `ResponseInputImage { type: "input_image", detail, file_id/file_data/file_url }`
- `ResponseInputFile { type: "input_file", detail, file_data/file_id/file_url/filename }`

---

## 2. 响应 Schema（非流式）

### `Response` 完整字段

```typescript
{
  id: string,                                        // resp_xxx
  object: 'response',                                 // 固定
  created_at: number,                                 // Unix seconds
  status: 'completed' | 'failed' | 'in_progress' | 'cancelled' | 'queued' | 'incomplete',
  background?: boolean | null,
  completed_at?: number | null,                       // status=completed 时存在
  error: ResponseError | null,
  incomplete_details: { reason: 'max_output_tokens' | 'content_filter' } | null,
  instructions: string | Array<ResponseInputItem> | null,
  max_output_tokens?: number | null,
  model: Shared.ResponsesModel,
  output: Array<ResponseOutputItem>,                  // 关键: 模型生成的 items
  output_text: string,                                // helper: 合并所有 output_text
  parallel_tool_calls: boolean,
  previous_response_id?: string | null,
  prompt?: ResponsePrompt | null,
  prompt_cache_key?: string,
  prompt_cache_retention?: 'in-memory' | '24h' | null,
  reasoning?: Shared.Reasoning | null,
  safety_identifier?: string,
  service_tier?: 'auto' | 'default' | 'flex' | 'scale' | 'priority' | null,
  store?: boolean | null,
  temperature: number | null,
  text?: ResponseTextConfig,
  tool_choice: ToolChoiceXxx,
  tools: Array<Tool>,
  top_p: number | null,
  truncation?: 'auto' | 'disabled' | null,
  usage?: ResponseUsage,
  user?: string,                                      // @deprecated
  metadata: Shared.Metadata | null,
  conversation?: Response.Conversation | null,
}
```

### `ResponseStatus` 枚举（注意英式 cancelled）

`completed | failed | in_progress | cancelled | queued | incomplete`

### `ResponseUsage` schema

```typescript
{
  input_tokens: number,
  input_tokens_details: { cached_tokens: number },
  output_tokens: number,
  output_tokens_details: { reasoning_tokens: number },
  total_tokens: number,
}
```

### `ResponseError` schema

```typescript
{
  code:
    | 'server_error'
    | 'rate_limit_exceeded'
    | 'invalid_prompt'
    | 'vector_store_timeout'
    | 'invalid_image'
    | 'invalid_image_format'
    | 'invalid_base64_image'
    | 'invalid_image_url'
    | 'image_too_large'
    | 'image_too_small'
    | 'image_parse_error'
    | 'image_content_policy_violation'
    | 'invalid_image_mode'
    | 'image_file_too_large'
    | 'unsupported_image_media_type'
    | 'empty_image_file'
    | 'failed_to_download_image'
    | 'image_file_not_found',
  message: string,
}
```

### `ResponseOutputItem` 联合（20 种）

`ResponseOutputMessage | ResponseFileSearchToolCall | ResponseFunctionToolCall | ResponseFunctionWebSearch | ResponseComputerToolCall | ResponseReasoningItem | ResponseToolSearchCall | ResponseToolSearchOutputItem | ResponseCompactionItem | ResponseOutputItem.ImageGenerationCall | ResponseCodeInterpreterToolCall | ResponseOutputItem.LocalShellCall | ResponseFunctionShellToolCall | ResponseFunctionShellToolCallOutput | ResponseApplyPatchToolCall | ResponseApplyPatchToolCallOutput | ResponseOutputItem.McpCall | ResponseOutputItem.McpListTools | ResponseOutputItem.McpApprovalRequest | ResponseCustomToolCall`

### `ResponseOutputMessage` schema

```typescript
{
  id: string,
  type: 'message',
  role: 'assistant',
  status: 'in_progress' | 'completed' | 'incomplete',
  content: Array<
    | { type: 'output_text', text, annotations: Array<Annotation> }
    | { type: 'refusal', refusal: string }
  >,
}
```

---

## 3. SSE 流式事件 (50 种)

`ResponseStreamEvent = ResponseAudioDeltaEvent | ResponseAudioDoneEvent | ...` (50 个)

### 完整事件类型分类

#### Response 生命周期
- `response.created`
- `response.in_progress`
- `response.completed`
- `response.failed`
- `response.incomplete`
- `response.queued`
- `response.error`

#### Output Item 增删
- `response.output_item.added`
- `response.output_item.done`

#### Content Part 增删
- `response.content_part.added`
- `response.content_part.done`

#### 文本增量（最常用）
- `response.output_text.delta` (type 是 `response.output_text.delta`)
- `response.output_text.done`
- `response.text.delta`
- `response.text.done`

#### Refusal（拒绝）
- `response.refusal.delta`
- `response.refusal.done`

#### Function Call
- `response.function_call_arguments.delta`
- `response.function_call_arguments.done`

#### Reasoning（推理过程）
- `response.reasoning.delta`
- `response.reasoning.done`
- `response.reasoning_summary_part.added`
- `response.reasoning_summary_part.done`
- `response.reasoning_summary_text.delta`
- `response.reasoning_summary_text.done`

#### Audio
- `response.audio.delta`
- `response.audio.done`
- `response.audio_transcript.delta`
- `response.audio_transcript.done`

#### MCP
- `response.mcp_call_arguments.delta`
- `response.mcp_call_arguments.done`
- `response.mcp_call.in_progress`
- `response.mcp_call.completed`
- `response.mcp_call.failed`
- `response.mcp_list_tools.in_progress`
- `response.mcp_list_tools.completed`
- `response.mcp_list_tools.failed`

#### Web Search
- `response.web_search_call.in_progress`
- `response.web_search_call.searching`
- `response.web_search_call.completed`

#### File Search
- `response.file_search_call.in_progress`
- `response.file_search_call.searching`
- `response.file_search_call.completed`

#### Code Interpreter
- `response.code_interpreter_call.in_progress`
- `response.code_interpreter_call.code_delta`
- `response.code_interpreter_call.code_done`
- `response.code_interpreter_call.completed`
- `response.code_interpreter_call.interpreting`

#### Image Generation
- `response.image_generation_call.in_progress`
- `response.image_generation_call.generating`
- `response.image_generation_call.completed`
- `response.image_generation_call.partial_image`

#### Custom Tool
- `response.custom_tool_call_input.delta`
- `response.custom_tool_call_input.done`

#### Annotation
- `response.output_text.annotation.added`

### `ResponseTextDeltaEvent` schema (示例, 大部分事件类似结构)

```typescript
{
  content_index: number,
  delta: string,
  item_id: string,
  output_index: number,
  sequence_number: number,
  type: 'response.output_text.delta',
  logprobs?: Array<Logprob>,
}
```

### `ResponseErrorEvent` schema (流式错误事件)

```typescript
{
  code: string | null,             // 任意字符串（与非流式精确枚举不同）
  message: string,
  param: string | null,
  sequence_number: number,
  type: 'error',
}
```

---

## 4. 错误响应

### 非流式错误: `ResponseError` (见上 schema)

`code` 是**精确枚举**（20 种值），`message` 字符串。

### 流式错误: `ResponseErrorEvent` (见上)

`code` 是**任意字符串**（与非流式不同），`message` + `param` 必有，`sequence_number` 必有。

---

## 5. 关键概念

### Reasoning
Responses API 引入的新概念：`reasoning: { effort, summary }` 让模型在生成回复前先"思考"（类似 Anthropic 的 `thinking`）。
- `effort`: `none | minimal | low | medium | high | xhigh`
- `summary`: 让模型生成推理摘要（extra 字段 `include: ['reasoning.encrypted_content']` 才能拿到底层内容）

### Item Reference
引用历史 output items（多轮对话用）: `{"type": "item_reference", "id": "msg_xxx"}`

### Include
控制额外返回字段:
- `'reasoning.encrypted_content'`
- `'message.output_text.logprobs'`
- `'web_search_call.results'`
- 等等

### background + cancelled
新概念：`background: true` 异步执行，客户端不等待；可用 `cancel` 取消在 in_progress 状态的 response。
