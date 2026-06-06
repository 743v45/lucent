/**
 * AgentProxy 服务器
 *
 * 整合代理服务器 + Web UI 服务
 */

import express from 'express';
import compression from 'compression';
import { createServer as createHttpServer } from 'node:http';
import {
  mkdirSync,
  existsSync,
  appendFileSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import open from 'open';
import * as AgentIdentifier from './agent-identifier.js';
import * as LogManager from './log-manager.js';
import * as Config from './config.js';
import { extractCachedContent, buildContextWindowEvent, getContextSizeForModel } from './kvcache.js';
import { globalContextRebuilder, buildConversationSummary, calculateContextWindow } from './context-rebuilder.js';
import { startProxyServer } from './proxy.js';
import { setupInterceptor } from './interceptor.js';
import { extractContext, detectApiType } from './context-extractors.js';
import {
  DEFAULT_WEB_PORT,
  DEFAULT_PROXY_PORT,
  LOG_DIR,
  MAX_LOG_FILE_SIZE,
  LOG_RETENTION_DAYS,
  HEARTBEAT_INTERVAL_MS,
  DEFAULT_LOG_QUERY_LIMIT,
  MAX_LOG_FILES_TO_READ,
  LOG_SPLIT_REGEX,
  API_KEY_MASK_PREFIX,
  API_KEY_MASK_SUFFIX,
  TEST_MODELS,
  ANTHROPIC_API_VERSION,
  TEST_REQUEST_CONTENT,
  TEST_MAX_TOKENS,
  DEFAULT_SERVER_HOST,
} from './constants.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ==================== 配置 ====================
const CONFIG = {
  webPort: DEFAULT_WEB_PORT,
  proxyPort: DEFAULT_PROXY_PORT,
  logDir: LOG_DIR,
  maxLogFileSize: MAX_LOG_FILE_SIZE,
  logRetentionDays: LOG_RETENTION_DAYS,
} as const;

// ==================== 状态 ====================
let proxyEnabled = false;
let currentLogFile: string | null = null;
let sseClients = new Set<any>(); // SSE 客户端（Express Response 对象）
let proxyServer: Awaited<ReturnType<typeof startProxyServer>> | null = null;

// ==================== 类型定义 ====================
interface LogEntry {
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
  };
  agentType: 'main' | 'sub';
  subAgentType?: 'plan' | 'search' | 'bash' | 'workflow';
  apiType?: Config.ApiProviderType;
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

interface ProxyStatus {
  enabled: boolean;
  running: boolean;
  host: string;
  webPort: number;
  proxyPort: number;
  logFile: string | null;
  groups?: any[];
}

interface LogsQuery {
  limit?: number;
  offset?: number;
  agentType?: 'main' | 'sub' | 'all';
  subAgentType?: string;
  startDate?: string;
  endDate?: string;
  search?: string;
}

// ==================== Context 构建 ====================

/**
 * 从 request.body 构建 context 数据
 * 使用 context-extractors 统一提取多种 API 格式
 */
function buildContextFromRequest(log: LogEntry): void {
  const body = log.request?.body as any;
  const url = log.request?.url || '';

  if (!body || typeof body !== 'object') return;

  // 检测 API 类型
  const apiType = detectApiType(url);
  if (apiType) {
    log.apiType = apiType;
  }

  // 使用统一的 context 提取器
  const extracted = extractContext(body, url);
  if (!extracted) return;

  const { systemPrompt, messages, tools } = extracted;

  // 只有有内容才构建
  if (messages.length === 0 && !systemPrompt && !tools?.length) return;

  // 统计
  const userMsgs = messages.filter((m: any) => m.role === 'user').length;
  const assistantMsgs = messages.filter((m: any) => m.role === 'assistant').length;
  const toolMsgs = messages.filter((m: any) => m.role === 'tool' || m.role === 'function').length;

  // 构建 context messages（加上 timestamp）
  const ctxMsgs = messages.map((m: any) => ({
    role: m.role,
    content: m.content,
    timestamp: log.timestamp,
    ...(m.tool_use_id ? { tool_use_id: m.tool_use_id } : {}),
    ...(m.name ? { name: m.name } : {}),
    ...(m.id ? { id: m.id } : {}),
  }));

  log.context = {
    messages: ctxMsgs,
    summary: {
      totalMessages: ctxMsgs.length,
      userMessages: userMsgs,
      assistantMessages: assistantMsgs,
      toolMessages: toolMsgs,
      systemPromptLength: systemPrompt?.length ?? 0,
      toolsCount: tools?.length ?? 0,
      duration: 0,
    },
    ...(systemPrompt ? { systemPrompt } : {}),
    ...(tools?.length ? { tools } : {}),
  };

  // 计算上下文窗口
  const usage = (log.response?.body as any)?.usage;
  if (usage && log.metadata?.model) {
    const inputTokens = usage.input_tokens ?? usage.cache_read_input_tokens ?? 0;
    const outputTokens = usage.output_tokens ?? 0;
    const contextSize = getContextSizeForModel(log.metadata.model);
    const totalTokens = inputTokens + outputTokens;
    const usedPercentage = Math.min(100, Math.round((totalTokens / contextSize) * 100));

    log.context.contextWindow = {
      totalTokens,
      contextSize,
      usedPercentage,
      remainingPercentage: 100 - usedPercentage,
    };
  }
}


// ==================== 日志管理 ====================
function initLogDir(): void {
  if (!existsSync(CONFIG.logDir)) {
    mkdirSync(CONFIG.logDir, { recursive: true });
  }
}

function getLogFilePath(): string {
  const now = new Date();
  const date = now.toISOString().split('T')[0];
  const time = now.toTimeString().split(' ')[0].replace(/:/g, '-');
  return join(CONFIG.logDir, `agentproxy_${date}_${time}.jsonl`);
}

/**
 * 检查并轮转日志文件
 */
function checkAndRotateLogFile(): void {
  if (!currentLogFile || !existsSync(currentLogFile)) {
    return;
  }

  try {
    const stats = statSync(currentLogFile);
    if (stats.size >= CONFIG.maxLogFileSize) {
      console.log('[AgentProxy] 日志文件达到大小限制，轮转中...');
      currentLogFile = getLogFilePath();
      console.log('[AgentProxy] 新日志文件:', currentLogFile);
    }
  } catch (error) {
    console.error('[AgentProxy] 检查日志文件大小失败:', error);
  }
}

/**
 * 清理过期日志文件
 */
function cleanupOldLogs(): void {
  try {
    if (!existsSync(CONFIG.logDir)) {
      return;
    }

    const now = Date.now();
    const maxAge = CONFIG.logRetentionDays * 24 * 60 * 60 * 1000; // 转换为毫秒

    const files = readdirSync(CONFIG.logDir).filter(f =>
      f.endsWith('.jsonl')
    );

    for (const file of files) {
      const filePath = join(CONFIG.logDir, file);
      try {
        const stats = statSync(filePath);
        const age = now - stats.mtimeMs;

        if (age > maxAge) {
          unlinkSync(filePath);
          console.log('[AgentProxy] 删除过期日志:', file);
        }
      } catch (error) {
        console.error('[AgentProxy] 删除日志文件失败:', file, error);
      }
    }
  } catch (error) {
    console.error('[AgentProxy] 清理日志失败:', error);
  }
}

// writeLogEntry 函数已移至 LogManager 模块
// 使用 LogManager.writeLogEntry 代替

function broadcastLogEntry(entry: LogEntry): void {
  // SSE 广播
  sseClients.forEach((res: any) => {
    try {
      res.write(`event: log\ndata: ${JSON.stringify(entry)}\n\n`);
    } catch {
      sseClients.delete(res);
    }
  });
}

/**
 * 将拦截器写入的扁平格式归一化为前端期望的嵌套格式
 *
 * 拦截器写入: { url, method, headers, body, response, ... }
 * 前端期望:   { request: { url, method, headers, body }, response, metadata, ... }
 */
function normalizeLogEntry(raw: any): LogEntry {
  // 已经是嵌套格式（有 request 属性）则跳过
  if (raw.request && typeof raw.request === 'object') {
    return raw as LogEntry;
  }

  const body = raw.body || {};
  const provider = raw.apiType === 'openai-chat' || raw.apiType === 'openai-responses'
    ? 'openai'
    : raw.apiType === 'anthropic-messages' || raw.url?.includes('anthropic')
      ? 'claude'
      : 'unknown';

  return {
    id: raw.id,
    timestamp: raw.timestamp,
    request: {
      method: raw.method || 'GET',
      url: raw.url || '',
      headers: raw.headers || {},
      body,
    },
    response: raw.response ?? null,
    agentType: raw.agentType || (raw.mainAgent ? 'main' : 'sub'),
    subAgentType: raw.subAgentType,
    apiType: raw.apiType,
    duration: raw.duration || 0,
    metadata: {
      model: body.model || 'unknown',
      provider,
      stream: raw.isStream ?? !!body.stream,
      error: raw.error,
    },
    tokenUsage: raw.tokenUsage,
    kvCache: raw.kvCache,
    context: raw.context,
    error: raw.error,
  };
}

/**
 * 读取并过滤日志
 */
function readLogs(query: LogsQuery = {}): { logs: LogEntry[]; total: number } {
  const {
    limit = DEFAULT_LOG_QUERY_LIMIT,
    offset = 0,
    agentType = 'all',
    subAgentType,
    startDate,
    endDate,
    search,
  } = query;

  let allLogs: LogEntry[] = [];

  try {
    if (!existsSync(CONFIG.logDir)) {
      return { logs: [], total: 0 };
    }

    const files = readdirSync(CONFIG.logDir)
      .filter(f => f.endsWith('.jsonl') && !f.startsWith('export_'))
      .sort()
      .reverse()
      .slice(0, MAX_LOG_FILES_TO_READ);

    for (const file of files) {
      const filePath = join(CONFIG.logDir, file);
      const content = readFileSync(filePath, 'utf-8');

      // 按分隔符切分：interceptor 写入格式是 JSON + '\n---\n'
      const chunks = content.split(LOG_SPLIT_REGEX);
      for (const chunk of chunks) {
        const line = chunk.trim();
        if (!line) continue;
        try {
          const raw = JSON.parse(line);
          allLogs.push(normalizeLogEntry(raw));
        } catch {
          // 忽略解析失败的行
        }
      }
    }
  } catch (error) {
    console.error('[AgentProxy] 读取日志失败:', error);
    return { logs: [], total: 0 };
  }

  // 按时间戳倒序排序
  allLogs.sort((a, b) =>
    new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );

  // 过滤掉没有响应的日志（还在进行中的请求）
  allLogs = allLogs.filter(log => log.response !== null && log.response !== undefined);

  // 应用过滤器
  let filteredLogs = allLogs;

  // Agent 类型过滤
  if (agentType !== 'all') {
    filteredLogs = filteredLogs.filter(log => log.agentType === agentType);
  }

  // 子 Agent 类型过滤
  if (subAgentType) {
    filteredLogs = filteredLogs.filter(
      log => log.subAgentType === subAgentType
    );
  }

  // 日期范围过滤
  if (startDate) {
    const start = new Date(startDate).getTime();
    filteredLogs = filteredLogs.filter(
      log => new Date(log.timestamp).getTime() >= start
    );
  }

  if (endDate) {
    const end = new Date(endDate).getTime();
    filteredLogs = filteredLogs.filter(
      log => new Date(log.timestamp).getTime() <= end
    );
  }

  // 搜索过滤
  if (search) {
    const searchLower = search.toLowerCase();
    filteredLogs = filteredLogs.filter(log => {
      // 搜索 URL
      if (log.request.url.toLowerCase().includes(searchLower)) {
        return true;
      }
      // 搜索模型名称
      if (log.metadata.model.toLowerCase().includes(searchLower)) {
        return true;
      }
      // 搜索错误信息
      if (log.error?.toLowerCase().includes(searchLower)) {
        return true;
      }
      // 搜索子 Agent 类型
      if (log.subAgentType?.toLowerCase().includes(searchLower)) {
        return true;
      }
      return false;
    });
  }

  const total = filteredLogs.length;

  // 从 request.body 构建 context
  filteredLogs.forEach(log => buildContextFromRequest(log));

  // 分页
  const paginatedLogs = filteredLogs.slice(offset, offset + limit);

  return { logs: paginatedLogs, total };
}

/**
 * 获取单个日志详情
 */
function getLogById(id: string): LogEntry | null {
  try {
    if (!existsSync(CONFIG.logDir)) {
      return null;
    }

    const files = readdirSync(CONFIG.logDir).filter(f => f.endsWith('.jsonl'));

    for (const file of files) {
      const filePath = join(CONFIG.logDir, file);
      const content = readFileSync(filePath, 'utf-8');

      // 按分隔符切分
      const chunks = content.split(LOG_SPLIT_REGEX);
      for (const chunk of chunks) {
        const line = chunk.trim();
        if (!line) continue;
        try {
          const log = JSON.parse(line) as LogEntry;
          if (log.id === id) {
            buildContextFromRequest(log);
            return log;
          }
        } catch {
          // 忽略解析失败的行
        }
      }
    }
  } catch (error) {
    console.error('[AgentProxy] 获取日志详情失败:', error);
  }

  return null;
}

// ==================== Express 应用 ====================
const app = express();

app.use(compression());
app.use(express.json());

// 静态文件服务（生产环境）
app.use(express.static(join(__dirname, '../dist')));
app.use(express.static(join(__dirname, '../public')));

// API: 状态
app.get('/api/status', (_req, res) => {
  const config = Config.getConfig();
  const safeConfig = Config.getSafeConfig();

  res.json({
    enabled: proxyEnabled,
    running: true,
    host: config.host,
    webPort: config.webPort,
    proxyPort: config.proxyPort,
    logFile: currentLogFile,
    groups: safeConfig.groups,
  });
});

// API: 启用代理
app.post('/api/enable', (_req, res) => {
  proxyEnabled = true;
  if (!currentLogFile) {
    currentLogFile = getLogFilePath();
  }
  res.json({ success: true, enabled: proxyEnabled });
});

// API: 禁用代理
app.post('/api/disable', (_req, res) => {
  proxyEnabled = false;
  res.json({ success: true, enabled: proxyEnabled });
});

// API: 获取日志
app.get('/api/logs', (req, res) => {
  const query: LogsQuery = {
    limit: parseInt(req.query.limit as string) || 100,
    offset: parseInt(req.query.offset as string) || 0,
    agentType: (req.query.agentType as 'main' | 'sub' | 'all') || 'all',
    subAgentType: req.query.subAgentType as string,
    startDate: req.query.startDate as string,
    endDate: req.query.endDate as string,
    search: req.query.search as string,
  };

  const result = readLogs(query);
  res.json(result);
});

// API: SSE 日志流 —— 必须在 :id 路由之前，否则 stream 会被当成 id
// 用法：new EventSource('/api/logs/stream')
// 事件格式：event: log\ndata: {...}\n\n
app.get('/api/logs/stream', (req, res) => {
  // SSE 必须的 headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  // 发送初始连接确认
  res.write(`event: connected\ndata: ${JSON.stringify({ timestamp: Date.now() })}\n\n`);

  // 心跳：每 30 秒发一次注释行，防止连接超时
  const sseHeartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, HEARTBEAT_INTERVAL_MS);

  // 注册到 SSE 广播列表
  sseClients.add(res as any);

  // 客户端断开时清理
  req.on('close', () => {
    clearInterval(sseHeartbeat);
    sseClients.delete(res as any);
  });
});

