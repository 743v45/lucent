/**
 * AgentProxy 服务器
 *
 * 整合代理服务器 + Web UI 服务
 */

import express from 'express';
import compression from 'compression';
import { createServer as createHttpServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
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
import { homedir } from 'node:os';
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ==================== 配置 ====================
const CONFIG = {
  webPort: 7049,
  proxyPort: 7048,
  logDir: join(homedir(), '.agentproxy', 'logs'),
  maxLogFileSize: 100 * 1024 * 1024, // 100MB
  heartbeatInterval: 30000, // 30秒心跳间隔
  logRetentionDays: 30, // 日志保留30天
} as const;

// ==================== 状态 ====================
let proxyEnabled = false;
let currentLogFile: string | null = null;
let logClients = new Set<WebSocket>();
let sseClients = new Set<any>(); // SSE 客户端（Express Response 对象）
let heartbeatTimer: NodeJS.Timeout | null = null;
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
  webPort: number;
  proxyPort: number;
  logFile: string | null;
  connectedClients: number;
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
  const message = JSON.stringify({ type: 'log', data: entry });

  // WebSocket 广播
  logClients.forEach(client => {
    if (client.readyState === 1) {
      client.send(message);
    }
  });

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
 * 读取并过滤日志
 */
function readLogs(query: LogsQuery = {}): { logs: LogEntry[]; total: number } {
  const {
    limit = 100,
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
      .slice(0, 5); // 只读最近5个文件

    for (const file of files) {
      const filePath = join(CONFIG.logDir, file);
      const content = readFileSync(filePath, 'utf-8');

      // 按分隔符切分：interceptor 写入格式是 JSON + '\n---\n'
      const chunks = content.split(/\n---\n?/);
      for (const chunk of chunks) {
        const line = chunk.trim();
        if (!line) continue;
        try {
          allLogs.push(JSON.parse(line));
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
      const chunks = content.split(/\n---\n?/);
      for (const chunk of chunks) {
        const line = chunk.trim();
        if (!line) continue;
        try {
          const log = JSON.parse(line) as LogEntry;
          if (log.id === id) {
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
  res.json({
    enabled: proxyEnabled,
    running: true,
    webPort: CONFIG.webPort,
    proxyPort: CONFIG.proxyPort,
    logFile: currentLogFile,
    connectedClients: logClients.size,
  } as ProxyStatus);
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
  }, 30000);

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

// API: 删除所有日志
app.delete('/api/logs', (_req, res) => {
  try {
    if (!existsSync(CONFIG.logDir)) {
      res.json({ success: true, deleted: 0 });
      return;
    }

    const files = readdirSync(CONFIG.logDir).filter(f =>
      f.endsWith('.jsonl')
    );
    let deleted = 0;

    for (const file of files) {
      try {
        const filePath = join(CONFIG.logDir, file);
        unlinkSync(filePath);
        deleted++;
      } catch (error) {
        console.error('[AgentProxy] 删除日志文件失败:', file, error);
      }
    }

    // 重置当前日志文件
    currentLogFile = getLogFilePath();

    res.json({ success: true, deleted });
  } catch (error) {
    console.error('[AgentProxy] 删除日志失败:', error);
    res.status(500).json({ error: 'Failed to delete logs' });
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
    res.json(Config.getSafeConfig());
  } catch (error) {
    console.error('[AgentProxy] 获取配置失败:', error);
    res.status(500).json({ error: 'Failed to get config' });
  }
});

// API: 获取配置（含 apiKey，用于编辑时回填）
app.get('/api/config/:name/full', (req, res) => {
  try {
    const profile = Config.getConfig().profiles.find(p => p.name === req.params.name);
    if (!profile) {
      res.status(404).json({ error: 'Profile not found' });
      return;
    }
    res.json({
      name: profile.name,
      upstreamBaseUrl: profile.upstreamBaseUrl,
      apiKey: profile.apiKey,
      proxyPort: profile.proxyPort,
    });
  } catch (error) {
    console.error('[AgentProxy] 获取配置详情失败:', error);
    res.status(500).json({ error: 'Failed to get config' });
  }
});

// API: 更新 profile
app.put('/api/config/profiles/:name', (req, res) => {
  try {
    const result = Config.updateProfile(req.params.name, req.body);
    if (!result) {
      res.status(404).json({ error: 'Profile not found' });
      return;
    }
    res.json(Config.getSafeConfig());
  } catch (error) {
    console.error('[AgentProxy] 更新配置失败:', error);
    res.status(500).json({ error: 'Failed to update config' });
  }
});

// API: 创建 profile
app.post('/api/config/profiles', (req, res) => {
  try {
    const result = Config.createProfile(req.body);
    if (!result) {
      res.status(409).json({ error: 'Profile already exists' });
      return;
    }
    res.json(Config.getSafeConfig());
  } catch (error) {
    console.error('[AgentProxy] 创建配置失败:', error);
    res.status(500).json({ error: 'Failed to create config' });
  }
});

// API: 切换激活 profile
app.post('/api/config/active', (req, res) => {
  try {
    const result = Config.setActiveProfile(req.body.name);
    if (!result) {
      res.status(404).json({ error: 'Profile not found' });
      return;
    }
    res.json(Config.getSafeConfig());
  } catch (error) {
    console.error('[AgentProxy] 切换配置失败:', error);
    res.status(500).json({ error: 'Failed to switch config' });
  }
});

// API: 重命名 profile
app.put('/api/config/profiles/:name/rename', (req, res) => {
  try {
    const result = Config.renameProfile(req.params.name, req.body.newName);
    if (!result) {
      res.status(409).json({ error: 'Rename failed' });
      return;
    }
    res.json(Config.getSafeConfig());
  } catch (error) {
    console.error('[AgentProxy] 重命名配置失败:', error);
    res.status(500).json({ error: 'Failed to rename config' });
  }
});

// API: 删除 profile
app.delete('/api/config/profiles/:name', (req, res) => {
  try {
    const result = Config.deleteProfile(req.params.name);
    if (!result) {
      res.status(400).json({ error: 'Cannot delete profile' });
      return;
    }
    res.json(Config.getSafeConfig());
  } catch (error) {
    console.error('[AgentProxy] 删除配置失败:', error);
    res.status(500).json({ error: 'Failed to delete config' });
  }
});

// API: 测试上游连接
app.post('/api/config/test', async (req, res) => {
  try {
    const { url, apiKey } = req.body;
    if (!url) {
      res.status(400).json({ error: 'URL is required' });
      return;
    }

    const startTime = Date.now();
    const testUrl = `${url.replace(/\/+$/, '')}/v1/messages`;

    const response = await fetch(testUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': apiKey || '',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      }),
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

// WebSocket 升级
const wss = new WebSocketServer({ server });

/**
 * 启动心跳机制
 */
function startHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
  }

  heartbeatTimer = setInterval(() => {
    const message = JSON.stringify({ type: 'ping', timestamp: Date.now() });
    logClients.forEach(client => {
      if (client.readyState === 1) {
        // OPEN
        try {
          client.send(message);
        } catch (error) {
          console.error('[AgentProxy] 发送心跳失败:', error);
          logClients.delete(client);
        }
      } else {
        // 移除非活动连接
        logClients.delete(client);
      }
    });
  }, CONFIG.heartbeatInterval);

  console.log('[AgentProxy] 心跳机制已启动');
}

/**
 * 停止心跳机制
 */
function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

wss.on('connection', (ws: WebSocket) => {
  logClients.add(ws);
  console.log('[AgentProxy] WebSocket 客户端连接，当前连接数:', logClients.size);

  // 发送欢迎消息
  try {
    ws.send(
      JSON.stringify({
        type: 'connected',
        timestamp: Date.now(),
        clients: logClients.size,
      })
    );
  } catch (error) {
    console.error('[AgentProxy] 发送欢迎消息失败:', error);
  }

  ws.on('close', () => {
    logClients.delete(ws);
    console.log(
      '[AgentProxy] WebSocket 客户端断开，当前连接数:',
      logClients.size
    );
  });

  ws.on('message', (data: Buffer) => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.type === 'pong') {
        // 收到 pong，连接正常
        // 可以更新该客户端的最后活跃时间
      } else if (msg.type === 'ping') {
        // 响应客户端的 ping
        ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
      }
    } catch (error) {
      console.error('[AgentProxy] WebSocket 消息解析失败:', error);
    }
  });

  ws.on('error', error => {
    console.error('[AgentProxy] WebSocket 错误:', error);
    logClients.delete(ws);
  });
});

// ==================== 启动函数 ====================
export async function startServer(): Promise<void> {
  initLogDir();

  // 加载配置
  Config.loadConfig();
  const activeConfig = Config.getActiveProfile();

  currentLogFile = getLogFilePath();

  // 清理过期日志
  cleanupOldLogs();

  // 启动代理服务器
  const proxyPort = activeConfig?.proxyPort ?? CONFIG.proxyPort;
  try {
    proxyServer = await startProxyServer({ port: proxyPort });
    console.log(`[AgentProxy] 代理服务器已启动`);
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

  // 启动心跳
  startHeartbeat();

  return new Promise<void>((resolve, reject) => {
    server.listen(CONFIG.webPort, '127.0.0.1', () => {
      console.log(`[AgentProxy] Web UI: http://127.0.0.1:${CONFIG.webPort}`);
      console.log(`[AgentProxy] 代理端口: ${CONFIG.proxyPort}`);
      console.log(`[AgentProxy] 日志文件: ${currentLogFile}`);
      console.log(`[AgentProxy] 日志目录: ${CONFIG.logDir}`);

      // 自动打开浏览器
      open(`http://127.0.0.1:${CONFIG.webPort}`).catch(err => {
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
  return {
    enabled: proxyEnabled,
    running: true,
    webPort: CONFIG.webPort,
    proxyPort: CONFIG.proxyPort,
    logFile: currentLogFile,
    connectedClients: logClients.size,
  };
}

export function shutdownServer(): void {
  console.log('[AgentProxy] 关闭服务器...');

  // 停止心跳
  stopHeartbeat();

  // 关闭代理服务器
  if (proxyServer) {
    proxyServer.stop().catch(err => {
      console.error('[AgentProxy] 关闭代理服务器失败:', err);
    });
  }

  // 关闭所有 WebSocket 连接
  logClients.forEach(client => {
    try {
      client.close();
    } catch (error) {
      console.error('[AgentProxy] 关闭 WebSocket 连接失败:', error);
    }
  });
  logClients.clear();

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
