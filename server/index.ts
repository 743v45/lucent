/**
 * AgentProxy 服务器
 *
 * 整合代理服务器 + Web UI 服务
 */

import express from 'express';
import compression from 'compression';
import { createServer as createHttpServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { mkdirSync, existsSync, appendFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, homedir } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { open } from 'open';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ==================== 配置 ====================
const CONFIG = {
  webPort: 7049,
  proxyPort: 7048,
  logDir: join(homedir(), '.agentproxy', 'logs'),
  maxLogFileSize: 100 * 1024 * 1024, // 100MB
} as const;

// ==================== 状态 ====================
let proxyEnabled = false;
let currentLogFile: string | null = null;
let logClients = new Set<ws.WebSocket>();

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
    hitRate?: string;
    readBytes?: number;
    content?: string;
  };
  context?: unknown;
  error?: string;
}

interface ProxyStatus {
  enabled: boolean;
  running: boolean;
  webPort: number;
  proxyPort: number;
  logFile: string | null;
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

function writeLogEntry(entry: LogEntry): void {
  if (!proxyEnabled || !currentLogFile) return;

  try {
    const line = JSON.stringify(entry) + '\n';
    appendFileSync(currentLogFile, line);
    broadcastLogEntry(entry);
  } catch (error) {
    console.error('[AgentProxy] 写入日志失败:', error);
  }
}

function broadcastLogEntry(entry: LogEntry): void {
  const message = JSON.stringify({ type: 'log', data: entry });
  logClients.forEach(client => {
    if (client.readyState === 1) { // OPEN
      client.send(message);
    }
  });
}

function readLogs(limit = 100): LogEntry[] {
  const logs: LogEntry[] = [];

  try {
    if (!existsSync(CONFIG.logDir)) {
      return logs;
    }

    const files = readdirSync(CONFIG.logDir)
      .filter(f => f.endsWith('.jsonl'))
      .sort()
      .reverse()
      .slice(0, 5); // 只读最近5个文件

    for (const file of files) {
      const filePath = join(CONFIG.logDir, file);
      const content = readFileSync(filePath, 'utf-8');
      const lines = content.split('\n').filter(Boolean);

      for (const line of lines) {
        try {
          logs.push(JSON.parse(line));
        } catch {
          // 忽略解析失败的行
        }
      }
    }
  } catch (error) {
    console.error('[AgentProxy] 读取日志失败:', error);
  }

  return logs.slice(-limit);
}

// ==================== Agent 识别 ====================
function parseAgentType(body: unknown): { agentType: 'main' | 'sub'; subAgentType?: string } {
  if (!body || typeof body !== 'object') {
    return { agentType: 'sub' };
  }

  const b = body as Record<string, unknown>;

  // 主 Agent 识别：完整的 messages 数组
  if (Array.isArray(b.messages) && b.messages.length > 1) {
    return { agentType: 'main' };
  }

  // 辅 Agent 识别
  const firstMessage = b.messages?.[0] as Record<string, unknown> | undefined;
  const content = firstMessage?.content as string | undefined;

  if (typeof content === 'string') {
    if (content.includes('plan') || content.includes('strategy')) {
      return { agentType: 'sub', subAgentType: 'plan' };
    }
  }

  if (Array.isArray(b.tools)) {
    const hasSearch = b.tools.some((t: unknown) => {
      const tool = t as Record<string, unknown>;
      return typeof tool.name === 'string' && tool.name.includes('search');
    });
    if (hasSearch) {
      return { agentType: 'sub', subAgentType: 'search' };
    }

    const hasBash = b.tools.some((t: unknown) => {
      const tool = t as Record<string, unknown>;
      return tool.name === 'bash';
    });
    if (hasBash) {
      return { agentType: 'sub', subAgentType: 'bash' };
    }
  }

  return { agentType: 'sub', subAgentType: 'unknown' };
}

function identifyProvider(url: string): 'openai' | 'claude' | 'unknown' {
  if (url.includes('openai')) return 'openai';
  if (url.includes('anthropic') || url.includes('claude')) return 'claude';
  return 'unknown';
}

// ==================== Express 应用 ====================
const app = express();

app.use(compression());
app.use(express.json());

// 静态文件服务（生产环境）
app.use(express.static(join(__dirname, '../dist')));

// API: 状态
app.get('/api/status', (_req, res) => {
  res.json({
    enabled: proxyEnabled,
    running: true,
    webPort: CONFIG.webPort,
    proxyPort: CONFIG.proxyPort,
    logFile: currentLogFile,
  } as ProxyStatus);
});

// API: 启用代理
app.post('/api/enable', (_req, res) => {
  proxyEnabled = true;
  currentLogFile = getLogFilePath();
  res.json({ success: true, enabled: proxyEnabled });
});

// API: 禁用代理
app.post('/api/disable', (_req, res) => {
  proxyEnabled = false;
  res.json({ success: true, enabled: proxyEnabled });
});

// API: 获取日志
app.get('/api/logs', (req, res) => {
  const limit = parseInt(req.query.limit as string) || 100;
  const logs = readLogs(limit);
  res.json({ logs });
});

// API: 健康检查
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// 健康检查
// ==================== HTTP 服务器 ====================
const server = createHttpServer(app);

// WebSocket 升级
const wss = new WebSocketServer({ server });

wss.on('connection', (ws: ws.WebSocket) => {
  logClients.add(ws);
  console.log('[AgentProxy] WebSocket 客户端连接');

  ws.on('close', () => {
    logClients.delete(ws);
    console.log('[AgentProxy] WebSocket 客户端断开');
  });

  ws.on('message', (data: Buffer) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
      }
    } catch (error) {
      console.error('[AgentProxy] WebSocket 消息解析失败:', error);
    }
  });
});

// ==================== 启动函数 ====================
export async function startServer(): Promise<void> {
  initLogDir();
  currentLogFile = getLogFilePath();

  return new Promise<void>((resolve, reject) => {
    server.listen(CONFIG.webPort, '127.0.0.1', () => {
      console.log(`[AgentProxy] Web UI: http://127.0.0.1:${CONFIG.webPort}`);
      console.log(`[AgentProxy] 代理端口: ${CONFIG.proxyPort}`);
      console.log(`[AgentProxy] 日志文件: ${currentLogFile}`);

      // 自动打开浏览器
      open(`http://127.0.0.1:${CONFIG.webPort}`).catch(err => {
        console.warn('[AgentProxy] 无法自动打开浏览器:', err.message);
      });

      resolve();
    });

    server.on('error', (error) => {
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
  };
}

// ==================== 直接运行 ====================
if (import.meta.url === `file://${process.argv[1]}`) {
  startServer().catch(error => {
    console.error('[AgentProxy] 启动失败:', error);
    process.exit(1);
  });
}