// API: 获取日志统计（必须在 :id 前面，否则 stats 会被当成 id）
app.get('/api/logs/stats', (_req, res) => {
  try {
    const stats = LogManager.getLogStats();
    res.json(stats);
  } catch (error) {
    console.error('[AgentProxy] 获取日志统计失败:', error);
    res.status(500).json({ error: 'Failed to get log stats' });
  }
});

// API: 获取单个日志详情
app.get('/api/logs/:id', (req, res) => {
  const log = getLogById(req.params.id);
  if (log) {
    res.json({ log });
  } else {
    res.status(404).json({ error: 'Log not found' });
  }
});

// API: 获取日志文件列表
app.get('/api/log-files', (_req, res) => {
  try {
    if (!existsSync(CONFIG.logDir)) {
      res.json({ files: [] });
      return;
    }

    const files = readdirSync(CONFIG.logDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(file => {
        const filePath = join(CONFIG.logDir, file);
        try {
          const stats = statSync(filePath);
          return {
            name: file,
            size: stats.size,
            created: stats.birthtimeMs,
            modified: stats.mtimeMs,
          };
        } catch {
          return {
            name: file,
            size: 0,
            created: 0,
            modified: 0,
          };
        }
      })
      .sort((a, b) => b.modified - a.modified);

    res.json({ files });
  } catch (error) {
    console.error('[AgentProxy] 获取日志文件列表失败:', error);
    res.status(500).json({ error: 'Failed to get log files' });
  }
});

// API: 导出日志
app.post('/api/logs/export', (req, res) => {
  try {
    const { format = 'jsonl', includeMeta = false } = req.body;
    const exportPath = join(CONFIG.logDir, `export_${Date.now()}.${format}`);

    const result = LogManager.exportLogs(exportPath, {
      format,
      includeMeta,
    });

    res.json(result);
  } catch (error) {
    console.error('[AgentProxy] 导出日志失败:', error);
    res.status(500).json({ error: 'Failed to export logs' });
  }
});

// API: 导入日志
app.post('/api/logs/import', (req, res) => {
  try {
    const { filePath, merge = true, validate = true } = req.body;

    if (!filePath) {
      res.status(400).json({ error: 'File path is required' });
      return;
    }

    const result = LogManager.importLogs(filePath, { merge, validate });
    res.json(result);
  } catch (error) {
    console.error('[AgentProxy] 导入日志失败:', error);
    res.status(500).json({ error: 'Failed to import logs' });
  }
});

// API: 清空所有日志
app.delete('/api/logs', (_req, res) => {
  try {
    const result = LogManager.clearAllLogs();

    // 重置当前日志文件
    currentLogFile = getLogFilePath();

    res.json(result);
  } catch (error) {
    console.error('[AgentProxy] 清空日志失败:', error);
    res.status(500).json({ error: 'Failed to clear logs' });
  }
});

// API: 健康检查
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
  });
});

