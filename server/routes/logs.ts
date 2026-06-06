/**
 * 日志相关 API 路由
 *
 * GET    /api/logs          — 查询日志
 * GET    /api/logs/stream   — SSE 日志流
 * GET    /api/logs/stats    — 日志统计
 * GET    /api/logs/:id      — 单条日志详情
 * GET    /api/log-files     — 日志文件列表
 * POST   /api/logs/export   — 导出日志
 * POST   /api/logs/import   — 导入日志
 * DELETE /api/logs          — 清空所有日志
 */

import { Router } from 'express';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as LogReader from '../services/log-reader.js';
import * as LogManager from '../log-manager.js';
import * as SseBroadcaster from '../services/sse-broadcaster.js';
import type { LogsQuery } from '../types.js';
import createDebug from 'debug';
const dbg = createDebug('agentproxy:routes:logs');

export function createLogsRouter(options: {
  resolvedConfig: { logDir: string; heartbeatIntervalMs: number };
  onEnable: () => void; // 启用后的回调（设置日志文件）
}): Router {
  const router = Router();

  // GET /api/logs
  router.get('/api/logs', (req, res) => {
    const query: LogsQuery = {
      limit: parseInt(req.query.limit as string) || 100,
      offset: parseInt(req.query.offset as string) || 0,
      agentType: (req.query.agentType as LogsQuery['agentType']) || 'all',
      subAgentType: req.query.subAgentType as string,
      startDate: req.query.startDate as string,
      endDate: req.query.endDate as string,
      search: req.query.search as string,
    };

    const result = LogReader.readLogs(query);
    res.json(result);
  });

  // GET /api/logs/stream（必须在 :id 路由之前）
  router.get('/api/logs/stream', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    res.write(`event: connected\ndata: ${JSON.stringify({ timestamp: Date.now() })}\n\n`);

    // 心跳写入失败时主动关闭连接（浏览器刷新时 req.on('close') 可能延迟触发）
    const sseHeartbeat = setInterval(() => {
      try {
        const ok = res.write(': heartbeat\n\n');
        if (!ok) {
          // 写入缓冲区满或连接已断开，主动清理
          dbg('SSE 心跳写入失败，主动关闭连接');
          clearInterval(sseHeartbeat);
          SseBroadcaster.removeClient(res);
          res.end();
        }
      } catch (err) {
        dbg('SSE 心跳写入异常: %O', err);
        clearInterval(sseHeartbeat);
        SseBroadcaster.removeClient(res);
        try { res.end(); } catch {}
      }
    }, options.resolvedConfig.heartbeatIntervalMs);

    SseBroadcaster.addClient(res);

    // 同时监听 req 和 res 的 close 事件，确保及时清理
    const cleanup = () => {
      clearInterval(sseHeartbeat);
      SseBroadcaster.removeClient(res);
    };
    req.on('close', cleanup);
    res.on('close', cleanup);
    res.on('finish', cleanup); // 响应完成时也清理
  });

  // GET /api/logs/stats（必须在 :id 前面）
  router.get('/api/logs/stats', (_req, res) => {
    try {
      const stats = LogManager.getLogStats();
      res.json(stats);
    } catch (error) {
      dbg('获取日志统计失败: %O', error);
      res.status(500).json({ error: 'Failed to get log stats' });
    }
  });

  // GET /api/logs/:id
  router.get('/api/logs/:id', (req, res) => {
    const log = LogReader.getLogById(req.params.id);
    if (log) {
      res.json({ log });
    } else {
      res.status(404).json({ error: 'Log not found' });
    }
  });

  // GET /api/log-files
  router.get('/api/log-files', (_req, res) => {
    try {
      const logDir = options.resolvedConfig.logDir;
      if (!existsSync(logDir)) {
        res.json({ files: [] });
        return;
      }

      const files = readdirSync(logDir)
        .filter(f => f.endsWith('.jsonl'))
        .map(file => {
          const filePath = join(logDir, file);
          try {
            const stats = statSync(filePath);
            return { name: file, size: stats.size, created: stats.birthtimeMs, modified: stats.mtimeMs };
          } catch {
            return { name: file, size: 0, created: 0, modified: 0 };
          }
        })
        .sort((a, b) => b.modified - a.modified);

      res.json({ files });
    } catch (error) {
      dbg('获取日志文件列表失败: %O', error);
      res.status(500).json({ error: 'Failed to get log files' });
    }
  });

  // POST /api/logs/export
  router.post('/api/logs/export', (req, res) => {
    try {
      const { format = 'jsonl', includeMeta = false } = req.body;
      const exportPath = join(options.resolvedConfig.logDir, `export_${Date.now()}.${format}`);
      const result = LogManager.exportLogs(exportPath, { format, includeMeta });
      res.json(result);
    } catch (error) {
      dbg('导出日志失败: %O', error);
      res.status(500).json({ error: 'Failed to export logs' });
    }
  });

  // POST /api/logs/import
  router.post('/api/logs/import', (req, res) => {
    try {
      const { filePath, merge = true, validate = true } = req.body;
      if (!filePath) {
        res.status(400).json({ error: 'File path is required' });
        return;
      }
      const result = LogManager.importLogs(filePath, { merge, validate });
      res.json(result);
    } catch (error) {
      dbg('导入日志失败: %O', error);
      res.status(500).json({ error: 'Failed to import logs' });
    }
  });

  // DELETE /api/logs
  router.delete('/api/logs', (_req, res) => {
    try {
      const result = LogManager.clearAllLogs();
      options.onEnable(); // 重置日志文件
      res.json(result);
    } catch (error) {
      dbg('清空日志失败: %O', error);
      res.status(500).json({ error: 'Failed to clear logs' });
    }
  });

  return router;
}
