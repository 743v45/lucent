/**
 * KV-Cache 解析器
 * 从 Claude API 响应中解析缓存信息
 */

import {
  DEFAULT_CONTEXT_SIZE,
  LARGE_CONTEXT_SIZE,
  LARGE_CONTEXT_MODEL_PATTERN,
  TOOL_INPUT_PREVIEW_LENGTH,
} from './constants.js';
import createDebug from 'debug';
const log = createDebug('agentproxy:kvcache');

interface CacheControlBlock {
  type: string;
  cache_control?: { type: string };
  text?: string;
  [key: string]: unknown;
}

interface Message {
  role: string;
  content: string | CacheControlBlock[];
}

interface Tool {
  name: string;
  input_schema?: Record<string, unknown>;
  description?: string;
  [key: string]: unknown;
}

interface RequestBody {
  system?: string | CacheControlBlock[];
  messages?: Message[];
  tools?: Tool[];
  [key: string]: unknown;
}

interface ResponseUsage {
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
}

interface CachedContent {
  system: string[];
  messages: string[];
  tools: string[];
  cacheCreateTokens: number;
  cacheReadTokens: number;
  totalCachedTokens: number;
  hitRate: number;
}

/**
 * 格式化工具为 XML 字符串
 */
function formatToolAsXml(tool: Tool): string {
  const { name, description, input_schema } = tool;
  let xml = `<tool name="${name}">`;

  if (description) {
    xml += `<description>${escapeXml(description)}</description>`;
  }

  if (input_schema) {
    xml += `<parameters>${JSON.stringify(input_schema)}</parameters>`;
  }

  xml += '</tool>';
  return xml;
}

/**
 * 转义 XML 特殊字符
 */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * 从 tool_result 内容块中提取文本
 */
function extractToolResultText(toolResult: { content?: unknown; [key: string]: unknown }): string {
  if (!toolResult.content) return '';

  if (typeof toolResult.content === 'string') {
    return toolResult.content;
  }

  if (Array.isArray(toolResult.content)) {
    return toolResult.content
      .filter((b): b is { type: string; text?: string } => typeof b === 'object' && b?.type === 'text')
      .map(b => b.text || '')
      .join('\n');
  }

  return String(toolResult.content);
}

/**
 * 提取系统提示词中的缓存内容
 */
function extractCachedSystem(system: string | CacheControlBlock[]): string[] {
  const result: string[] = [];

  if (typeof system === 'string') {
    // 字符串形式的 system，如果有缓存会有 cache_control 标记
    // 但字符串形式无法标记，直接返回空
    return result;
  }

  if (Array.isArray(system)) {
    // 查找最后一个带有 cache_control 的块
    let lastCacheIndex = -1;
    for (let i = system.length - 1; i >= 0; i--) {
      if (system[i]?.cache_control) {
        lastCacheIndex = i;
        break;
      }
    }

    // 收集从开始到最后一个缓存块的所有文本
    if (lastCacheIndex >= 0) {
      for (let i = 0; i <= lastCacheIndex; i++) {
        const block = system[i];
        if (block?.type === 'text' && typeof block.text === 'string') {
          result.push(block.text);
        }
      }
    }
  }

  return result;
}

/**
 * 提取消息中的缓存内容
 */
function extractCachedMessages(messages: Message[]): string[] {
  const result: string[] = [];

  if (!Array.isArray(messages)) {
    return result;
  }

  // 查找最后一个带有 cache_control 的消息
  let lastCacheIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const content = messages[i]?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.cache_control) {
          lastCacheIndex = i;
          break;
        }
      }
      if (lastCacheIndex >= 0) break;
    }
  }

  // 收集所有缓存的消息
  if (lastCacheIndex >= 0) {
    for (let i = 0; i <= lastCacheIndex; i++) {
      const msg = messages[i];
      const content = msg?.content;

      if (typeof content === 'string') {
        result.push(`[${msg.role}] ${content}`);
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === 'text' && typeof block.text === 'string') {
            result.push(`[${msg.role}] ${block.text}`);
          } else if (block?.type === 'tool_use') {
            const inputStr = block.input ? JSON.stringify(block.input) : '';
            const preview = inputStr.length > TOOL_INPUT_PREVIEW_LENGTH
              ? inputStr.substring(0, TOOL_INPUT_PREVIEW_LENGTH) + '...'
              : inputStr;
            result.push(`[${msg.role}] ${block.name}(${preview})`);
          } else if (block?.type === 'tool_result' && block.tool_use_id) {
            const toolText = extractToolResultText(block);
            if (toolText) {
              result.push(`[tool_result: ${block.tool_use_id}] ${toolText}`);
            }
          }
        }
      }
    }
  }

  return result;
}

