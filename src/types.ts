/**
 * Lucent 类型定义
 */

// ==================== 日志条目 ====================
export interface LogEntry {
  id: string;
  timestamp: string;
  request: RequestData;
  response: ResponseData;
  agentType: AgentType;
  apiType?: EndpointType;
  clientType?: ClientType;
  duration: number;
  /** 首个生成 token（思考/回答先到者）相对请求到达的时延，ms；流式专属 */
  ttftFirstTokenMs?: number;
  /** 首个思考 token 相对请求到达的时延，ms */
  ttftThinkingMs?: number;
  /** 首个回答 token 相对请求到达的时延，ms */
  ttftAnswerMs?: number;
  /** 生成吞吐（decode 阶段），tokens/秒；流式专属 */
  tokensPerSecond?: number;
  tokenUsage?: TokenUsage;
  metadata: Metadata;
  kvCache?: KVCacheInfo;
  context?: ContextData;
  error?: string;
  isTest?: boolean;
  /** 请求经过的供应商名称（来自配置中的 provider.name） */
  providerName?: string;
  /** 会话线索标识：同一对话（首条 user 锚定）的多次 main 请求共享。仅 main 填充。 */
  threadId?: string;
  /** 请求使用的端点协议（openai-chat / openai-responses / anthropic-messages） */
  endpointType?: EndpointType;
}

export type AgentType = 'main' | 'sub';

export type ClientType = 'claude-code' | 'opencode' | 'codex' | 'cursor' | 'windsurf' | 'zcode' | 'test-client' | 'unknown';

export interface RequestData {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: RequestBody;
}

export interface RequestBody {
  model: string;
  messages: Message[];
  tools?: Tool[];
  system?: string;
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
}

export interface Message {
  role: string;
  content: string | ContentBlock[];
}

export interface ContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface Tool {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ResponseData {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: ResponseBody | SSERawBody;
}

export interface ResponseBody {
  id: string;
  type: string;
  role: string;
  content: ContentBlock[];
  usage?: TokenUsage;
  stop_reason?: string;
  [key: string]: unknown;
}

/**
 * SSE 原始响应体（存储格式）
 */
export interface SSERawBody {
  type: 'sse_raw';
  lines: SSERawLine[];
  error?: string;
}

/**
 * SSE 原始行数据
 */
export interface SSERawLine {
  event: string;
  data: string;
}

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens?: number;
  cache_read_tokens?: number;
}

/**
 * SSE 提取后的结构化信息
 */
export interface ExtractedInfo {
  text: string;
  thinking: string;
  toolCalls: Array<{ id?: string; name: string; input: unknown }>;
  usage: { input: number; output: number; cache_read: number; cache_create: number };
  stopReason: string;
  model: string;
}

export interface Metadata {
  model: string;
  provider: 'openai' | 'claude' | 'unknown';
  stream: boolean;
  error?: string;
}

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
  // 旧字段兼容（前端不再优先用）
  readBytes?: number;
  writeBytes?: number;
  content?: string;
}

// ==================== 代理状态 ====================
export interface ProxyStatus {
  enabled: boolean;
  running: boolean;
  host: string;
  webPort: number;
  proxyPort: number;
  logFile: string | null;
  providers?: Provider[];
  /** 是否记录日志（有效值，env LUCENT_LOG_RECORDING 覆盖时由 env 决定） */
  logRecording?: boolean;
  /** 记录开关是否被环境变量 LUCENT_LOG_RECORDING 锁定（锁定时 UI 不可切） */
  logRecordingEnvLocked?: boolean;
}

// ==================== UI 状态 ====================
export interface AppState {
  proxy: ProxyStatus;
  logs: LogEntry[];
  selectedId: string | null;
  activeTab: TabType;
  theme: Theme;
  loading: boolean;
}

export type TabType = 'request' | 'response' | 'kvcache' | 'context' | 'meta';

export type Theme = 'light';

// ==================== 过滤选项 ====================
export interface FilterOptions {
  agentType?: 'all' | 'main' | 'sub';
  provider?: 'all' | 'openai' | 'claude';
  dateRange?: [Date, Date];
  searchQuery?: string;
}

// ==================== 设置 ====================
export interface Preferences {
  theme: Theme;
  activeTab: TabType;
  sidebarWidth: number;
  autoCollapse: boolean;
  showThinking: boolean;
  showFullTools: boolean;
  conversationView: 'timeline' | 'session';
}

export interface SettingsContextValue {
  preferences: Preferences;
  updatePreferences: (updates: Partial<Preferences>) => void;
  claudeSettings?: Record<string, unknown>;
  updateClaudeSettings?: (settings: Record<string, unknown>) => void;
}

