/**
 * Lucent 服务端统一类型定义
 *
 * 消除分散在 interceptor.ts、config.ts、context-extractors.ts 中的重复类型
 */

// ==================== 端点协议类型 ====================

// 协议身份维度单源:见 shared/protocols.ts。EndpointType 等全部从 registry 派生,
// 禁止手写协议联合字面量(protocol-model spec Req 2)。
import { ProtocolId, PROTOCOL_IDS } from '../shared/protocols.js';

export type EndpointType = ProtocolId;

/** 所有支持的端点协议类型(派生自 PROTOCOL_REGISTRY) */
export const ENDPOINT_TYPES: EndpointType[] = PROTOCOL_IDS;

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

// ==================== Body 重写规则 ====================

/**
 * 单条请求 body 重写规则（可选功能，配置于 ProxyConfig.bodyRewrites）。
 *
 * 语义：对 fieldPath 定位到的字符串叶子值执行
 *   value.replace(new RegExp(pattern, flags ?? 'g'), replacement)
 * 即「子串替换」——保留未匹配部分。仅当叶子值 typeof === 'string' 才替换，非 string 跳过。
 *
 * ⚠️ 副作用（opt-in 固有代价）：
 * - 重写位于 Anthropic KV-Cache 前缀内的字段（典型 system[0].text）会使上游缓存按字节寻址失效，
 *   触发 cache 重建（cache_read 归零、重新 cache_creation）。
 * - interceptor 的 agent 分类（classifyAgent）与会话线索（threadId）跑在重写后的 body 上，
 *   激进脱敏可能改变分类与线索。
 */
export interface BodyRewriteRule {
  /** 规则唯一标识，非空字符串，用于错误归因与日志 */
  id: string;
  /** 人类可读规则名，可选（仅展示用） */
  name?: string;
  /** 是否启用；缺省视为 true。设为 false 可临时停用而不删除 */
  enabled?: boolean;
  /** 目标字段路径，如 "system[0].text"、"messages[0].content[1].text" */
  fieldPath: string;
  /** JS 正则源串（不含定界符），如 "x-anthropic-billing-header:[^;]*;" */
  pattern: string;
  /** 正则 flags，仅允许 [gimsuy]* 字符组合；缺省运行期按 "g" 处理 */
  flags?: string;
  /** 替换字符串，支持 $1/$& 等反向引用；空串 "" 表示删除匹配子串 */
  replacement: string;
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
  /** 首个生成 token（思考或回答，先到者）相对请求到达的时延，ms；流式专属，缺省=无数据 */
  ttftFirstTokenMs?: number;
  /** 首个思考 token 相对请求到达的时延，ms；无思考则缺省 */
  ttftThinkingMs?: number;
  /** 首个回答 token 相对请求到达的时延，ms；无回答文本则缺省 */
  ttftAnswerMs?: number;
  /** 生成吞吐（decode 阶段，首 token 之后），tokens/秒；流式专属 */
  tokensPerSecond?: number;
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
    systemPrompt?: string[];
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
  /** 临时日志到期时间（ISO）；缺省=存档不过期，非空=临时到期由独立定时器清理 */
  expiresAt?: string;
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
  ttftFirstTokenMs?: number;
  ttftThinkingMs?: number;
  ttftAnswerMs?: number;
  tokensPerSecond?: number;
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
  /** 临时日志到期时间（ISO）；缺省=存档不过期（写库时由 logMode 决定是否注入） */
  expiresAt?: string;
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
  /** keyset 深分页游标（base64url {ts,id}）；优先于 offset */
  cursor?: string;
  agentType?: AgentType | 'all';
  providerName?: string;
  endpointType?: string;
  startDate?: string;
  endDate?: string;
  search?: string;
}

/** readLogs 返回：列表 + 命中总数 + 下一页游标 + 是否还有更多 */
export interface LogsResult {
  logs: LogEntry[];
  total: number;
  nextCursor: string | null;
  hasMore: boolean;
}
