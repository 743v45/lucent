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
const log = createDebug('lucent:kvcache');

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

type CacheMode = 'explicit' | 'auto' | 'none';
type CacheStatus = 'unsupported' | 'first-create' | 'hit' | 'no-data';
type BlockKind = 'hit' | 'create' | 'mixed';
type Provider = 'anthropic' | 'openai' | 'unknown';

interface KVCacheBlock {
  text: string;
  tokens?: number;
  kind?: BlockKind;
}

interface ResponseUsage {
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  // OpenAI 自动缓存字段
  prompt_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens?: number;
}

interface ExtractOptions {
  endpointType?: string;
  provider?: string;
}

interface CachedContent {
  system: KVCacheBlock[];
  messages: KVCacheBlock[];
  tools: KVCacheBlock[];
  cacheCreateTokens: number;
  cacheReadTokens: number;
  totalCachedTokens: number;
  totalInputTokens: number;
  uncachedInputTokens: number;
  hitRate: number;
  cacheMode: CacheMode;
  provider: Provider;
  status: CacheStatus;
}

/**
 * 估算文本 token 数（约值）
 *
 * 区分 CJK 与 ASCII：CJK 字符约 1.5 字符/token，ASCII 约 4 字符/token。
 * 纯 length/4 会严重低估中文（中文 1 字符 ≈ 0.6-0.7 token）。
 */
function estimateTokens(text: string): number {
  if (!text) return 1;

  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    // CJK 统一表意文字 / CJK 标点 / 平假名·片假名 / 韩文音节 / 全角形式
    if (
      (code >= 0x4E00 && code <= 0x9FFF) ||
      (code >= 0x3000 && code <= 0x30FF) ||
      (code >= 0xAC00 && code <= 0xD7AF) ||
      (code >= 0xFF00 && code <= 0xFFEF)
    ) {
      cjk++;
    } else {
      other++;
    }
  }

  return Math.max(1, Math.round(cjk / 1.5 + other / 4));
}

/**
 * 探测请求体中是否存在 cache_control 标记（仅 Anthropic 显式缓存）
 */
function hasCacheControlMarker(body: RequestBody): boolean {
  const scanBlocks = (blocks: unknown[]): boolean =>
    blocks.some(b => b && typeof b === 'object' && 'cache_control' in (b as Record<string, unknown>));

  if (Array.isArray(body.system) && scanBlocks(body.system)) return true;

  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (Array.isArray(msg?.content) && scanBlocks(msg.content)) return true;
    }
  }

  if (Array.isArray(body.tools) && scanBlocks(body.tools)) return true;

  return false;
}

/**
 * 推断 provider：endpointType 含 'anthropic' → anthropic；含 'openai' → openai；否则 unknown
 */
function deriveProvider(endpointType?: string, provider?: string): Provider {
  const et = (endpointType || '').toLowerCase();
  if (et.includes('anthropic')) return 'anthropic';
  if (et.includes('openai')) return 'openai';
  const p = (provider || '').toLowerCase();
  if (p === 'anthropic' || p === 'claude') return 'anthropic';
  if (p === 'openai') return 'openai';
  return 'unknown';
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
function extractCachedSystem(system: string | CacheControlBlock[], kind?: BlockKind): KVCacheBlock[] {
  const result: KVCacheBlock[] = [];

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
          result.push({ text: block.text, tokens: estimateTokens(block.text), kind });
        }
      }
    }
  }

  return result;
}

/**
 * 提取消息中的缓存内容
 */
