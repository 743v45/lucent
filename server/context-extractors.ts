/**
 * Context Extractors
 *
 * Provides extraction functions for different API formats to extract unified context data.
 */

import { API_PATH_REGEX } from './constants.js';
import type { ApiProviderType } from './types.js';
import createDebug from 'debug';
const log = createDebug('lucent:context');

// ==================== 类型定义 ====================

// ApiProviderType 已移至 types.ts

export interface ContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface NormalizedMessage {
  role: string;
  content: string | ContentBlock[];
}

export interface NormalizedTool {
  name: string;
  description?: string;
}

export interface ExtractedContext {
  systemPrompt?: string;
  messages: NormalizedMessage[];
  tools: NormalizedTool[];
}

// ==================== API 类型检测 ====================

/**
 * 根据 URL 检测 API 类型
 * 顺序很重要：responses 要在 messages 之前检查（如果 URL 同时包含）
 */
export function detectApiType(url: string): ApiProviderType | null {
  if (!url || typeof url !== 'string') {
    return null;
  }

  // OpenAI Responses API 要在 Anthropic Messages 之前检查
  if (API_PATH_REGEX.OPENAI_RESPONSES.test(url)) { log('检测 API 类型: openai-responses, url=%s', url); return 'openai-responses'; }
  if (API_PATH_REGEX.ANTHROPIC_MESSAGES.test(url)) { log('检测 API 类型: anthropic-messages, url=%s', url); return 'anthropic-messages'; }
  if (API_PATH_REGEX.OPENAI_CHAT.test(url)) { log('检测 API 类型: openai-chat, url=%s', url); return 'openai-chat'; }

  return null;
}

// ==================== Anthropic Messages API ====================

/**
 * 从 Anthropic Messages API 请求体中提取 context
 * URL: /v1/messages
 * Body: { system?: string | ContentBlock[], messages: Message[], tools?: Tool[] }
 */
export function extractAnthropicMessages(body: any): ExtractedContext | null {
  if (!body || typeof body !== 'object') {
    return null;
  }

  // 提取 system prompt
  let systemPrompt: string | undefined;
  if (typeof body.system === 'string') {
    systemPrompt = body.system;
  } else if (Array.isArray(body.system)) {
    systemPrompt = body.system
      .filter((b: any) => b.type === 'text' && typeof b.text === 'string')
      .map((b: any) => b.text)
      .join('\n') || undefined;
  }

  // 提取 messages
  const messages: NormalizedMessage[] = Array.isArray(body.messages)
    ? body.messages.map((msg: any) => ({
        role: msg.role || 'user',
        content: msg.content,
      }))
    : [];

  // 提取 tools
  const tools: NormalizedTool[] = Array.isArray(body.tools)
    ? body.tools.map((tool: any) => ({
        name: tool.name,
        description: tool.description,
      }))
    : [];

  return { systemPrompt, messages, tools };
}

// ==================== OpenAI Chat Completions API ====================

/**
 * 从 OpenAI Chat Completions API 请求体中提取 context
 * URL: /v1/chat/completions
 * Body: { messages: Message[], tools?: Tool[] }
 * 注意：system prompt 在 messages 数组中 (role === 'system')
 */
export function extractOpenAIChat(body: any): ExtractedContext | null {
  if (!body || typeof body !== 'object') {
    return null;
  }

  const rawMessages = Array.isArray(body.messages) ? body.messages : [];
  let systemPrompt: string | undefined;

  // 分离 system message 和普通 messages
  const messages: NormalizedMessage[] = [];
  for (const msg of rawMessages) {
    if (msg.role === 'system') {
      if (!systemPrompt) {
        systemPrompt = typeof msg.content === 'string'
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n')
            : undefined;
      }
      continue; // system 不计入对话消息
    }
    messages.push({
      role: msg.role || 'user',
      content: msg.content,
    });
  }

  // 提取 tools（OpenAI 格式：tools[].function）
  const tools: NormalizedTool[] = Array.isArray(body.tools)
    ? body.tools.map((t: any) => {
        if (t.function) {
          return { name: t.function.name, description: t.function.description };
        }
        return { name: t.name, description: t.description };
      })
    : [];

  return { systemPrompt, messages, tools };
}

// ==================== OpenAI Responses API ====================

/**
 * 从 OpenAI Responses API 请求体中提取 context
 * URL: /v1/responses
 * Body: { instructions?: string, input: string | Array<{role: string, content: any}>, tools?: Tool[] }
 */
export function extractOpenAIResponses(body: any): ExtractedContext | null {
  if (!body || typeof body !== 'object') {
    return null;
  }

  // 提取 system prompt (instructions 字段)
  const systemPrompt = typeof body.instructions === 'string'
    ? body.instructions
    : undefined;

  // 提取 messages (input 字段)
  let messages: NormalizedMessage[] = [];
  if (typeof body.input === 'string') {
    messages = [{ role: 'user', content: body.input }];
  } else if (Array.isArray(body.input)) {
    messages = body.input.map((item: any) => ({
      role: item.role || 'user',
      content: item.content,
    }));
  }

  // 提取 tools（Responses API 的 tools 直接有 name/description）
  const tools: NormalizedTool[] = Array.isArray(body.tools)
    ? body.tools.map((t: any) => ({
        name: t.name,
        description: t.description,
      }))
    : [];

  return { systemPrompt, messages, tools };
}

// ==================== 主提取函数 ====================

/**
 * 从 API 请求体中提取统一的 context 数据
 * 支持自动检测 API 类型，也提供 fallback 逻辑
 */
export function extractContext(body: any, url: string): ExtractedContext | null {
  if (!body || typeof body !== 'object') {
    return null;
  }

  // 优先使用 URL 检测
  const apiType = detectApiType(url);

  const extractors: Record<ApiProviderType, (body: any) => ExtractedContext | null> = {
    'anthropic-messages': extractAnthropicMessages,
    'openai-chat': extractOpenAIChat,
    'openai-responses': extractOpenAIResponses,
  };

  if (apiType && extractors[apiType]) {
    const result = extractors[apiType](body);
    if (result) {
      log('提取上下文: apiType=%s messages=%d tools=%d systemPromptLen=%d', apiType, result.messages.length, result.tools.length, result.systemPrompt?.length ?? 0);
    }
    return result;
  }

  // Fallback：尝试通过 body 字段判断
  log('URL 检测失败，尝试 body fallback: url=%s', url);
  // 如果 body.system 存在 → Anthropic
  if (body.system !== undefined) {
    return extractAnthropicMessages(body);
  }

  // 如果 body.messages 有 role=system → OpenAI Chat
  if (Array.isArray(body.messages) && body.messages.some((m: any) => m.role === 'system')) {
    return extractOpenAIChat(body);
  }

  // 如果 body.instructions 存在 → OpenAI Responses
  if (body.instructions !== undefined) {
    return extractOpenAIResponses(body);
  }

  // 无法识别，返回 null
  return null;
}
