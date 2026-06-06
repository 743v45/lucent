/**
 * SSE 流提取器
 *
 * 从 Anthropic / OpenAI SSE 流中提取结构化数据（文本、思考、工具调用、Token 用量）
 * 从 interceptor.ts 提取而来
 */

import { EventSourceParserStream } from 'eventsource-parser/stream';
import type { ExtractedInfo, RawLogEntry } from './types.js';
import createDebug from 'debug';
const dbgSse = createDebug('agentproxy:interceptor:sse');

// ==================== SSE 事件提取 ====================

/**
 * 从 SSE 事件中提取关键信息
 * 支持 Anthropic、OpenAI Chat、OpenAI Responses 三种格式
 */
export function extractFromEvent(eventType: string, data: any, acc: ExtractedInfo): void {
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

// ==================== 后台提取 ====================

/**
 * 后台提取 SSE 流数据（不阻塞客户端响应）
 */
export async function extractInBackground(
  body: ReadableStream<Uint8Array>,
  entry: RawLogEntry,
  onLogEntry: (entry: RawLogEntry) => void,
  onDeltaCommit: () => void,
): Promise<void> {
  const extracted: ExtractedInfo = {
    text: '',
    thinking: '',
    toolCalls: [],
    usage: { input: 0, output: 0, cache_read: 0, cache_create: 0 },
    stopReason: '',
    model: '',
  };

  try {
    const eventStream = body
      .pipeThrough(new TextDecoderStream() as any)
      .pipeThrough(new EventSourceParserStream()) as ReadableStream<any>;

    const reader = eventStream.getReader();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      try {
        const data = JSON.parse(value.data);
        extractFromEvent(value.event || '', data, extracted);
      } catch {
        // JSON 解析失败，跳过
      }
    }

    // 解析工具调用参数（从字符串转为对象）
    for (const tc of extracted.toolCalls) {
      if (typeof tc.input === 'string' && tc.input) {
        try {
          tc.input = JSON.parse(tc.input);
        } catch {
          // 保持字符串
        }
      }
    }

    // 写入日志
    entry.response = {
      status: entry.response?.status || 200,
      statusText: entry.response?.statusText || 'OK',
      headers: entry.response?.headers || {},
      body: {
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
      },
    };

    onLogEntry(entry);
    onDeltaCommit();

    dbgSse('SSE 提取完成: textLen=%d thinkingLen=%d toolCalls=%d usage=%o stopReason=%s model=%s',
      extracted.text.length, extracted.thinking.length, extracted.toolCalls.length,
      extracted.usage, extracted.stopReason, extracted.model);
  } catch (err) {
    dbgSse('SSE 提取失败: %O', err);
    entry.response = {
      status: entry.response?.status || 200,
      statusText: entry.response?.statusText || 'OK',
      headers: entry.response?.headers || {},
      body: '[Streaming Response - Extract failed]',
    };
    onLogEntry(entry);
    onDeltaCommit();
  }
}