// ==================== Context 数据 ====================
export interface ContextData {
  messages?: ContextMessage[];
  summary?: ContextSummary;
  /** 系统提示词分段（N 段就 N 个元素，不再拼接）。Anthropic system 数组逐段、OpenAI Chat 逐 system 消息、Responses instructions 单段。 */
  systemPrompt?: string[];
  tools?: Tool[];
  contextWindow?: ContextWindowInfo;
}

export interface ContextMessage {
  role: string;
  content: string | ContentBlock[];
  timestamp: string;
  tool_use_id?: string;
  name?: string;
  id?: string;
}

export interface ContextSummary {
  totalMessages: number;
  userMessages: number;
  assistantMessages: number;
  toolMessages: number;
  systemPromptLength: number;
  toolsCount: number;
  duration: number;
}

export interface ContextWindowInfo {
  totalTokens: number;
  contextSize: number;
  usedPercentage: number;
  remainingPercentage: number;
}

// ==================== 端点协议类型 ====================

// 协议身份维度单源:见 shared/protocols.ts。EndpointType 等全部从 registry 派生,
// 禁止手写协议联合字面量(protocol-model spec Req 2)。
import { ProtocolId, PROTOCOL_IDS, PROTOCOL_REGISTRY } from '../shared/protocols.js';

/**
 * 端点协议类型(派生自 PROTOCOL_REGISTRY)
 */
export type EndpointType = ProtocolId;

/** 所有支持的端点协议类型(派生自 PROTOCOL_REGISTRY) */
export const ENDPOINT_TYPES: EndpointType[] = PROTOCOL_IDS;

/** 端点协议类型的友好名称(派生自 PROTOCOL_REGISTRY) */
export const ENDPOINT_LABELS = Object.fromEntries(
  PROTOCOL_IDS.map(id => [id, PROTOCOL_REGISTRY[id].label])
) as Record<EndpointType, string>;

/** 类型守卫：判断字符串是否为合法的 EndpointType */
export function isEndpointType(s: string): s is EndpointType {
  return (ENDPOINT_TYPES as string[]).includes(s);
}

/** 校验 provider name 是否合法（[a-zA-Z0-9_-]{1,32}） */
const PROVIDER_NAME_REGEX = /^[a-zA-Z0-9_-]{1,32}$/;
export function isValidProviderName(name: string): boolean {
  return typeof name === 'string' && PROVIDER_NAME_REGEX.test(name);
}

// ==================== 供应商预设 ====================

/**
 * 供应商预设（品牌信息 + 默认端点）
 */
export interface ProviderPreset {
  /** 唯一标识，如 'anthropic' */
  name: string;
  /** 显示名，如 'Anthropic' */
  label: string;
  /** @lobehub/icons/es/ 下的目录名 */
  iconKey: string;
  /** 分类：official = 原始 LLM 厂商；community = 聚合/代理/三方 */
  category: 'official' | 'community';
  /** 每种协议对应的默认端点 URL；null = 该协议不支持 */
  endpoints: Record<EndpointType, string | null>;
}

// ==================== 供应商 ====================

/**
 * 供应商定义
 */
export interface Provider {
  id: string;
  /** 全局唯一，只允许 [a-zA-Z0-9_-]{1,32} */
  name: string;
  /** 匹配的预设名称，如 'anthropic'、'openai' */
  presetName?: string;
  /** 每种协议对应的上游 URL；null = 该协议不支持 */
  endpoints: Record<EndpointType, string | null>;
}

// ==================== Body 重写规则 ====================

/**
 * 单条请求 body 重写规则（与 server/types.ts 对齐）
 *
 * 语义：对 fieldPath 定位的字符串叶子值做子串替换
 *   value.replace(new RegExp(pattern, flags ?? 'g'), replacement)
 */
export interface BodyRewriteRule {
  id: string;
  /** 人类可读名，可选 */
  name?: string;
  /** 是否启用，缺省 true */
  enabled?: boolean;
  /** 字段路径，如 "system[0].text" */
  fieldPath: string;
  /** JS 正则源串 */
  pattern: string;
  /** 正则 flags，仅 [gimsuy]*，缺省 'g' */
  flags?: string;
  /** 替换字符串，空串=删除匹配子串 */
  replacement: string;
}

// ==================== 代理配置 ====================

/**
 * 全局代理配置
 */
export interface ProxyConfig {
  host: string;          // 服务器监听地址，默认 127.0.0.1
  proxyPort: number;     // 代理端口，默认 7048
  webPort: number;       // Web UI 端口，默认 7049
  providers: Provider[];
}