// ==================== 配置 API ====================

// API: 获取配置（脱敏）
app.get('/api/config', (_req, res) => {
  try {
    const config = Config.getConfig();
    res.json({
      proxyPort: config.proxyPort,
      webPort: config.webPort,
      groups: config.groups.map(g => ({
        apiType: g.apiType,
        activeProfileId: g.activeProfileId,
        profiles: g.profiles.map(p => ({
          id: p.id,
          name: p.name,
          upstreamBaseUrl: p.upstreamBaseUrl,
          apiKeySet: p.apiKey.length > 0,
          apiKeyPreview: p.apiKey
                            ? p.apiKey.slice(0, API_KEY_MASK_PREFIX) + '****' + p.apiKey.slice(-API_KEY_MASK_SUFFIX)
                            : '',
        })),
      })),
    });
  } catch (error) {
    console.error('[AgentProxy] 获取配置失败:', error);
    res.status(500).json({ error: 'Failed to get config' });
  }
});

// API: 获取指定 profile 完整信息（含 apiKey，用于编辑时回填）
app.get('/api/config/:apiType/:id/full', (req, res) => {
  try {
    const { apiType, id } = req.params;
    const group = Config.getGroupByApiType(apiType as Config.ApiProviderType);

    if (!group) {
      res.status(404).json({ error: 'Group not found' });
      return;
    }

    const profile = group.profiles.find(p => p.id === id);
    if (!profile) {
      res.status(404).json({ error: 'Profile not found' });
      return;
    }

    res.json({
      id: profile.id,
      name: profile.name,
      upstreamBaseUrl: profile.upstreamBaseUrl,
      apiKey: profile.apiKey,
      apiType: group.apiType,
    });
  } catch (error) {
    console.error('[AgentProxy] 获取配置详情失败:', error);
    res.status(500).json({ error: 'Failed to get config' });
  }
});

