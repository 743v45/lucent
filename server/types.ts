/**
 * Lucent 服务端统一类型定义
 *
 * 消除分散在 interceptor.ts、config.ts、context-extractors.ts 中的重复类型
 */

// ==================== 端点协议类型 ====================

export type EndpointType = 'openai-chat' | 'openai-responses' | 'anthropic-messages';

/** 所有支持的端点协议类型 */
export const ENDPOINT_TYPES: EndpointType[] = ['openai-chat', 'openai-responses', 'anthropic-messages'];

/** 类型守卫：判断字符串是否为合法的 EndpointType */
export function isEndpointType(s: string): s is EndpointType {
  return (ENDPOINT_TYPES as string[]).includes(s);
}

/** 校验 provider name 是否合法（[a-zA-Z0-9_-]{1,32}） */
const PROVIDER_NAME_REGEX = /^[a-zA-Z0-9_-]{1,32}$/;
export function isValidProviderName(name: string): boolean {
  return typeof name === 'string' && PROVIDER_NAME_REGEX.test(name);
}

// ==================== 供应商 ====================

export interface Provider {
  id: string;
  /** 全局唯一，只允许 [a-zA-Z0-9_-]{1,32} */
  name: string;
  /** 预设供应商名（与前端 presets.ts 保持一致）；存在时 name 必须等于 presetName */
  presetName?: string;
  /** 每种协议对应的上游 URL；null = 该协议不支持 */
  endpoints: Record<EndpointType, string | null>;
}

/** 预设供应商保留名集合（与前端 presets.ts 保持一致） */
export const PRESET_NAMES: ReadonlySet<string> = new Set([
  'anthropic', 'openai', 'gemini', 'deepseek', 'groq', 'mistral',
  'together', 'fireworks', 'perplexity', 'cohere', 'zhipu', 'moonshot',
  'qwen', 'baichuan', 'minimax', 'spark', 'doubao', 'stepfun',
  'siliconcloud', 'openrouter', 'xai', 'cerebras', 'deepinfra',
  'novita', 'sambanova', 'nvidia',
]);

// ==================== 客户端类型 ====================

export type ClientType = 'claude-code' | 'opencode' | 'codex' | 'cursor' | 'windsurf' | 'test-client' | 'unknown';

// ==================== Agent 类型 ====================

export type AgentType = 'main' | 'sub';

// ==================== 日志条目（前端格式） ====================

/** 单个 KV-Cache 块（工具 / 系统 / 消息） */
export interface KVCacheBlock {
  /** 文本内容 */
  text: string;
  /** 估算 token 数 */
  tokens?: number;
  /** 命中类型 */
  kind?: 'hit' | 'create';
}

export interface KVCacheInfo {
  hitRate?: number;
  cacheReadTokens?: number;
  cacheCreateTokens?: number;
  totalCachedTokens?: number;
  totalInputTokens?: number;
  uncachedInputTokens?: number;
  /** 缓存模式：explicit=显式 cache_control / auto=自动（OpenAI）/ none=未启用 */
  cacheMode?: 'explicit' | 'auto' | 'none';
  /** 供应商名称 */
  provider?: string;
  /** 缓存状态 */
  status?: 'unsupported' | 'first-create' | 'hit' | 'no-data';
  /** 工具缓存块 */
  tools?: KVCacheBlock[];
  /** 系统提示词缓存块 */
  system?: KVCacheBlock[];
  /** 消息缓存块 */
  messages?: KVCacheBlock[];
}

export interface LogEntry {
  id: string;
  timestamp: string;
  request: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body: unknown;
  };
  response: {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body: unknown;
  } | null;
  agentType: AgentType;
  apiType?: EndpointType;
  clientType?: ClientType;
  duration: number;
  tokenUsage?: {
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens?: number;
    cache_creation_tokens?: number;
  };
  metadata: {
    model: string;
    provider: 'openai' | 'claude' | 'unknown';
    stream: boolean;
    error?: string;
  };
  kvCache?: KVCacheInfo;
  context?: {
    messages?: Array<{
      role: string;
      content: string | Array<{ type: string; text?: string; [key: string]: unknown }>;
      timestamp: string;
      tool_use_id?: string;
      name?: string;
      id?: string;
    }>;
    summary?: {
      totalMessages: number;
      userMessages: number;
      assistantMessages: number;
      toolMessages: number;
      systemPromptLength: number;
      toolsCount: number;
      duration: number;
    };
    systemPrompt?: string;
    tools?: Array<{ name: string; description?: string }>;
    contextWindow?: {
      totalTokens: number;
      contextSize: number;
      usedPercentage: number;
      remainingPercentage: number;
    };
  };
  error?: string;
  /** 请求经过的供应商名称（来自配置中的 provider.name） */
  providerName?: string;
  /** 请求使用的端点协议（openai-chat / openai-responses / anthropic-messages） */
  endpointType?: EndpointType;
  /** 会话线索标识 */
  threadId?: string;
  /** 是否为测试请求（配置/连接测试） */
  isTest?: boolean;
}

// ==================== 拦截器原始日志格式 ====================

export interface RawLogEntry {
  id: string;
  timestamp: string;
  project: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  request?: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body: unknown;
  };
  response: {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body: unknown;
  } | null;
  duration: number;
  isStream: boolean;
  mainAgent: boolean;
  inProgress?: boolean;
  agentType?: AgentType;
  apiType?: EndpointType;
  clientType?: ClientType;
  isTest?: boolean;
  error?: string;
  /** 请求经过的供应商名称 */
  providerName?: string;
  /** 请求使用的端点协议 */
  endpointType?: EndpointType;
  /** 会话线索标识（内容寻址，仅 main） */
  threadId?: string;
  tokenUsage?: {
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens?: number;
    cache_creation_tokens?: number;
  };
  kvCache?: LogEntry['kvCache'];
  context?: LogEntry['context'];
}

// ==================== SSE 流提取 ====================

/**
 * SSE 原始行数据（存储格式）
 */
export interface SSERawLine {
  event: string;
  data: string;
}

/**
 * SSE 原始响应体（存储格式）
 */
export interface SSERawBody {
  type: 'sse_raw';
  lines: SSERawLine[];
  error?: string;
  /** 流被截断（超时或上游断连）时为 true */
  truncated?: boolean;
}

export interface ExtractedInfo {
  text: string;
  thinking: string;
  toolCalls: Array<{ id?: string; name: string; input: unknown }>;
  usage: { input: number; output: number; cache_read: number; cache_create: number };
  stopReason: string;
  model: string;
}

// ==================== 代理状态 ====================

export interface ProxyStatus {
  enabled: boolean;
  running: boolean;
  host: string;
  webPort: number;
  proxyPort: number;
  logFile: string | null;
  providers?: unknown[];
}

// ==================== 日志查询 ====================

export interface LogsQuery {
  limit?: number;
  offset?: number;
  agentType?: AgentType | 'all';
  startDate?: string;
  endDate?: string;
  search?: string;
}
