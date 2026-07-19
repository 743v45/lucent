/**
 * 日志相关 API 路由
 *
 * GET    /api/logs          — 查询日志
 * GET    /api/logs/stream   — SSE 推送新日志
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
import { registerSseClient, unregisterSseClient } from '../sse-bus.js';
import type { LogsQuery } from '../types.js';
import createDebug from 'debug';
const dbg = createDebug('lucent:routes:logs');

export function createLogsRouter(options: {
  resolvedConfig: { logDir: string; heartbeatIntervalMs: number };
  onEnable: () => void; // 启用后的回调（设置日志文件）
}): Router {
  const router = Router();

  // GET /api/logs/stream — SSE 推送新日志（实时接通：LogWriter 落库后经 sse-bus 广播 event:log）
  router.get('/api/logs/stream', (req, res) => {
    // 设置 SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // 发送 connected 事件 + 注册到广播集合
    res.write(`event: connected\ndata: ${JSON.stringify({ timestamp: new Date().toISOString() })}\n\n`);
    registerSseClient(res);
    dbg('SSE 客户端连接');

    // 心跳保活
    const heartbeatInterval = options.resolvedConfig.heartbeatIntervalMs || 30000;
    const heartbeat = setInterval(() => {
      res.write(`: heartbeat\n\n`);
    }, heartbeatInterval);

    // 客户端断开时清理心跳 + 注销广播
    req.on('close', () => {
      clearInterval(heartbeat);
      unregisterSseClient(res);
      dbg('SSE 客户端断开');
    });
  });

  // GET /api/logs
  router.get('/api/logs', async (req, res) => {
    try {
      const query: LogsQuery = {
        limit: parseInt(req.query.limit as string) || 100,
        offset: parseInt(req.query.offset as string) || 0,
        cursor: req.query.cursor as string | undefined,
        agentType: (req.query.agentType as LogsQuery['agentType']) || 'all',
        providerName: req.query.providerName as string | undefined,
        endpointType: req.query.endpointType as string | undefined,
        startDate: req.query.startDate as string,
        endDate: req.query.endDate as string,
        search: req.query.search as string,
        threadId: req.query.threadId as string | undefined,
      };

      const result = await LogReader.readLogs(query);
      res.json(result);
    } catch (error) {
      dbg('查询日志失败: %O', error);
      res.status(500).json({ error: 'Failed to get logs' });
    }
  });

  // GET /api/logs/stats
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
  router.get('/api/logs/:id', async (req, res) => {
    try {
      const log = await LogReader.getLogById(req.params.id);
      if (log) {
        res.json({ log });
      } else {
        res.status(404).json({ error: 'Log not found' });
      }
    } catch (error) {
      dbg('获取日志详情失败: %O', error);
      res.status(500).json({ error: 'Failed to get log' });
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
      LogReader.invalidateCache(); // 日志全清，丢弃提取结果记忆缓存
      options.onEnable(); // 重置日志文件
      res.json(result);
    } catch (error) {
      dbg('清空日志失败: %O', error);
      res.status(500).json({ error: 'Failed to clear logs' });
    }
  });

  return router;
}