// API: 创建 profile（指定 API 类型）
app.post('/api/config/:apiType/profiles', (req, res) => {
  try {
    const { apiType } = req.params;
    const { name, upstreamBaseUrl, apiKey } = req.body;

    if (!name || !upstreamBaseUrl) {
      res.status(400).json({ error: 'name and upstreamBaseUrl are required' });
      return;
    }

    const result = Config.createProfile(
      apiType as Config.ApiProviderType,
      { name, upstreamBaseUrl, apiKey: apiKey || '' }
    );

    if (!result) {
      res.status(409).json({ error: 'Profile already exists or invalid apiType' });
      return;
    }

    const config = Config.getConfig();
    const group = config.groups.find(g => g.apiType === apiType);
    res.json({
      apiType: group?.apiType,
      activeProfileId: group?.activeProfileId,
      profiles: group?.profiles.map(p => ({
        id: p.id,
        name: p.name,
        upstreamBaseUrl: p.upstreamBaseUrl,
        apiKeySet: p.apiKey.length > 0,
        apiKeyPreview: p.apiKey
                          ? p.apiKey.slice(0, API_KEY_MASK_PREFIX) + '****' + p.apiKey.slice(-API_KEY_MASK_SUFFIX)
                          : '',
      })) || [],
    });
  } catch (error) {
    console.error('[AgentProxy] 创建配置失败:', error);
    res.status(500).json({ error: 'Failed to create config' });
  }
});

