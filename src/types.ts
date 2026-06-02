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
  duration: number;
  tokenUsage?: TokenUsage;
  metadata: Metadata;
  kvCache?: KVCacheInfo;
  context?: unknown;
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
  hitRate?: string;
  readBytes?: number;
  writeBytes?: number;
  content?: string;
}

// ==================== 代理状态 ====================
export interface ProxyStatus {
  enabled: boolean;
  running: boolean;
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

export type Theme = 'light' | 'dark';

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
