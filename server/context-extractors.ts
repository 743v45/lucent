/**
 * Context Extractors
 *
 * Provides extraction functions for different API formats to extract unified context data.
 */

import type { EndpointType } from './types.js';
import { inferEndpointTypeFromPath, getStrippedPaths } from './endpoint-registry.js';
import { PROTOCOL_IDS } from '../shared/protocols.js';
import createDebug from 'debug';
const log = createDebug('lucent:context');

// ==================== 类型定义 ====================

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
 * 从 URL 路径检测 endpointType
 * - /v1/messages → anthropic-messages
 * - /v1/chat/completions 或 /v1/completions → openai-chat
 * - /v1/responses → openai-responses
 */
export function detectEndpointType(url: string): EndpointType | null {
  if (!url || typeof url !== 'string') return null;

  // /custom/{name}/{rest} 格式 → 剥出 strippedPath 后委托 registry 推断
  // (path 字面量单源取自 PROTOCOL_REGISTRY,protocol-model spec Req 3)
  const customMatch = /^\/custom\/[a-zA-Z0-9_-]+(\/.*)$/.exec(new URL(url, 'http://x').pathname);
  if (customMatch) {
    const strippedPath = stripLeadingV1(customMatch[1]);
    return inferEndpointTypeFromPath(strippedPath);
  }

  // 老路径 → 直接检测（兼容历史日志:旧日志无 endpointType 字段,需从 URL 反推）
  // 匹配常量从 registry 派生,不再手写字面量。
  for (const id of PROTOCOL_IDS) {
    for (const p of getStrippedPaths(id)) {
      if (url.includes(`/v1${p}`)) return id;
    }
  }

  return null;
}

/** 去掉单个前导 /v1 段(与 proxy.ts 的 strip 逻辑一致) */
function stripLeadingV1(rest: string): string {
  return rest.startsWith('/v1/') ? rest.slice(3) : rest;
}

// 兼容旧调用（detectApiType 已废弃，用 detectEndpointType）
export const detectApiType = detectEndpointType;

// ==================== Anthropic Messages API ====================

export function extractAnthropicMessages(body: any): ExtractedContext | null {
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

  const messages: NormalizedMessage[] = Array.isArray(body.messages)
    ? body.messages.map((msg: any) => ({
        role: msg.role || 'user',
        // Anthropic 允许 content 为 null/undefined；规范化为空数组避免下游 normalizeContent 收到 null。
        content: msg.content == null ? [] : msg.content,
      }))
    : [];

  const tools: NormalizedTool[] = Array.isArray(body.tools)
    ? body.tools.map((tool: any) => ({
        name: tool.name,
        description: tool.description,
      }))
    : [];

  return { systemPrompt, messages, tools };
}

// ==================== OpenAI Chat Completions API ====================

export function extractOpenAIChat(body: any): ExtractedContext | null {
  if (!body || typeof body !== 'object') return null;

  const rawMessages = Array.isArray(body.messages) ? body.messages : [];
  let systemPrompt: string | undefined;

  const messages: NormalizedMessage[] = [];
  for (const msg of rawMessages) {
    if (msg.role === 'system') {
      if (!systemPrompt) {
        systemPrompt = typeof msg.content === 'string'
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content.filter((b: any) => b.type === 'text' && typeof b.text === 'string').map((b: any) => b.text).join('\n')
            : undefined;
      }
      continue;
    }
    messages.push({
      role: msg.role || 'user',
      // OpenAI Chat 允许 assistant 发起 tool_calls 时 content === null/undefined，
      // 归一化为空数组，兑现 NormalizedMessage.content: string | ContentBlock[] 契约，
      // 避免透传到前端 ContextTab 的 .map() 崩溃（见 2026-06-18-fix-context-content-null）。
      content: msg.content == null ? [] : msg.content,
    });
  }

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

export function extractOpenAIResponses(body: any): ExtractedContext | null {
  if (!body || typeof body !== 'object') return null;

  const systemPrompt = typeof body.instructions === 'string'
    ? body.instructions
    : undefined;

  let messages: NormalizedMessage[] = [];
  if (typeof body.input === 'string') {
    messages = [{ role: 'user', content: body.input }];
  } else if (Array.isArray(body.input)) {
    messages = body.input.map((item: any) => ({
      role: item.role || 'user',
      // OpenAI Responses 允许 item.content 缺省/null，归一化为空数组，
      // 与 extractOpenAIChat / extractAnthropicMessages 一致（同上）。
      content: item.content == null ? [] : item.content,
    }));
  }

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
 */
export function extractContext(body: any, url: string): ExtractedContext | null {
  if (!body || typeof body !== 'object') return null;

  const endpointType = detectEndpointType(url);

  const extractors: Record<EndpointType, (body: any) => ExtractedContext | null> = {
    'anthropic-messages': extractAnthropicMessages,
    'openai-chat': extractOpenAIChat,
    'openai-responses': extractOpenAIResponses,
  };

  if (endpointType && extractors[endpointType]) {
    const result = extractors[endpointType](body);
    if (result) {
      log('提取上下文: endpointType=%s messages=%d tools=%d systemPromptLen=%d',
        endpointType, result.messages.length, result.tools.length, result.systemPrompt?.length ?? 0);
    }
    return result;
  }

  // Fallback：通过 body 字段判断
  if (body.system !== undefined) return extractAnthropicMessages(body);
  if (Array.isArray(body.messages) && body.messages.some((m: any) => m.role === 'system')) {
    return extractOpenAIChat(body);
  }
  if (body.instructions !== undefined) return extractOpenAIResponses(body);

  return null;
}