// API: 更新 profile（指定 API 类型）
app.put('/api/config/:apiType/profiles/:id', (req, res) => {
  try {
    const { apiType, id } = req.params;
    const { upstreamBaseUrl, apiKey } = req.body;

    const result = Config.updateProfile(
      apiType as Config.ApiProviderType,
      id,
      { upstreamBaseUrl, apiKey }
    );

    if (!result) {
      res.status(404).json({ error: 'Profile not found or invalid apiType' });
      return;
    }

    const config = Config.getConfig();
    const group = config.groups.find(g => g.apiType === apiType);
    res.json({
      apiType: group?.apiType,
      activeProfileId: group?.activeProfileId,
      profiles: group?.profiles.map(p => ({
        id: p.id,
        name: p.name,
        upstreamBaseUrl: p.upstreamBaseUrl,
        apiKeySet: p.apiKey.length > 0,
        apiKeyPreview: p.apiKey
                          ? p.apiKey.slice(0, API_KEY_MASK_PREFIX) + '****' + p.apiKey.slice(-API_KEY_MASK_SUFFIX)
                          : '',
      })) || [],
    });
  } catch (error) {
    console.error('[AgentProxy] 更新配置失败:', error);
    res.status(500).json({ error: 'Failed to update config' });
  }
});

// API: 设置激活 profile（指定 API 类型）
app.post('/api/config/:apiType/active', (req, res) => {
  try {
    const { apiType } = req.params;
    const { profileId } = req.body;

    if (!profileId) {
      res.status(400).json({ error: 'profileId is required' });
      return;
    }

    const result = Config.setActiveProfile(apiType as Config.ApiProviderType, profileId);

    if (!result) {
      res.status(404).json({ error: 'Profile not found or invalid apiType' });
      return;
    }

    const config = Config.getConfig();
    const group = config.groups.find(g => g.apiType === apiType);
    res.json({
      apiType: group?.apiType,
      activeProfileId: group?.activeProfileId,
      profiles: group?.profiles.map(p => ({
        id: p.id,
        name: p.name,
        upstreamBaseUrl: p.upstreamBaseUrl,
        apiKeySet: p.apiKey.length > 0,
        apiKeyPreview: p.apiKey
                          ? p.apiKey.slice(0, API_KEY_MASK_PREFIX) + '****' + p.apiKey.slice(-API_KEY_MASK_SUFFIX)
                          : '',
      })) || [],
    });
  } catch (error) {
    console.error('[AgentProxy] 切换配置失败:', error);
    res.status(500).json({ error: 'Failed to switch config' });
  }
});

