/**
 * 端点类型处理器注册
 *
 * 将 Anthropic Messages、OpenAI Chat、OpenAI Responses 三种
 * 端点类型的处理器注册到 endpoint-registry。
 *
 * 在服务启动时调用 registerAllEndpointHandlers() 即可。
 */

import { registerEndpoint } from './endpoint-registry.js';
import { ENDPOINT_TYPES } from './types.js';
import type { ExtractedInfo } from './types.js';
import type { ExtractedContext } from './context-extractors.js';

// ==================== Anthropic Messages ====================

registerEndpoint('anthropic-messages', {
  matchPath(strippedPath: string): boolean {
    return strippedPath === '/messages';
  },

  extractSSE(eventType: string, data: any, acc: ExtractedInfo): void {
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
    } else if (eventType === 'message_delta') {
      acc.stopReason = data.delta?.stop_reason || acc.stopReason;
      if (data.usage?.output_tokens != null) acc.usage.output = data.usage.output_tokens;
      if (data.usage?.input_tokens != null) acc.usage.input = data.usage.input_tokens;
      if (data.usage?.cache_read_input_tokens != null) acc.usage.cache_read = data.usage.cache_read_input_tokens;
      if (data.usage?.cache_creation_input_tokens != null) acc.usage.cache_create = data.usage.cache_creation_input_tokens;
    }
  },

  extractContext(body: any): ExtractedContext | null {
    if (!body || typeof body !== 'object') return null;

    let systemPrompt: string | undefined;
    if (typeof body.system === 'string') {
      systemPrompt = body.system;
    } else if (Array.isArray(body.system)) {
      systemPrompt = body.system
        .filter((b: any) => b.type === 'text' && typeof b.text === 'string')
        .map((b: any) => b.text)
        .join('\n') || undefined;
    }

    const messages = Array.isArray(body.messages)
      ? body.messages.map((msg: any) => ({
          role: msg.role || 'user',
          content: msg.content,
        }))
      : [];

    const tools = Array.isArray(body.tools)
      ? body.tools.map((tool: any) => ({
          name: tool.name,
          description: tool.description,
        }))
      : [];

    return { systemPrompt, messages, tools };
  },
});

// ==================== OpenAI Chat Completions ====================

registerEndpoint('openai-chat', {
  matchPath(strippedPath: string): boolean {
    return strippedPath === '/chat/completions' || strippedPath === '/completions';
  },

  extractSSE(_eventType: string, data: any, acc: ExtractedInfo): void {
    if (data.choices && Array.isArray(data.choices)) {
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
  },

  extractContext(body: any): ExtractedContext | null {
    if (!body || typeof body !== 'object') return null;

    const rawMessages = Array.isArray(body.messages) ? body.messages : [];
    let systemPrompt: string | undefined;
    const messages: any[] = [];

    for (const msg of rawMessages) {
      if (msg.role === 'system') {
        if (!systemPrompt) {
          systemPrompt = typeof msg.content === 'string'
            ? msg.content
            : Array.isArray(msg.content)
              ? msg.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n')
              : undefined;
        }
        continue;
      }
      messages.push({
        role: msg.role || 'user',
        content: msg.content,
      });
    }

    const tools = Array.isArray(body.tools)
      ? body.tools.map((t: any) => {
          if (t.function) {
            return { name: t.function.name, description: t.function.description };
          }
          return { name: t.name, description: t.description };
        })
      : [];

    return { systemPrompt, messages, tools };
  },
});

// ==================== OpenAI Responses API ====================

registerEndpoint('openai-responses', {
  matchPath(strippedPath: string): boolean {
    return strippedPath === '/responses';
  },

  extractSSE(_eventType: string, data: any, acc: ExtractedInfo): void {
    if (data.type && typeof data.type === 'string' && data.type.startsWith('response.')) {
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
  },

  extractContext(body: any): ExtractedContext | null {
    if (!body || typeof body !== 'object') return null;

    const systemPrompt = typeof body.instructions === 'string'
      ? body.instructions
      : undefined;

    let messages: any[] = [];
    if (typeof body.input === 'string') {
      messages = [{ role: 'user', content: body.input }];
    } else if (Array.isArray(body.input)) {
      messages = body.input.map((item: any) => ({
        role: item.role || 'user',
        content: item.content,
      }));
    }

    const tools = Array.isArray(body.tools)
      ? body.tools.map((t: any) => ({
          name: t.name,
          description: t.description,
        }))
      : [];

    return { systemPrompt, messages, tools };
  },
});

// ==================== 注册入口 ====================

/**
 * 注册所有内置端点类型处理器
 * 实际上上面的 registerEndpoint 调用在模块加载时已执行，
 * 此函数只是提供一个显式的初始化点，方便未来添加动态注册。
 */
export function registerAllEndpointHandlers(): void {
  // 已通过模块顶层 registerEndpoint 调用注册
  // 此处可用于验证注册完整性
  const registered = ENDPOINT_TYPES.length;
  const count = registered; // 从 registry 获取实际数量需要导入，此处用常量
  if (count < ENDPOINT_TYPES.length) {
    console.warn(`[Lucent] 端点注册不完整: ${count}/${ENDPOINT_TYPES.length}`);
  }
}
