/**
 * AgentProxy 代理服务器
 *
 * 功能：
 * 1. 启动 HTTP 代理服务器
 * 2. 提供 SSE 推送服务
 * 3. 拦截并记录 API 请求
 * 4. 提供 REST API 查询接口
 */

import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { mkdirSync, existsSync, appendFileSync, readFileSync, watch } from 'node:fs';
import { join, homedir } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 配置
const CONFIG = {
  port: 7048,
  logDir: join(homedir(), '.agentproxy', 'logs'),
  maxLogFileSize: 100 * 1024 * 1024, // 100MB
};

// 状态
let server = null;
let wss = null;
let enabled = false;
let currentLogFile = null;
let logClients = new Set(); // WebSocket 客户端

/**
 * 初始化日志目录
 */
function initLogDir() {
  if (!existsSync(CONFIG.logDir)) {
    mkdirSync(CONFIG.logDir, { recursive: true });
  }
}

/**
 * 生成日志文件路径
 */
function getLogFilePath() {
  const now = new Date();
  const date = now.toISOString().split('T')[0];
  const time = now.toTimeString().split(' ')[0].replace(/:/g, '-');
  return join(CONFIG.logDir, `agentproxy_${date}_${time}.jsonl`);
}

/**
 * 写入日志条目
 */
function writeLogEntry(entry) {
  if (!enabled) return;

  try {
    const line = JSON.stringify(entry) + '\n';
    appendFileSync(currentLogFile, line);
    broadcastLogEntry(entry);
  } catch (error) {
    console.error('[AgentProxy] 写入日志失败:', error);
  }
}

/**
 * 广播日志条目给所有连接的客户端
 */
function broadcastLogEntry(entry) {
  const message = JSON.stringify({ type: 'log', data: entry });
  logClients.forEach(client => {
    if (client.readyState === 1) { // OPEN
      client.send(message);
    }
  });
}

/**
 * 解析请求，识别 Agent 类型
 */
function parseAgentType(body) {
  if (!body) return { agentType: 'unknown' };

  // 主 Agent 识别：完整的 messages 数组
  if (body.messages && Array.isArray(body.messages) && body.messages.length > 1) {
    return { agentType: 'main' };
  }

  // 辅 Agent 识别
  const singleMessage = body.messages?.[0] || {};
  const content = singleMessage.content;

  // Plan Agent
  if (typeof content === 'string' && (
    content.includes('plan') ||
    content.includes('strategy') ||
    content.includes('implement')
  )) {
    return { agentType: 'sub', subAgentType: 'plan' };
  }

  // Search Agent
  if (body.tools?.some(t => t.name?.includes('search'))) {
    return { agentType: 'sub', subAgentType: 'search' };
  }

  // Bash Agent
  if (body.tools?.some(t => t.name === 'bash')) {
    return { agentType: 'sub', subAgentType: 'bash' };
  }

  return { agentType: 'sub', subAgentType: 'unknown' };
}

/**
 * 识别 API 提供商
 */
function identifyProvider(url, headers) {
  if (url.includes('api.openai.com') || url.includes('openai')) {
    return 'openai';
  }
  if (url.includes('api.anthropic.com') || url.includes('claude')) {
    return 'claude';
  }
  return 'unknown';
}

/**
 * 处理 HTTP 请求
 */
async function handleRequest(req, res) {
  const startTime = Date.now();

  // 处理 API 请求
  if (req.url.startsWith('/api/')) {
    handleApiRequest(req, res);
    return;
  }

  // WebSocket 升级
  if (req.url === '/ws') {
    handleWebSocket(req, res);
    return;
  }

  // 代理模式：转发请求
  if (enabled) {
    await handleProxy(req, res, startTime);
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
}

/**
 * 处理 API 请求
 */
function handleApiRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');

  switch (url.pathname) {
    case '/api/status':
      res.end(JSON.stringify({
        enabled,
        running: !!server,
        port: CONFIG.port,
        logFile: currentLogFile,
      }));
      break;

    case '/api/enable':
      enabled = true;
      currentLogFile = getLogFilePath();
      res.end(JSON.stringify({ success: true, enabled }));
      break;

    case '/api/disable':
      enabled = false;
      res.end(JSON.stringify({ success: true, enabled }));
      break;

    case '/api/logs':
      const logs = readLogsSync();
      res.end(JSON.stringify({ logs }));
      break;

    default:
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Not Found' }));
  }
}

/**
 * 处理 WebSocket 连接
 */
function handleWebSocket(req, socket, head) {
  if (!wss) {
    wss = new WebSocketServer({ noServer: true });
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    logClients.add(ws);
    console.log('[AgentProxy] WebSocket 客户端连接');

    ws.on('close', () => {
      logClients.delete(ws);
      console.log('[AgentProxy] WebSocket 客户端断开');
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        if (msg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }));
        }
      } catch (error) {
        console.error('[AgentProxy] WebSocket 消息解析失败:', error);
      }
    });
  });
}

/**
 * 处理代理请求
 */
async function handleProxy(req, res, startTime) {
  // TODO: 实现实际的代理转发逻辑
  // 这里需要：
  // 1. 解析请求体
  // 2. 识别 Agent 类型
  // 3. 转发到真实 API
  // 4. 捕获响应
  // 5. 写入日志

  res.writeHead(200);
  res.end(JSON.stringify({ message: '代理模式待实现' }));
}

/**
 * 同步读取日志文件
 */
function readLogsSync() {
  // TODO: 实现日志读取逻辑
  return [];
}

/**
 * 启动代理服务器
 */
export function startProxy(port = CONFIG.port) {
  return new Promise((resolve, reject) => {
    if (server) {
      reject(new Error('代理服务器已在运行'));
      return;
    }

    initLogDir();
    currentLogFile = getLogFilePath();

    server = createServer(handleRequest);

    server.listen(port, '127.0.0.1', () => {
      console.log(`[AgentProxy] 代理服务器启动: http://127.0.0.1:${port}`);
      console.log(`[AgentProxy] 日志文件: ${currentLogFile}`);
      resolve({ port, logFile: currentLogFile });
    });

    server.on('error', (error) => {
      console.error('[AgentProxy] 服务器错误:', error);
      reject(error);
    });
  });
}

/**
 * 停止代理服务器
 */
export function stopProxy() {
  return new Promise((resolve) => {
    if (server) {
      server.close(() => {
        console.log('[AgentProxy] 代理服务器已停止');
        server = null;
        resolve();
      });
    } else {
      resolve();
    }
  });
}

/**
 * 获取服务器状态
 */
export function getProxyStatus() {
  return {
    running: !!server,
    enabled,
    port: CONFIG.port,
    logFile: currentLogFile,
  };
}

// 如果直接运行此文件
if (import.meta.url === `file://${process.argv[1]}`) {
  startProxy().catch(error => {
    console.error('[AgentProxy] 启动失败:', error);
    process.exit(1);
  });
}