// API: 重命名 profile（指定 API 类型）
app.put('/api/config/:apiType/profiles/:id/rename', (req, res) => {
  try {
    const { apiType, id } = req.params;
    const { newName } = req.body;

    if (!newName) {
      res.status(400).json({ error: 'newName is required' });
      return;
    }

    const result = Config.renameProfile(apiType as Config.ApiProviderType, id, newName);

    if (!result) {
      res.status(409).json({ error: 'Rename failed (name conflict or profile not found)' });
      return;
    }

    const config = Config.getConfig();
    const group = config.groups.find(g => g.apiType === apiType);
    res.json({
      apiType: group?.apiType,
      activeProfileId: group?.activeProfileId,
      profiles: group?.profiles.map(p => ({
        id: p.id,
        name: p.name,
        upstreamBaseUrl: p.upstreamBaseUrl,
        apiKeySet: p.apiKey.length > 0,
        apiKeyPreview: p.apiKey
                          ? p.apiKey.slice(0, API_KEY_MASK_PREFIX) + '****' + p.apiKey.slice(-API_KEY_MASK_SUFFIX)
                          : '',
      })) || [],
    });
  } catch (error) {
    console.error('[AgentProxy] 重命名配置失败:', error);
    res.status(500).json({ error: 'Failed to rename config' });
  }
});

