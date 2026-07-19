/**
 * 状态相关 API 路由
 *
 * GET  /api/status     — 代理状态
 * POST /api/enable     — 启用代理
 * POST /api/disable    — 禁用代理
 * POST /api/recording  — 切换日志记录模式（off / temporary / archive）
 * GET  /api/health     — 健康检查
 */

import { Router } from 'express';
import * as Config from '../config.js';

export function createStatusRouter(options: {
  proxyEnabled: { value: boolean };
  getLogFile: () => string | null;
}): Router {
  const router = Router();

  // GET /api/status
  router.get('/api/status', (_req, res) => {
    const config = Config.getConfig();

    res.json({
      enabled: options.proxyEnabled.value,
      running: true,
      host: config.host,
      webPort: config.webPort,
      proxyPort: config.proxyPort,
      logFile: options.getLogFile(),
      providers: config.providers,
      // 日志记录模式（有效值）+ 是否被 env 锁定 + 临时 TTL（分钟）
      logMode: Config.getLogMode(),
      logModeEnvLocked: Config.logModeEnvOverridden(),
      tempLogTtlMinutes: Config.getTempTtlMinutes(),
      retentionDays: Config.getRetentionDays(),
    });
  });

  // POST /api/recording — 切换日志记录模式（off/temporary/archive，持久化到 config.json）
  router.post('/api/recording', (req, res) => {
    const logMode = req.body?.logMode;
    const tempTtlMinutes = req.body?.tempTtlMinutes;
    if (logMode !== 'off' && logMode !== 'temporary' && logMode !== 'archive') {
      res.status(400).json({ error: 'logMode must be one of off|temporary|archive' });
      return;
    }
    if (tempTtlMinutes !== undefined && (!Number.isInteger(tempTtlMinutes) || tempTtlMinutes < 1)) {
      res.status(400).json({ error: 'tempTtlMinutes must be a positive integer' });
      return;
    }
    const result = Config.setLogMode(logMode, tempTtlMinutes);
    res.json({ success: true, logMode: result.logMode, envLocked: result.envLocked });
  });

  // POST /api/retention — 设置存档保留期（天，持久化到 config.json）
  router.post('/api/retention', (req, res) => {
    const days = req.body?.days;
    if (!Number.isInteger(days) || days < 1) {
      res.status(400).json({ error: 'days must be a positive integer' });
      return;
    }
    const result = Config.setRetentionDays(days);
    res.json({ success: true, retentionDays: result.retentionDays, envLocked: result.envLocked });
  });

  // POST /api/enable
  router.post('/api/enable', (_req, res) => {
    options.proxyEnabled.value = true;
    res.json({ success: true, enabled: options.proxyEnabled.value });
  });

  // POST /api/disable
  router.post('/api/disable', (_req, res) => {
    options.proxyEnabled.value = false;
    res.json({ success: true, enabled: options.proxyEnabled.value });
  });

  // GET /api/health
  router.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      memory: process.memoryUsage(),
    });
  });

  return router;
}
