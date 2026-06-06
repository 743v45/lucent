/**
 * AgentProxy 类型定义
 */

// ==================== 日志条目 ====================
export interface LogEntry {
  id: string;
  timestamp: string;
  request: RequestData;
  response: ResponseData;
  agentType: AgentType;
  subAgentType?: SubAgentType;
  apiType?: ApiProviderType;
  duration: number;
  tokenUsage?: TokenUsage;
  metadata: Metadata;
  kvCache?: KVCacheInfo;
  context?: ContextData;
  error?: string;
}

export type AgentType = 'main' | 'sub';

export type SubAgentType = 'plan' | 'search' | 'bash' | 'workflow' | 'unknown';

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
  body: ResponseBody;
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

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens?: number;
  cache_read_tokens?: number;
}

export interface Metadata {
  model: string;
  provider: 'openai' | 'claude' | 'unknown';
  stream: boolean;
  error?: string;
}

export interface KVCacheInfo {
  hitRate?: number;
  cacheReadTokens?: number;
  cacheCreateTokens?: number;
  totalCachedTokens?: number;
  system?: string[];
  messages?: string[];
  tools?: string[];
  // 旧字段兼容
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
  systemPrompt?: string;
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

// ==================== 代理配置 ====================

/**
 * API 提供商类型
 */
export type ApiProviderType = 'anthropic-messages' | 'openai-chat' | 'openai-responses';

/**
 * API 类型标签映射
 */
export const API_TYPE_LABELS: Record<ApiProviderType, string> = {
  'anthropic-messages': 'Anthropic Messages',
  'openai-chat': 'OpenAI Chat',
  'openai-responses': 'OpenAI Responses',
};

/**
 * 代理配置 profile（完整信息，含 apiKey）
 */
export interface ProxyProfile {
  id: string;            // 简单递增 ID，如 '1', '2', '3'
  name: string;
  upstreamBaseUrl: string;
  apiKey: string;
}

/**
 * API 返回的脱敏 profile
 */
export interface SafeProxyProfile {
  id: string;
  name: string;
  upstreamBaseUrl: string;
  apiKeySet: boolean;
  apiKeyPreview: string;
}

/**
 * 代理分组（按 API 类型分组）
 */
export interface ProxyGroup {
  apiType: ApiProviderType;
  profiles: SafeProxyProfile[];
  activeProfileId: string;
}

/**
 * 全局代理配置（脱敏）
 */
export interface ProxyConfig {
  host: string;          // 服务器监听地址，默认 127.0.0.1
  proxyPort: number;     // 代理端口，默认 7048
  webPort: number;       // Web UI 端口，默认 7049
  groups: ProxyGroup[];
}

// 编辑时返回的完整 profile
export interface ProfileFull {
  id: string;
  name: string;
  upstreamBaseUrl: string;
  apiKey: string;
}

export interface CreateProfileData {
  name: string;
  upstreamBaseUrl: string;
  apiKey: string;
}

export interface UpdateProfileData {
  upstreamBaseUrl?: string;
  apiKey?: string;
}
