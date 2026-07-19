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
import { basename, join, resolve, sep } from 'node:path';
import * as LogReader from '../services/log-reader.js';
import * as LogManager from '../log-manager.js';
import { registerSseClient, writeSse, destroySseClient, getSseClientCount, MAX_SSE_CLIENTS } from '../sse-bus.js';
import type { LogsQuery } from '../types.js';
import createDebug from 'debug';
const dbg = createDebug('lucent:routes:logs');

/** 校验 target（已 resolve）落在 logDir（已 resolve）内（含等于 logDir 本身），防路径穿越 */
function isInsideDir(target: string, logDir: string): boolean {
  return target === logDir || target.startsWith(logDir + sep);
}

export function createLogsRouter(options: {
  resolvedConfig: { logDir: string; heartbeatIntervalMs: number };
  onEnable: () => void; // 启用后的回调（设置日志文件）
}): Router {
  const router = Router();

  // GET /api/logs/stream — SSE 推送新日志（实时接通：LogWriter 落库后经 sse-bus 广播 event:log）
  router.get('/api/logs/stream', (req, res) => {
    // 连接数上限：防慢客户端堆积 + DoS（超限回 503）
    if (getSseClientCount() >= MAX_SSE_CLIENTS) {
      dbg('SSE 连接拒绝（超上限 %d）', MAX_SSE_CLIENTS);
      res.status(503).json({ error: 'Too many SSE clients' });
      return;
    }

    // 设置 SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // 发送 connected 事件 + 注册到广播集合
    // 经 writeSse：坏连接 write 抛错被捕获，不冒泡为 uncaughtException（否则触发整进程重启）
    if (!writeSse(res, `event: connected\ndata: ${JSON.stringify({ timestamp: new Date().toISOString() })}\n\n`)) {
      destroySseClient(res);
      return;
    }
    registerSseClient(res);
    dbg('SSE 客户端连接 (total=%d)', getSseClientCount());

    // 心跳保活：同样经 writeSse；写失败即清理（清心跳 + 注销 + destroy）
    const heartbeatInterval = options.resolvedConfig.heartbeatIntervalMs || 30000;
    const heartbeat = setInterval(() => {
      if (!writeSse(res, `: heartbeat\n\n`)) {
        destroySseClient(res, heartbeat);
      }
    }, heartbeatInterval);

    // 统一清理：连接异常 / 客户端断开都走 destroySseClient（幂等，三处复用）
    res.on('error', () => destroySseClient(res, heartbeat));
    req.on('close', () => {
      destroySseClient(res, heartbeat);
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
      const { includeMeta = false } = req.body ?? {};
      const format = req.body?.format ?? 'jsonl';
      // format 白名单：仅允许 jsonl / markdown，杜绝拼接注入（如 'jsonl/../../../foo'）
      if (format !== 'jsonl' && format !== 'markdown') {
        res.status(400).json({ error: 'Invalid format, must be jsonl or markdown' });
        return;
      }
      const logDir = resolve(options.resolvedConfig.logDir);
      // basename 净化：剥离任何路径分隔符（防御层，配合白名单）
      const safeName = basename(`export_${Date.now()}.${format}`);
      const exportPath = resolve(logDir, safeName);
      // 校验输出路径落在 logDir 内（防御层，防穿越）
      if (!isInsideDir(exportPath, logDir)) {
        res.status(400).json({ error: 'Invalid export path' });
        return;
      }
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
      const { filePath, merge = true, validate = true } = req.body ?? {};
      if (!filePath || typeof filePath !== 'string') {
        res.status(400).json({ error: 'File path is required' });
        return;
      }
      const logDir = resolve(options.resolvedConfig.logDir);
      const resolvedPath = resolve(filePath);
      // 限 logDir 内：杜绝读取任意文件（如 /etc/passwd、../../secret）
      if (!isInsideDir(resolvedPath, logDir)) {
        res.status(400).json({ error: 'Import path must be inside logDir' });
        return;
      }
      const result = LogManager.importLogs(resolvedPath, { merge, validate });
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
