/**
 * shared/sse-events.ts — SSE 事件提取单源逻辑
 *
 * 三协议（Anthropic / OpenAI Chat / OpenAI Responses）SSE 事件的统一提取。
 * 纯函数，无 node 依赖，server 和前端共用此模块。
 *
 * 覆盖的事件类型（per docs/protocols/）:
 *
 * Anthropic Messages:
 *   - message_start (model + input usage)
 *   - content_block_start (tool_use 块开始)
 *   - content_block_delta (text_delta / thinking_delta / input_json_delta / signature_delta)
 *   - message_delta (stop_reason + 累计 usage)
 *
 * OpenAI Chat Completions:
 *   - data.choices[].delta.content (文本)
 *   - data.choices[].delta.reasoning_content / reasoning (推理, o1/o3 + DeepSeek 等)
 *   - data.choices[].delta.refusal (拒绝内容)
 *   - data.choices[].delta.tool_calls (工具调用)
 *   - data.choices[].finish_reason
 *   - data.usage
 *
 * OpenAI Responses:
 *   - response.output_text.delta / response.text.delta (文本)
 *   - response.reasoning.delta (标准推理) + response.reasoning_text.delta (慧星云兼容)
 *   - response.reasoning_summary_text.delta (推理摘要)
 *   - response.refusal.delta (拒绝)
 *   - response.function_call_arguments.delta (函数工具调用)
 *   - response.mcp_call_arguments.delta (MCP 工具调用)
 *   - response.completed (usage)
 *
 * 生命周期/进度事件（response.created/in_progress/queued/audio.delta/code_interpreter 等）
 * 不在此提取——它们是状态流转，raw 视图原样展示，结构化视图忽略。
 */

/** SSE 原始行（event + data 两字段） */
export interface SSERawLine {
  event: string;
  data: string;
}

/** 从 SSE 流提取的结构化信息 */
export interface ExtractedInfo {
  text: string;
  thinking: string;
  /** 拒绝内容（模型拒绝回答时，如安全策略触发） */
  refusal: string;
  toolCalls: Array<{ id?: string; name: string; input: unknown }>;
  usage: { input: number; output: number; cache_read: number; cache_create: number };
  stopReason: string;
  model: string;
}

/** 展示用的 content block */
export interface ContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

/**
 * 从单个 SSE 事件中提取关键信息，累积到 acc
 */