function extractCachedMessages(messages: Message[], kind?: BlockKind): KVCacheBlock[] {
  const result: KVCacheBlock[] = [];

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

  const pushBlock = (text: string): void => {
    if (text) result.push({ text, tokens: estimateTokens(text), kind });
  };

  // 收集所有缓存的消息
  if (lastCacheIndex >= 0) {
    for (let i = 0; i <= lastCacheIndex; i++) {
      const msg = messages[i];
      const content = msg?.content;

      if (typeof content === 'string') {
        pushBlock(`[${msg.role}] ${content}`);
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === 'text' && typeof block.text === 'string') {
            pushBlock(`[${msg.role}] ${block.text}`);
          } else if (block?.type === 'tool_use') {
            const inputStr = block.input ? JSON.stringify(block.input) : '';
            const preview = inputStr.length > TOOL_INPUT_PREVIEW_LENGTH
              ? inputStr.substring(0, TOOL_INPUT_PREVIEW_LENGTH) + '...'
              : inputStr;
            pushBlock(`[${msg.role}] ${block.name}(${preview})`);
          } else if (block?.type === 'tool_result' && block.tool_use_id) {
            const toolText = extractToolResultText(block);
            if (toolText) {
              pushBlock(`[tool_result: ${block.tool_use_id}] ${toolText}`);
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
function extractCachedTools(tools: Tool[], hasCachedSystem: boolean, kind?: BlockKind): KVCacheBlock[] {
  const result: KVCacheBlock[] = [];
  if (!Array.isArray(tools) || tools.length === 0) return result;

  // tools 被缓存的条件（满足其一）：
  // 1. tools 自身带 cache_control 标记（独立缓存断点）
  // 2. system 有缓存（前缀式：tools 排在 system 之前，跟随系统缓存）
  const toolsHaveCacheMarker = tools.some(t => t && typeof t === 'object' && 'cache_control' in t);
  if (toolsHaveCacheMarker || hasCachedSystem) {
    for (const tool of tools) {
      const text = formatToolAsXml(tool);
      result.push({ text, tokens: estimateTokens(text), kind });
    }
  }

  return result;
}

/**
 * 从请求体中提取缓存内容
 *
 * 支持两种缓存模式：
 * - explicit（Anthropic）：body 含 cache_control 标记，usage 含 cache_creation/cache_read
 * - auto（OpenAI）：无显式标记，usage.prompt_tokens_details.cached_tokens 表示命中读取
 */
export function extractCachedContent(
  body: RequestBody,
  usage?: ResponseUsage,
  options?: ExtractOptions,
): CachedContent {
  const endpointType = options?.endpointType;
  const provider = deriveProvider(endpointType, options?.provider);

  // cacheMode 判定
  const isOpenAI = endpointType === 'openai-chat' || endpointType === 'openai-responses';
  let cacheMode: CacheMode = 'none';
  if (endpointType === 'anthropic-messages' && body && hasCacheControlMarker(body)) {
    cacheMode = 'explicit';
  } else if (isOpenAI) {
    cacheMode = 'auto';
  }

  const result: CachedContent = {
    system: [],
    messages: [],
    tools: [],
    cacheCreateTokens: 0,
    cacheReadTokens: 0,
    totalCachedTokens: 0,
    totalInputTokens: 0,
    uncachedInputTokens: 0,
    hitRate: 0,
    cacheMode,
    provider,
    status: 'no-data',
  };

  if (!body) {
    // 无 body：未知模式 + 无数据
    return result;
  }

  // token 提取（按协议分支）
  if (isOpenAI) {
    // OpenAI 自动缓存：cached_tokens 当作 read，无 create 概念
    const cachedTokens = usage?.prompt_tokens_details?.cached_tokens || 0;
    result.cacheReadTokens = cachedTokens;
    result.cacheCreateTokens = 0;
    result.totalInputTokens = usage?.prompt_tokens || 0;
  } else {
    // Anthropic 显式缓存（默认分支）
    result.cacheCreateTokens = usage?.cache_creation_input_tokens || 0;
    result.cacheReadTokens = usage?.cache_read_input_tokens || 0;
    result.totalInputTokens =
      (usage?.input_tokens || 0) +
      (usage?.cache_creation_input_tokens || 0) +
      (usage?.cache_read_input_tokens || 0);
  }

  result.totalCachedTokens = result.cacheReadTokens + result.cacheCreateTokens;
  result.uncachedInputTokens = Math.max(0, result.totalInputTokens - result.totalCachedTokens);

  // hitRate 修正口径：命中读 / 总输入（仅看 cacheRead，不含 create）
  if (result.totalInputTokens > 0) {
    result.hitRate = Math.round((result.cacheReadTokens / result.totalInputTokens) * 100);
  }

  // status 四态判定
  if (result.cacheReadTokens > 0) {
    result.status = 'hit';
  } else if (result.cacheCreateTokens > 0) {
    result.status = 'first-create';
  } else if (cacheMode === 'none') {
    result.status = 'unsupported';
  } else {
    result.status = 'no-data';
  }

  // block-level kind 判定（仅 explicit 模式有意义）
  const blockKind: BlockKind | undefined =
    cacheMode === 'explicit'
      ? result.cacheReadTokens > 0
        ? 'hit'
        : result.cacheCreateTokens > 0
          ? 'create'
          : undefined
      : undefined;

  // 提取系统缓存
  const cachedSystem = extractCachedSystem(body.system || [], blockKind);
  result.system = cachedSystem;

  // 提取消息缓存
  const cachedMessages = extractCachedMessages(body.messages || [], blockKind);
  result.messages = cachedMessages;

  // 提取工具缓存
  const cachedTools = extractCachedTools(body.tools || [], cachedSystem.length > 0, blockKind);
  result.tools = cachedTools;

  log('KV 缓存: mode=%s provider=%s status=%s create=%d read=%d hitRate=%d%% totalIn=%d uncachedIn=%d systemBlocks=%d messageBlocks=%d toolBlocks=%d',
    result.cacheMode, result.provider, result.status,
    result.cacheCreateTokens, result.cacheReadTokens, result.hitRate,
    result.totalInputTokens, result.uncachedInputTokens,
    result.system.length, result.messages.length, result.tools.length);

  return result;
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
