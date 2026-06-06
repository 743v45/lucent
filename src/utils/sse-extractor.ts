/**
 * SSE 提取函数（前端）
 *
 * 从原始 SSE 行数据中提取结构化信息
 * 支持 Anthropic、OpenAI Chat、OpenAI Responses 三种格式
 */

import type { SSERawLine, ExtractedInfo, ContentBlock } from '../types';

// ==================== SSE 事件提取 ====================

/**
 * 从单个 SSE 事件中提取关键信息
 */
function extractFromEvent(eventType: string, data: any, acc: ExtractedInfo): void {
  // Anthropic 格式
  if (eventType === 'message_start') {
    acc.model = data.message?.model || acc.model;
    acc.usage.input = data.message?.usage?.input_tokens || acc.usage.input;
    acc.usage.cache_create = data.message?.usage?.cache_creation_input_tokens || acc.usage.cache_create;
    acc.usage.cache_read = data.message?.usage?.cache_read_input_tokens || acc.usage.cache_read;
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
  } else if (eventType === 'message_delta') {
    acc.stopReason = data.delta?.stop_reason || acc.stopReason;
    acc.usage.output = data.usage?.output_tokens || acc.usage.output;
  }

  // OpenAI Chat 格式（无 event，直接看 data.choices）
  else if (data.choices && Array.isArray(data.choices)) {
    const delta = data.choices[0]?.delta;
    if (delta?.content) {
      acc.text += delta.content;
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

  // OpenAI Responses API 格式
  else if (data.type && typeof data.type === 'string' && data.type.startsWith('response.')) {
    if (data.type === 'response.output_text.delta') {
      acc.text += data.delta || '';
    }
    if (data.type === 'response.function_call_arguments.delta') {
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

// ==================== SSE 提取函数 ====================

/**
 * 从 SSE 原始行数据中提取结构化信息
 */
export function extractFromSSELines(lines: SSERawLine[]): ExtractedInfo {
  const acc: ExtractedInfo = {
    text: '',
    thinking: '',
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
 * 将提取的信息转换为 ResponseBody 格式（用于展示）
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
      ...(extracted.text ? [{ type: 'text', text: extracted.text }] : []),
      ...(extracted.thinking ? [{ type: 'thinking', thinking: extracted.thinking }] : []),
      ...extracted.toolCalls.map(tc => ({ type: 'tool_use', ...tc })),
    ],
    stop_reason: extracted.stopReason,
    usage: extracted.usage,
  };
}