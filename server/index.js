/**
 * AgentProxy 服务器
 *
 * 整合代理服务器 + Web UI 服务
 */
import express from 'express';
import compression from 'compression';
import { createServer as createHttpServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { mkdirSync, existsSync, appendFileSync, readFileSync, readdirSync, statSync, unlinkSync, } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import open from 'open';
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
};
// ==================== 状态 ====================
let proxyEnabled = false;
let currentLogFile = null;
let logClients = new Set();
let heartbeatTimer = null;
// ==================== 日志管理 ====================
function initLogDir() {
    if (!existsSync(CONFIG.logDir)) {
        mkdirSync(CONFIG.logDir, { recursive: true });
    }
}
function getLogFilePath() {
    const now = new Date();
    const date = now.toISOString().split('T')[0];
    const time = now.toTimeString().split(' ')[0].replace(/:/g, '-');
    return join(CONFIG.logDir, `agentproxy_${date}_${time}.jsonl`);
}
/**
 * 检查并轮转日志文件
 */
function checkAndRotateLogFile() {
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
    }
    catch (error) {
        console.error('[AgentProxy] 检查日志文件大小失败:', error);
    }
}
/**
 * 清理过期日志文件
 */
function cleanupOldLogs() {
    try {
        if (!existsSync(CONFIG.logDir)) {
            return;
        }
        const now = Date.now();
        const maxAge = CONFIG.logRetentionDays * 24 * 60 * 60 * 1000; // 转换为毫秒
        const files = readdirSync(CONFIG.logDir).filter(f => f.endsWith('.jsonl'));
        for (const file of files) {
            const filePath = join(CONFIG.logDir, file);
            try {
                const stats = statSync(filePath);
                const age = now - stats.mtimeMs;
                if (age > maxAge) {
                    unlinkSync(filePath);
                    console.log('[AgentProxy] 删除过期日志:', file);
                }
            }
            catch (error) {
                console.error('[AgentProxy] 删除日志文件失败:', file, error);
            }
        }
    }
    catch (error) {
        console.error('[AgentProxy] 清理日志失败:', error);
    }
}
function writeLogEntry(entry) {
    if (!proxyEnabled || !currentLogFile)
        return;
    try {
        // 检查是否需要轮转
        checkAndRotateLogFile();
        const line = JSON.stringify(entry) + '\n';
        appendFileSync(currentLogFile, line);
        broadcastLogEntry(entry);
    }
    catch (error) {
        console.error('[AgentProxy] 写入日志失败:', error);
    }
}
function broadcastLogEntry(entry) {
    const message = JSON.stringify({ type: 'log', data: entry });
    logClients.forEach(client => {
        if (client.readyState === 1) {
            // OPEN
            client.send(message);
        }
    });
}
/**
 * 读取并过滤日志
 */
