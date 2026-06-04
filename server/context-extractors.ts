/**
 * Context Extractors
 *
 * Provides extraction functions for different API formats to extract unified context data.
 */

import { API_PATH_REGEX } from './constants.js';

// ==================== 类型定义 ====================

export type ApiProviderType = 'anthropic-messages' | 'openai-chat' | 'openai-responses' | 'gemini-generate';

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
  if (API_PATH_REGEX.OPENAI_RESPONSES.test(url)) return 'openai-responses';
  if (API_PATH_REGEX.ANTHROPIC_MESSAGES.test(url)) return 'anthropic-messages';
  if (API_PATH_REGEX.OPENAI_CHAT.test(url)) return 'openai-chat';
  if (API_PATH_REGEX.GEMINI_GENERATE.test(url)) return 'gemini-generate';

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

// ==================== Gemini Generate Content API ====================

/**
 * 从 Gemini Generate Content API 请求体中提取 context
 * URL: /v{version}/models/{model}:generateContent
 * Body: { systemInstruction?: { parts: Array<{text?: string}> }, contents: Content[], tools?: Tool[] }
 */
export function extractGeminiGenerateContent(body: any): ExtractedContext | null {
  if (!body || typeof body !== 'object') {
    return null;
  }

  // 提取 system prompt（从 systemInstruction.parts）
  let systemPrompt: string | undefined;
  if (body.systemInstruction?.parts && Array.isArray(body.systemInstruction.parts)) {
    const textParts = body.systemInstruction.parts
      .filter((p: any) => p.text && typeof p.text === 'string');
    if (textParts.length > 0) {
      systemPrompt = textParts.map((p: any) => p.text).join('\n');
    }
  }

  // 提取 messages（从 contents）
  const messages: NormalizedMessage[] = [];
  if (Array.isArray(body.contents)) {
    for (const content of body.contents) {
      // role "user" 保留，role "model" 映射为 "assistant"
      const role = content.role === 'model' ? 'assistant' : content.role || 'user';

      // 从 parts 提取 content
      const extractedContent = extractGeminiParts(content.parts);
      if (extractedContent) {
        messages.push({ role, content: extractedContent });
      }
    }
  }

  // 提取 tools（从 tools[].functionDeclarations）
  const tools: NormalizedTool[] = [];
  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) {
      if (Array.isArray(tool.functionDeclarations)) {
        for (const func of tool.functionDeclarations) {
          tools.push({
            name: func.name,
            description: func.description,
          });
        }
      }
    }
  }

  return { systemPrompt, messages, tools };
}

/**
 * 从 Gemini parts 中提取 content
 * 支持文本、functionCall、functionResponse
 */
function extractGeminiParts(parts: any[] | undefined): string | ContentBlock[] | null {
  if (!Array.isArray(parts) || parts.length === 0) {
    return null;
  }

  // 如果只有文本部分，直接返回字符串
  const textParts = parts.filter(p => p.text && typeof p.text === 'string');
  if (textParts.length === parts.length) {
    return textParts.map(p => p.text).join('');
  }

  // 否则返回 ContentBlock[]
  const blocks: ContentBlock[] = [];
  for (const part of parts) {
    if (part.text) {
      blocks.push({ type: 'text', text: part.text });
    } else if (part.functionCall) {
      blocks.push({
        type: 'tool_use',
        id: part.functionCall.id || '',
        name: part.functionCall.name,
        input: part.functionCall.args,
      });
    } else if (part.functionResponse) {
      blocks.push({
        type: 'tool_result',
        tool_use_id: part.functionResponse.id || '',
        content: part.functionResponse.response,
      });
    }
  }

  return blocks.length > 0 ? blocks : null;
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
    'gemini-generate': extractGeminiGenerateContent,
  };

  if (apiType && extractors[apiType]) {
    return extractors[apiType](body);
  }

  // Fallback：尝试通过 body 字段判断
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

  // 如果 body.contents 存在 → Gemini
  if (body.contents !== undefined) {
    return extractGeminiGenerateContent(body);
  }

  // 无法识别，返回 null
  return null;
}
