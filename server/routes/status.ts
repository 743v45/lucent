/**
 * 状态相关 API 路由
 *
 * GET  /api/status  — 代理状态
 * POST /api/enable  — 启用代理
 * POST /api/disable — 禁用代理
 * GET  /api/health  — 健康检查
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
    });
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