function readLogs(query = {}) {
    const { limit = 100, offset = 0, agentType = 'all', subAgentType, startDate, endDate, search, } = query;
    let allLogs = [];
    try {
        if (!existsSync(CONFIG.logDir)) {
            return { logs: [], total: 0 };
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
                    allLogs.push(JSON.parse(line));
                }
                catch {
                    // 忽略解析失败的行
                }
            }
        }
    }
    catch (error) {
        console.error('[AgentProxy] 读取日志失败:', error);
        return { logs: [], total: 0 };
    }
    // 按时间戳倒序排序
    allLogs.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    // 应用过滤器
    let filteredLogs = allLogs;
    // Agent 类型过滤
    if (agentType !== 'all') {
        filteredLogs = filteredLogs.filter(log => log.agentType === agentType);
    }
    // 子 Agent 类型过滤
    if (subAgentType) {
        filteredLogs = filteredLogs.filter(log => log.subAgentType === subAgentType);
    }
    // 日期范围过滤
    if (startDate) {
        const start = new Date(startDate).getTime();
        filteredLogs = filteredLogs.filter(log => new Date(log.timestamp).getTime() >= start);
    }
    if (endDate) {
        const end = new Date(endDate).getTime();
        filteredLogs = filteredLogs.filter(log => new Date(log.timestamp).getTime() <= end);
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
function getLogById(id) {
    try {
        if (!existsSync(CONFIG.logDir)) {
            return null;
        }
        const files = readdirSync(CONFIG.logDir).filter(f => f.endsWith('.jsonl'));
        for (const file of files) {
            const filePath = join(CONFIG.logDir, file);
            const content = readFileSync(filePath, 'utf-8');
            const lines = content.split('\n').filter(Boolean);
            for (const line of lines) {
                try {
                    const log = JSON.parse(line);
                    if (log.id === id) {
                        return log;
                    }
                }
                catch {
                    // 忽略解析失败的行
                }
            }
        }
    }
    catch (error) {
        console.error('[AgentProxy] 获取日志详情失败:', error);
    }
    return null;
}
// ==================== Agent 识别 ====================
function parseAgentType(body) {
    if (!body || typeof body !== 'object') {
        return { agentType: 'sub' };
    }
    const b = body;
    // 主 Agent 识别：完整的 messages 数组
    if (Array.isArray(b.messages) && b.messages.length > 1) {
        return { agentType: 'main' };
    }
    // 辅 Agent 识别
    const firstMessage = b.messages?.[0];
    const content = firstMessage?.content;
    if (typeof content === 'string') {
        if (content.includes('plan') || content.includes('strategy')) {
            return { agentType: 'sub', subAgentType: 'plan' };
        }
    }
    if (Array.isArray(b.tools)) {
        const hasSearch = b.tools.some((t) => {
            const tool = t;
            return typeof tool.name === 'string' && tool.name.includes('search');
        });
        if (hasSearch) {
            return { agentType: 'sub', subAgentType: 'search' };
        }
        const hasBash = b.tools.some((t) => {
            const tool = t;
            return tool.name === 'bash';
        });
        if (hasBash) {
            return { agentType: 'sub', subAgentType: 'bash' };
        }
    }
    return { agentType: 'sub', subAgentType: 'unknown' };
}
function identifyProvider(url) {
    if (url.includes('openai'))
        return 'openai';
    if (url.includes('anthropic') || url.includes('claude'))
        return 'claude';
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
        connectedClients: logClients.size,
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
    const query = {
        limit: parseInt(req.query.limit) || 100,
        offset: parseInt(req.query.offset) || 0,
        agentType: req.query.agentType || 'all',
        subAgentType: req.query.subAgentType,
        startDate: req.query.startDate,
        endDate: req.query.endDate,
        search: req.query.search,
    };
    const result = readLogs(query);
    res.json(result);
});
// API: 获取单个日志详情
app.get('/api/logs/:id', (req, res) => {
    const log = getLogById(req.params.id);
    if (log) {
        res.json({ log });
    }
    else {
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
        const files = readdirSync(CONFIG.logDir).filter(f => f.endsWith('.jsonl'));
        let deleted = 0;
        for (const file of files) {
            try {
                const filePath = join(CONFIG.logDir, file);
                unlinkSync(filePath);
                deleted++;
            }
            catch (error) {
                console.error('[AgentProxy] 删除日志文件失败:', file, error);
            }
        }
        // 重置当前日志文件
        currentLogFile = getLogFilePath();
        res.json({ success: true, deleted });
    }
    catch (error) {
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
            }
            catch {
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
    }
    catch (error) {
        console.error('[AgentProxy] 获取日志文件列表失败:', error);
        res.status(500).json({ error: 'Failed to get log files' });
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
// ==================== HTTP 服务器 ====================
const server = createHttpServer(app);
// WebSocket 升级
const wss = new WebSocketServer({ server });
/**
 * 启动心跳机制
 */
function startHeartbeat() {
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
                }
                catch (error) {
                    console.error('[AgentProxy] 发送心跳失败:', error);
                    logClients.delete(client);
                }
            }
            else {
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
function stopHeartbeat() {
    if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
    }
}
wss.on('connection', (ws) => {
    logClients.add(ws);
    console.log('[AgentProxy] WebSocket 客户端连接，当前连接数:', logClients.size);
    // 发送欢迎消息
    try {
        ws.send(JSON.stringify({
            type: 'connected',
            timestamp: Date.now(),
            clients: logClients.size,
        }));
    }
    catch (error) {
        console.error('[AgentProxy] 发送欢迎消息失败:', error);
    }
    ws.on('close', () => {
        logClients.delete(ws);
        console.log('[AgentProxy] WebSocket 客户端断开，当前连接数:', logClients.size);
    });
    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data.toString());
            if (msg.type === 'pong') {
                // 收到 pong，连接正常
                // 可以更新该客户端的最后活跃时间
            }
            else if (msg.type === 'ping') {
                // 响应客户端的 ping
                ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
            }
        }
        catch (error) {
            console.error('[AgentProxy] WebSocket 消息解析失败:', error);
        }
    });
    ws.on('error', error => {
        console.error('[AgentProxy] WebSocket 错误:', error);
        logClients.delete(ws);
    });
});
// ==================== 启动函数 ====================
export async function startServer() {
    initLogDir();
    currentLogFile = getLogFilePath();
    // 清理过期日志
    cleanupOldLogs();
    // 启动心跳
    startHeartbeat();
    return new Promise((resolve, reject) => {
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
export function getServerStatus() {
    return {
        enabled: proxyEnabled,
        running: true,
        webPort: CONFIG.webPort,
        proxyPort: CONFIG.proxyPort,
        logFile: currentLogFile,
        connectedClients: logClients.size,
    };
}
export function shutdownServer() {
    console.log('[AgentProxy] 关闭服务器...');
    // 停止心跳
    stopHeartbeat();
    // 关闭所有 WebSocket 连接
    logClients.forEach(client => {
        try {
            client.close();
        }
        catch (error) {
            console.error('[AgentProxy] 关闭 WebSocket 连接失败:', error);
        }
    });
    logClients.clear();
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
