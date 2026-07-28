/**
 * 路由挂载入口
 *
 * 将所有路由模块挂载到 Express app 上
 */

import type { Express } from 'express';
import { createStatusRouter } from './status.js';
import { createLogsRouter } from './logs.js';
import { createProvidersRouter } from './providers.js';
import { createBodyRewritesRouter } from './body-rewrites.js';
import { createConfigRouter } from './config.js';

export interface RouteOptions {
  proxyEnabled: { value: boolean };
  getLogFile: () => string | null;
  resolvedConfig: {
    logDir: string;
    heartbeatIntervalMs: number;
  };
  onLogsEnable: () => void;
}

/**
 * 挂载所有 API 路由到 Express app
 */
export function mountRoutes(app: Express, options: RouteOptions): void {
  app.use(createStatusRouter({
    proxyEnabled: options.proxyEnabled,
    getLogFile: options.getLogFile,
  }));

  app.use(createLogsRouter({
    resolvedConfig: options.resolvedConfig,
    onEnable: options.onLogsEnable,
  }));

  app.use(createProvidersRouter());
  app.use(createBodyRewritesRouter());
  app.use(createConfigRouter());
}
