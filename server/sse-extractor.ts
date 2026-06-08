/**
 * SSE 流提取器
 *
 * 从 Anthropic / OpenAI SSE 流中：
 * - 收集原始 SSE 行数据（存储）
 * - 导出提取函数（展示时调用）
 *
 * 从 interceptor.ts 提取而来
 */

import { EventSourceParserStream } from 'eventsource-parser/stream';
import type { ExtractedInfo, RawLogEntry, SSERawLine } from './types.js';
import createDebug from 'debug';
const dbgSse = createDebug('agentproxy:interceptor:sse');

// ==================== SSE 事件提取（内部函数） ====================

/**
 * 从单个 SSE 事件中提取关键信息
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

  // OpenAI Responses API 格式（包括慧星云兼容格式）
  else if (data.type && typeof data.type === 'string' && data.type.startsWith('response.')) {
    if (data.type === 'response.output_text.delta') {
      acc.text += data.delta || '';
    }
    // 慧星云兼容格式：response.reasoning_text.delta
    if (data.type === 'response.reasoning_text.delta') {
      acc.thinking += data.delta || '';
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

// ==================== SSE 提取函数（导出供前端调用） ====================

/**
 * 从 SSE 原始行数据中提取结构化信息
 * 此函数导出供前端在展示时调用
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

// ==================== 后台收集原始 SSE 行 ====================

/**
 * 后台收集 SSE 原始行数据（不阻塞客户端响应）
 * 存储原始数据，展示时再调用 extractFromSSELines 提取
 */
export async function collectSSELinesInBackground(
  body: ReadableStream<Uint8Array>,
  entry: RawLogEntry,
  onLogEntry: (entry: RawLogEntry) => void,
  onDeltaCommit: () => void,
): Promise<void> {
  const lines: SSERawLine[] = [];

  try {
    const eventStream = body
      .pipeThrough(new TextDecoderStream() as any)
      .pipeThrough(new EventSourceParserStream()) as ReadableStream<any>;

    const reader = eventStream.getReader();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      // 收集原始 SSE 行数据
      lines.push({
        event: value.event || '',
        data: value.data || '',
      });
    }

    // 写入日志：存储原始 SSE 数据
    entry.response = {
      status: entry.response?.status || 200,
      statusText: entry.response?.statusText || 'OK',
      headers: entry.response?.headers || {},
      body: {
        type: 'sse_raw',
        lines,
      },
    };

    // 从 SSE 行中提取 token 使用情况
    const extracted = extractFromSSELines(lines);
    if (extracted.usage.input > 0 || extracted.usage.output > 0) {
      entry.tokenUsage = {
        inputTokens: extracted.usage.input,
        outputTokens: extracted.usage.output,
        cacheReadTokens: extracted.usage.cache_read || undefined,
        cacheWriteTokens: extracted.usage.cache_create || undefined,
      };
    }

    onLogEntry(entry);
    onDeltaCommit();

    dbgSse('SSE 收集完成: lines=%d', lines.length);
  } catch (err) {
    dbgSse('SSE 收集失败: %O', err);
    entry.response = {
      status: entry.response?.status || 200,
      statusText: entry.response?.statusText || 'OK',
      headers: entry.response?.headers || {},
      body: { type: 'sse_raw', error: String(err) },
    };
    onLogEntry(entry);
    onDeltaCommit();
  }
}

// 兼容旧名称的别名
export const extractInBackground = collectSSELinesInBackground;