// API: 删除 profile（指定 API 类型）
app.delete('/api/config/:apiType/profiles/:id', (req, res) => {
  try {
    const { apiType, id } = req.params;

    const result = Config.deleteProfile(apiType as Config.ApiProviderType, id);

    if (!result) {
      res.status(400).json({ error: 'Cannot delete profile (last profile or not found)' });
      return;
    }

    const config = Config.getConfig();
    const group = config.groups.find(g => g.apiType === apiType);
    res.json({
      apiType: group?.apiType,
      activeProfileId: group?.activeProfileId,
      profiles: group?.profiles.map(p => ({
        id: p.id,
        name: p.name,
        upstreamBaseUrl: p.upstreamBaseUrl,
        apiKeySet: p.apiKey.length > 0,
        apiKeyPreview: p.apiKey
                          ? p.apiKey.slice(0, API_KEY_MASK_PREFIX) + '****' + p.apiKey.slice(-API_KEY_MASK_SUFFIX)
                          : '',
      })) || [],
    });
  } catch (error) {
    console.error('[AgentProxy] 删除配置失败:', error);
    res.status(500).json({ error: 'Failed to delete config' });
  }
});

// API: 测试上游连接
app.post('/api/config/test', async (req, res) => {
  try {
    const { apiType, upstreamBaseUrl, apiKey } = req.body;

    if (!apiType || !upstreamBaseUrl) {
      res.status(400).json({ error: 'apiType and upstreamBaseUrl are required' });
      return;
    }

    const startTime = Date.now();

    let testUrl: string;
    let testBody: any;
    let headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    switch (apiType as Config.ApiProviderType) {
      case 'anthropic-messages':
        testUrl = `${upstreamBaseUrl}/v1/messages`;
        headers['anthropic-version'] = ANTHROPIC_API_VERSION;
        headers['x-api-key'] = apiKey || '';
        testBody = {
          model: TEST_MODELS['anthropic-messages'],
          max_tokens: TEST_MAX_TOKENS,
          messages: [{ role: 'user', content: TEST_REQUEST_CONTENT }],
        };
        break;

      case 'openai-chat':
        testUrl = `${upstreamBaseUrl}/v1/chat/completions`;
        headers['authorization'] = `Bearer ${apiKey || ''}`;
        testBody = {
          model: TEST_MODELS['openai-chat'],
          max_tokens: TEST_MAX_TOKENS,
          messages: [{ role: 'user', content: TEST_REQUEST_CONTENT }],
        };
        break;

      case 'openai-responses':
        testUrl = `${upstreamBaseUrl}/v1/responses`;
        headers['authorization'] = `Bearer ${apiKey || ''}`;
        testBody = {
          model: TEST_MODELS['openai-responses'],
          input: TEST_REQUEST_CONTENT,
        };
        break;

      default:
        res.status(400).json({ error: 'Invalid apiType' });
        return;
    }

    const response = await fetch(testUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(testBody),
    });

    const duration = Date.now() - startTime;

    // 200 = 连通正常; 401 = 连通正常但 key 不对; 其他 = 不通
    if (response.ok) {
      res.json({ ok: true, status: response.status, duration, message: '连接正常' });
    } else if (response.status === 401) {
      res.json({ ok: false, status: response.status, duration, message: '连接正常，但 API Key 无效' });
    } else if (response.status === 404) {
      res.json({ ok: false, status: response.status, duration, message: '路径不存在，请检查上游地址' });
    } else {
      res.json({ ok: false, status: response.status, duration, message: `错误: ${response.statusText}` });
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.json({ ok: false, duration: 0, message: `连接失败: ${msg}` });
  }
});