/**
 * 提取工具定义中的缓存内容
 */
function extractCachedTools(tools: Tool[], hasCachedSystem: boolean): string[] {
  const result: string[] = [];

  // 工具只有当系统有缓存时才被认为缓存
  // API 按照 tools → system → messages 的顺序缓存
  if (Array.isArray(tools) && tools.length > 0 && hasCachedSystem) {
    for (const tool of tools) {
      result.push(formatToolAsXml(tool));
    }
  }

  return result;
}

/**
 * 从请求体中提取缓存内容
 */
export function extractCachedContent(body: RequestBody, usage?: ResponseUsage): CachedContent {
  const result: CachedContent = {
    system: [],
    messages: [],
    tools: [],
    cacheCreateTokens: 0,
    cacheReadTokens: 0,
    totalCachedTokens: 0,
    hitRate: 0,
  };

  if (!body) {
    return result;
  }

  // 提取 usage 数据
  result.cacheCreateTokens = usage?.cache_creation_input_tokens || 0;
  result.cacheReadTokens = usage?.cache_read_input_tokens || 0;
  result.totalCachedTokens = result.cacheCreateTokens + result.cacheReadTokens;

  // 计算命中率
  const totalInputTokens = (usage?.input_tokens || 0) + result.totalCachedTokens;
  if (totalInputTokens > 0) {
    result.hitRate = Math.round((result.cacheReadTokens / totalInputTokens) * 100);
  }

  // 提取系统缓存
  const cachedSystem = extractCachedSystem(body.system || []);
  result.system = cachedSystem;

  // 提取消息缓存
  const cachedMessages = extractCachedMessages(body.messages || []);
  result.messages = cachedMessages;

  // 提取工具缓存
  const cachedTools = extractCachedTools(body.tools || [], cachedSystem.length > 0);
  result.tools = cachedTools;

  log('KV 缓存: create=%d read=%d hitRate=%d%% systemBlocks=%d messageBlocks=%d toolBlocks=%d',
    result.cacheCreateTokens, result.cacheReadTokens, result.hitRate,
    result.system.length, result.messages.length, result.tools.length);

  return result;
}

/**
 * 构建上下文窗口事件数据
 */
export function buildContextWindowEvent(
  usage?: ResponseUsage,
  contextSize: number = DEFAULT_CONTEXT_SIZE
): {
  total_input_tokens: number;
  total_output_tokens: number;
  context_window_size: number;
  current_usage: ResponseUsage | undefined;
  used_percentage: number;
  remaining_percentage: number;
} | null {
  if (!usage) {
    return null;
  }

  const inputTokens =
    (usage.input_tokens || 0) +
    (usage.cache_creation_input_tokens || 0) +
    (usage.cache_read_input_tokens || 0);
  const outputTokens = usage.output_tokens || 0;
  const totalTokens = inputTokens + outputTokens;

  // 自适应纠偏：如果输入超过 200K，可能是 1M 上下文模型
  const effectiveSize = contextSize === DEFAULT_CONTEXT_SIZE && inputTokens > DEFAULT_CONTEXT_SIZE ? LARGE_CONTEXT_SIZE : contextSize;

  const usedPct = Math.round((totalTokens / effectiveSize) * 100);

  return {
    total_input_tokens: inputTokens,
    total_output_tokens: outputTokens,
    context_window_size: effectiveSize,
    current_usage: usage,
    used_percentage: usedPct,
    remaining_percentage: 100 - usedPct,
  };
}

/**
 * 解析模型基础名称（用于上下文窗口计算）
 */
export function parseModelBaseName(model: string): string {
  if (!model) return 'unknown';

  const lower = model.toLowerCase();

  // claude-opus-4-6-20250514 -> opus-4-6
  const base = lower.replace(/^claude-/i, '').replace(/-\d{8}$/, '').trim();

  return base;
}

/**
 * 根据模型名称获取上下文窗口大小
 */
export function getContextSizeForModel(model: string): number {
  if (!model) return DEFAULT_CONTEXT_SIZE;

  const lower = model.toLowerCase();

  // Opus / Mythos 模型默认 1M 上下文
  if (LARGE_CONTEXT_MODEL_PATTERN.test(lower)) {
    return LARGE_CONTEXT_SIZE;
  }

  // 其他模型默认 200K
  return DEFAULT_CONTEXT_SIZE;
}
