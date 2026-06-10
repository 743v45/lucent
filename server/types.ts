/**
 * Lucent 服务端统一类型定义
 *
 * 消除分散在 interceptor.ts、config.ts、context-extractors.ts 中的重复类型
 */

// ==================== API 提供商 ====================

export type ApiProviderType = 'anthropic-messages' | 'openai-chat' | 'openai-responses';

// ==================== 客户端类型 ====================

export type ClientType = 'claude-code' | 'opencode' | 'codex' | 'cursor' | 'windsurf' | 'test-client' | 'unknown';

// ==================== Agent 类型 ====================

export type AgentType = 'main' | 'sub';
export type SubAgentType = 'plan' | 'search' | 'bash' | 'workflow' | 'unknown';

// ==================== 日志条目（前端格式） ====================

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
  subAgentType?: SubAgentType;
  apiType?: ApiProviderType;
  clientType?: ClientType;
  duration: number;
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  metadata: {
    model: string;
    provider: 'openai' | 'claude' | 'unknown';
    stream: boolean;
    error?: string;
  };
  kvCache?: {
    hitRate?: number;
    cacheReadTokens?: number;
    cacheCreateTokens?: number;
    totalCachedTokens?: number;
    system?: string[];
    messages?: string[];
    tools?: string[];
  };
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
  subAgentType?: SubAgentType;
  apiType?: ApiProviderType;
  clientType?: ClientType;
  isTest?: boolean;
  _deltaFormat?: number;
  _totalMessageCount?: number;
  _conversationId?: string;
  _isCheckpoint?: boolean;
  _inPlaceReplaceDetected?: boolean;
  error?: string;
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
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
  groups?: unknown[];
}

// ==================== 日志查询 ====================

export interface LogsQuery {
  limit?: number;
  offset?: number;
  agentType?: AgentType | 'all';
  subAgentType?: string;
  startDate?: string;
  endDate?: string;
  search?: string;
}