// ==================== HTTP 服务器 ====================
const server = createHttpServer(app);

// ==================== 启动函数 ====================
export async function startServer(): Promise<void> {
  initLogDir();

  // 加载配置
  Config.loadConfig();
  const config = Config.getConfig();

  currentLogFile = getLogFilePath();

  // 清理过期日志
  cleanupOldLogs();

  // 启动代理服务器（从配置读取端口）
  const proxyPort = config.proxyPort;
  try {
    proxyServer = await startProxyServer({ port: proxyPort });
    console.log(`[AgentProxy] 代理服务器已启动，端口: ${proxyPort}`);
  } catch (error) {
    console.error('[AgentProxy] 代理服务器启动失败:', error);
    throw error;
  }

  // 设置拦截器（记录 API 请求）
  try {
    setupInterceptor();
    console.log(`[AgentProxy] API 拦截器已启动`);
  } catch (error) {
    console.error('[AgentProxy] 拦截器启动失败:', error);
  }

  const webPort = config.webPort;
  const host = config.host || DEFAULT_SERVER_HOST;
  return new Promise<void>((resolve, reject) => {
    server.listen(webPort, host, () => {
      console.log(`[AgentProxy] Web UI: http://${host}:${webPort}`);
      console.log(`[AgentProxy] 代理端口: ${proxyPort}`);
      console.log(`[AgentProxy] 日志文件: ${currentLogFile}`);
      console.log(`[AgentProxy] 日志目录: ${CONFIG.logDir}`);

      console.log('[AgentProxy] ============================');
      console.log('[AgentProxy] 接入方式 (设置环境变量):');
      console.log(`[AgentProxy]   Anthropic:  export ANTHROPIC_BASE_URL=http://${host}:${proxyPort}`);
      console.log(`[AgentProxy]   OpenAI:     export OPENAI_BASE_URL=http://${host}:${proxyPort}`);
      console.log('[AgentProxy] ============================');

      // 自动打开浏览器
      open(`http://${host}:${webPort}`).catch(err => {
        console.warn('[AgentProxy] 无法自动打开浏览器:', err.message);
      });

      resolve();
    });

    server.on('error', error => {
      console.error('[AgentProxy] 服务器错误:', error);
      reject(error);
    });
  });
}

export function getServerStatus(): ProxyStatus {
  const config = Config.getConfig();
  return {
    enabled: proxyEnabled,
    running: true,
    host: config.host,
    webPort: config.webPort,
    proxyPort: config.proxyPort,
    logFile: currentLogFile,
  };
}

export function shutdownServer(): void {
  console.log('[AgentProxy] 关闭服务器...');

  // 关闭代理服务器
  if (proxyServer) {
    proxyServer.stop().catch(err => {
      console.error('[AgentProxy] 关闭代理服务器失败:', err);
    });
  }

  // 关闭所有 SSE 连接
  sseClients.forEach((res: any) => {
    try { res.end(); } catch {}
  });
  sseClients.clear();

  // 关闭服务器
  server.close();
}

// ==================== 直接运行 ====================
if (import.meta.url === `file://${process.argv[1]}`) {
  startServer().catch(error => {
    console.error('[AgentProxy] 启动失败:', error);
    process.exit(1);
  });

  // 优雅退出
  process.on('SIGINT', () => {
    console.log('[AgentProxy] 收到 SIGINT 信号，正在关闭...');
    shutdownServer();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    console.log('[AgentProxy] 收到 SIGTERM 信号，正在关闭...');
    shutdownServer();
    process.exit(0);
  });
}
