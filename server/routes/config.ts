/**
 * 配置导入导出路由
 *
 * GET  /api/config/export — 导出当前配置为可移植 SQL 脚本（幂等建表 + INSERT OR REPLACE 当前行）
 * POST /api/config/import — 导入配置（JSON 对象/字符串，或导出的 SQL 脚本）；校验 + 事务替换
 *
 * 配置存储契约见 openspec/specs/config-store（变更：2026-07-28-config-to-database）。
 */

import { Router } from 'express';
import * as Config from '../config.js';
import { exportConfigSql, parseImportPayload } from '../services/config-store.js';

export function createConfigRouter(): Router {
  const router = Router();

  // GET /api/config/export — 下发 SQL 脚本（浏览器作附件下载）
  router.get('/api/config/export', (_req, res) => {
    const sql = exportConfigSql();
    res.type('text/plain');
    res.setHeader('Content-Disposition', 'attachment; filename="lucent-config.sql"');
    res.send(sql);
  });

  // POST /api/config/import
  //   body: { payload: string | object } —— payload 为 JSON 对象/串，或导出的 SQL 脚本
  //   也兼容直接把 config 对象作为 body（无 payload 包装）。
  router.post('/api/config/import', (req, res) => {
    try {
      const body = req.body as unknown;
      const payload = body && typeof body === 'object' && !Array.isArray(body) && 'payload' in body
        ? (body as { payload: unknown }).payload
        : body;
      const candidate = parseImportPayload(payload); // 解析（不校验）
      Config.replaceConfig(candidate);               // 校验 + 事务写库 + 缓存；失败抛错
      res.json({ success: true });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  return router;
}