export function extractFromEvent(eventType: string, data: any, acc: ExtractedInfo): void {
  // ==================== Anthropic Messages ====================
  if (eventType === 'message_start') {
    acc.model = data.message?.model || acc.model;
    if (data.message?.usage?.input_tokens != null) acc.usage.input = data.message.usage.input_tokens;
    if (data.message?.usage?.cache_creation_input_tokens != null) acc.usage.cache_create = data.message.usage.cache_creation_input_tokens;
    if (data.message?.usage?.cache_read_input_tokens != null) acc.usage.cache_read = data.message.usage.cache_read_input_tokens;
  } else if (eventType === 'content_block_start') {
    const block = data.content_block;
    if (block?.type === 'tool_use') {
      acc.toolCalls.push({ id: block.id, name: block.name, input: {} });
    }
  } else if (eventType === 'content_block_delta') {
    const delta = data.delta;
    const idx = data.index;
    if (delta?.type === 'text_delta') {
      acc.text += delta.text || '';
    } else if (delta?.type === 'thinking_delta') {
      acc.thinking += delta.thinking || '';
    } else if (delta?.type === 'input_json_delta' && idx !== undefined) {
      const toolCall = acc.toolCalls[idx];
      if (toolCall && typeof toolCall.input === 'string') {
        toolCall.input += delta.partial_json || '';
      } else if (toolCall) {
        toolCall.input = delta.partial_json || '';
      }
    }
    // signature_delta 不提取内容（只是验证签名）
  } else if (eventType === 'message_delta') {
    acc.stopReason = data.delta?.stop_reason || acc.stopReason;
    if (data.usage?.output_tokens != null) acc.usage.output = data.usage.output_tokens;
    if (data.usage?.input_tokens != null) acc.usage.input = data.usage.input_tokens;
    if (data.usage?.cache_read_input_tokens != null) acc.usage.cache_read = data.usage.cache_read_input_tokens;
    if (data.usage?.cache_creation_input_tokens != null) acc.usage.cache_create = data.usage.cache_creation_input_tokens;
  }

  // ==================== OpenAI Chat Completions（无 event 行，看 data.choices）====================
  else if (data.choices && Array.isArray(data.choices)) {
    const delta = data.choices[0]?.delta;
    if (delta?.content) {
      acc.text += delta.content;
    }
    // reasoning: OpenAI o1/o3 的 reasoning_content + DeepSeek 等 API 的 reasoning
    if (delta?.reasoning_content) {
      acc.thinking += delta.reasoning_content;
    } else if (delta?.reasoning) {
      acc.thinking += delta.reasoning;
    }
    // refusal: 模型拒绝内容
    if (delta?.refusal) {
      acc.refusal += delta.refusal;
    }
    if (delta?.tool_calls) {
      for (const tc of delta.tool_calls) {
        if (tc.index !== undefined) {
          if (!acc.toolCalls[tc.index]) {
            acc.toolCalls[tc.index] = { id: tc.id, name: '', input: '' };
          }
          if (tc.function?.name) acc.toolCalls[tc.index].name += tc.function.name;
          if (tc.function?.arguments) {
            acc.toolCalls[tc.index].input += tc.function.arguments;
          }
        }
      }
    }
    if (data.choices[0]?.finish_reason) {
      acc.stopReason = data.choices[0].finish_reason;
    }
    if (data.usage) {
      acc.usage.input = data.usage.prompt_tokens || acc.usage.input;
      acc.usage.output = data.usage.completion_tokens || acc.usage.output;
      acc.usage.cache_read = data.usage.prompt_tokens_details?.cached_tokens || acc.usage.cache_read;
    }
  }

  // ==================== OpenAI Responses API ====================
  else if (data.type && typeof data.type === 'string' && data.type.startsWith('response.')) {
    // 文本输出（output_text 是标准变体，text 是部分兼容场景）
    if (data.type === 'response.output_text.delta' || data.type === 'response.text.delta') {
      acc.text += data.delta || '';
    }
    // reasoning（标准 + 慧星云兼容两种格式）
    if (data.type === 'response.reasoning.delta' || data.type === 'response.reasoning_text.delta') {
      acc.thinking += data.delta || '';
    }
    // 推理摘要（reasoning_summary_text）
    if (data.type === 'response.reasoning_summary_text.delta') {
      acc.thinking += data.delta || '';
    }
    // refusal
    if (data.type === 'response.refusal.delta') {
      acc.refusal += data.delta || '';
    }
    // 函数工具调用
    if (data.type === 'response.function_call_arguments.delta') {
      const callId = data.call_id;
      const toolCall = acc.toolCalls.find(tc => tc.id === callId);
      if (toolCall && typeof toolCall.input === 'string') {
        toolCall.input += data.delta || '';
      }
    }
    // MCP 工具调用（与 function_call 类似，用 call_id 关联）
    if (data.type === 'response.mcp_call_arguments.delta') {
      const callId = data.call_id;
      const toolCall = acc.toolCalls.find(tc => tc.id === callId);
      if (toolCall && typeof toolCall.input === 'string') {
        toolCall.input += data.delta || '';
      }
    }
    if (data.type === 'response.completed' && data.response?.usage) {
      acc.usage.input = data.response.usage.input_tokens || acc.usage.input;
      acc.usage.output = data.response.usage.output_tokens || acc.usage.output;
    }
  }
}

/**
 * 从 SSE 原始行数据中提取结构化信息
 */
export function extractFromSSELines(lines: SSERawLine[]): ExtractedInfo {
  const acc: ExtractedInfo = {
    text: '',
    thinking: '',
    refusal: '',
    toolCalls: [],
    usage: { input: 0, output: 0, cache_read: 0, cache_create: 0 },
    stopReason: '',
    model: '',
  };

  for (const line of lines) {
    try {
      const data = JSON.parse(line.data);
      extractFromEvent(line.event || '', data, acc);
    } catch {
      // JSON 解析失败，跳过
    }
  }

  // 解析工具调用参数（从字符串转为对象）
  for (const tc of acc.toolCalls) {
    if (typeof tc.input === 'string' && tc.input) {
      try {
        tc.input = JSON.parse(tc.input);
      } catch {
        // 保持字符串
      }
    }
  }

  return acc;
}

/**
 * 将提取的信息转换为 ResponseBody 格式（用于 UI 结构化展示）
 */
export function extractedToResponseBody(extracted: ExtractedInfo): {
  type: 'message';
  role: 'assistant';
  model: string;
  content: ContentBlock[];
  stop_reason: string;
  usage: ExtractedInfo['usage'];
} {
  return {
    type: 'message',
    role: 'assistant',
    model: extracted.model,
    content: [
      ...(extracted.thinking ? [{ type: 'thinking', thinking: extracted.thinking }] : []),
      ...(extracted.text ? [{ type: 'text', text: extracted.text }] : []),
      ...(extracted.refusal ? [{ type: 'refusal', refusal: extracted.refusal }] : []),
      ...extracted.toolCalls.map(tc => ({ type: 'tool_use', ...tc })),
    ],
    stop_reason: extracted.stopReason,
    usage: extracted.usage,
  };
}
