# OpenAI Chat Completions API 完整 Schema

> 来源: `openai@6.26.0` SDK `src/resources/chat/completions/completions.ts` + `src/resources/shared.ts`
> 抓取时间: 2026-06-18
> **注**: platform.openai.com 文档是 SPA，WebFetch 拿不到。从 SDK d.ts 抓取（机器可读权威）

## 端点

```
POST /v1/chat/completions
```

**Headers**:
- `content-type: application/json`
- `authorization: Bearer <API_KEY>`

---

## 1. 请求 Schema

### 必填字段 (2 个)

| 字段 | 类型 | 说明 |
|---|---|---|
| `model` | `(string & {}) \| Shared.ChatModel` | `gpt-4o`, `o3`, `o4-mini` 等 |
| `messages` | `Array<ChatCompletionMessageParam>` | 对话历史 |

### 可选字段（完整列表，按类型分组）

#### 采样控制
| 字段 | 类型 | 说明 |
|---|---|---|
| `temperature` | number [0, 2] | 越高越随机 |
| `top_p` | number [0, 1] | nucleus sampling |
| `frequency_penalty` | number [-2, 2] | 重复惩罚 |
| `presence_penalty` | number [-2, 2] | 新话题倾向 |
| `n` | integer (默认 1) | 生成几个候选 |
| `seed` | integer | 确定性采样（Beta） |
| `logit_bias` | `{ [token: string]: number }` | token 偏置 |
| `logprobs` | boolean | 返回 logprobs |
| `top_logprobs` | integer [0, 20] | top-N logprobs（需 logprobs=true） |
| `stop` | string \| Array<string> | 最多 4 个停止序列 |

#### 输出控制
| 字段 | 类型 | 说明 |
|---|---|---|
| `max_completion_tokens` | integer | 包含 reasoning tokens（o1/o3/o4 系列使用） |
| `max_tokens` ⚠️ | integer | **已废弃**, 与 `max_completion_tokens` 互斥 |
| `response_format` | `ResponseFormatText \| ResponseFormatJSONSchema \| ResponseFormatJSONObject` | 结构化输出 |
| `verbosity` | `'low' \| 'medium' \| 'high'` | 输出详细度 |
| `stream` | boolean | 是否 SSE |
| `stream_options` | `{ include_usage: boolean }` | 流式是否包含 usage |
| `modalities` | `Array<'text' \| 'audio'>` | 输出模态 |
| `audio` | `ChatCompletionAudioParam` | 音频输出配置 |
| `prediction` | `ChatCompletionPredictionContent` | 预测内容（推测解码） |

#### 工具调用
| 字段 | 类型 | 说明 |
|---|---|---|
| `tools` | `Array<ChatCompletionTool>` | function tools |
| `tool_choice` | `ChatCompletionToolChoiceOption` | auto/required/none/specific function |
| `parallel_tool_calls` | boolean | 是否并行工具调用 |
| `function_call` ⚠️ | `'none' \| 'auto' \| ChatCompletionFunctionCallOption` | **已废弃**, 用 `tool_choice` |
| `functions` ⚠️ | `Array<Function>` | **已废弃**, 用 `tools` |

#### 推理模型（o1/o3/o4/o5 系列）
| 字段 | 类型 | 说明 |
|---|---|---|
| `reasoning_effort` | `Shared.ReasoningEffort` | `'none' \| 'minimal' \| 'low' \| 'medium' \| 'high' \| 'xhigh'` |

#### 缓存/路由
| 字段 | 类型 | 说明 |
|---|---|---|
| `prompt_cache_key` | string | 缓存路由 key（替代 `user`） |
| `prompt_cache_retention` | `'in-memory' \| '24h' \| null` | 缓存保留策略 |
| `safety_identifier` | string | 滥用检测 |
| `user` ⚠️ | string | **已废弃**, 用 `prompt_cache_key` |
| `service_tier` | `'auto' \| 'default' \| 'flex' \| 'scale' \| 'priority'` | 处理层级 |
| `web_search_options` | `{ search_context_size, user_location }` | web search tool |
| `metadata` | `Shared.Metadata` | ≤16 对 key-value (key≤64, value≤512 chars) |
| `store` | boolean | 是否存储（用于 distillation/evals） |

### `messages[]` 中每种 role 的 schema

| role | 必填 | 可选 |
|---|---|---|
| `system` | `content` | `name` |
| `user` | `content` | `name` |
| `developer` | `content` | `name` |
| `assistant` | `content` 可空 | `name`, `refusal`, `audio`, `tool_calls[]` |
| `tool` | `content`, `tool_call_id` | — |
| `function` ⚠️ | `content`, `name` | —（已废弃, 合并到 `tool`） |

### `content` 的 ContentPart 类型

`text | image_url | image | input_audio | file | refusal`

---

## 2. 响应 Schema（非流式）

### `ChatCompletion` 完整字段

```typescript
{
  id: string,
  object: 'chat.completion',
  created: number,                                    // Unix seconds
  model: string,
  choices: Array<Choice>,                              // length 由 n 决定
  service_tier?: 'auto' | 'default' | 'flex' | 'scale' | 'priority' | null,
  system_fingerprint?: string,
  usage?: CompletionUsage,
}
```

### `Choice` schema

```typescript
{
  finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'function_call',
  index: number,
  logprobs: { content: Array<TokenLogprob> | null, refusal: Array<TokenLogprob> | null } | null,
  message: ChatCompletionMessage,
}
```

### `Choice.message` schema

```typescript
{
  role: 'assistant',
  content: string | null,
  refusal: string | null,
  tool_calls?: Array<{
    id: string,
    type: 'function',
    function: { name: string, arguments: string }  // arguments 是 JSON 字符串
  }>,
  annotations?: Array<Annotation>,
  audio?: { id, data, expires_at, transcript },    // modalities=audio 时
}
```

### `CompletionUsage` schema

```typescript
{
  prompt_tokens: number,
  completion_tokens: number,
  total_tokens: number,
  prompt_tokens_details: {
    cached_tokens: number,
    audio_tokens: number,
  },
  completion_tokens_details: {
    reasoning_tokens: number,                       // o 系列推理 token
    audio_tokens: number,
  },
}
```

---

## 3. SSE 流式响应

### 事件格式

每帧 SSE:
```
data: {JSON object}\n\n
```

终止符:
```
data: [DONE]\n\n
```

### `ChatCompletionChunk` schema

```typescript
{
  id: string,                                        // 与非流式响应同 ID
  object: 'chat.completion.chunk',
  created: number,                                   // 与非流式响应同时间戳
  model: string,
  choices: Array<ChunkChoice>,
  service_tier?: ...,
  system_fingerprint?: string,
  usage?: CompletionUsage | null,                    // 仅 stream_options.include_usage=true 时出现
}
```

### `ChunkChoice` schema

```typescript
{
  delta: Delta,                                       // 关键: 每帧只有 delta 字段变化
  finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'function_call' | null,
  index: number,
  logprobs?: { content, refusal } | null,
}
```

### `Delta` schema

```typescript
{
  role?: 'developer' | 'system' | 'user' | 'assistant' | 'tool',  // 仅首帧
  content?: string | null,
  refusal?: string | null,
  tool_calls?: Array<{
    index: number,
    id?: string,
    type?: 'function',
    function?: { name?: string, arguments?: string },
  }>,
  // @deprecated
  function_call?: { arguments?: string, name?: string },
}
```

---

## 4. 错误响应

### 错误体 schema (`Shared.ErrorObject`)

```typescript
{
  code: string | null,           // 字符串枚举: context_length_exceeded, rate_limit_exceeded, insufficient_quota, model_not_found, invalid_api_key, organization_verification_required, ...
  message: string,
  param: string | null,          // 出错的字段名
  type: string,                  // 类型: invalid_request_error, authentication_error, permission_error, not_found_error, request_too_large, rate_limit_error, api_error, overloaded_error, insufficient_quota_error
}
```

### HTTP status 与 type 映射

| HTTP | type |
|---|---|
| 400 | `invalid_request_error` |
| 401 | `authentication_error` |
| 403 | `permission_error` |
| 404 | `not_found_error` |
| 413 | `request_too_large` |
| 429 | `rate_limit_error` |
| 500 | `api_error` |
| 529 | `overloaded_error` |

### 常见 `code` 字符串

- `context_length_exceeded`
- `rate_limit_exceeded`
- `insufficient_quota`
- `model_not_found`
- `invalid_api_key`
- `organization_verification_required`
