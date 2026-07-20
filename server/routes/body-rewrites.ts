/**
 * Body 重写规则管理 API 路由
 *
 * GET    /api/body-rewrites        — 列出全部规则
 * POST   /api/body-rewrites        — 新增一条规则（id 自动生成）
 * PUT    /api/body-rewrites/:id    — 更新一条规则（id 不可改）
 * DELETE /api/body-rewrites/:id    — 删除一条规则
 *
 * 生效性：CRUD 内部走 saveConfig()，更新内存缓存 + 写磁盘；
 * proxy 每请求读 config.bodyRewrites，保存即对后续请求生效，无需 reload。
 */

import { Router } from 'express';
import {
  getBodyRewrites,
  addBodyRewrite,
  updateBodyRewrite,
  deleteBodyRewrite,
} from '../config.js';
import type { BodyRewriteRule } from '../types.js';
import { httpStatusFromError } from './errors.js';
import createDebug from 'debug';
const dbg = createDebug('lucent:routes:body-rewrites');

/**
 * 从 req.body 提取白名单字段（忽略 id 与未知键），并按类型归一化
 */
function pickRuleFields(body: unknown): Partial<Omit<BodyRewriteRule, 'id'>> {
  const src = (body && typeof body === 'object') ? (body as Record<string, unknown>) : {};
  const out: Partial<Omit<BodyRewriteRule, 'id'>> = {};
  if (typeof src.name === 'string') out.name = src.name;
  if (typeof src.enabled === 'boolean') out.enabled = src.enabled;
  if (typeof src.fieldPath === 'string') out.fieldPath = src.fieldPath;
  if (typeof src.pattern === 'string') out.pattern = src.pattern;
  if (typeof src.flags === 'string') out.flags = src.flags;
  if (typeof src.replacement === 'string') out.replacement = src.replacement;
  return out;
}

export function createBodyRewritesRouter(): Router {
  const router = Router();

  // GET /api/body-rewrites
  router.get('/api/body-rewrites', (_req, res) => {
    try {
      res.json({ bodyRewrites: getBodyRewrites() });
    } catch (error) {
      dbg('列出 body 重写规则失败: %O', error);
      res.status(500).json({ error: 'Failed to list body rewrite rules' });
    }
  });

  // POST /api/body-rewrites
  router.post('/api/body-rewrites', (req, res) => {
    try {
      const fields = pickRuleFields(req.body);
      const fieldPath = fields.fieldPath;
      if (typeof fieldPath !== 'string' || fieldPath.length === 0) {
        res.status(400).json({ error: 'fieldPath is required' }); return;
      }
      const pattern = fields.pattern;
      if (typeof pattern !== 'string' || pattern.length === 0) {
        res.status(400).json({ error: 'pattern is required' }); return;
      }
      const replacement = fields.replacement;
      if (typeof replacement !== 'string') {
        res.status(400).json({ error: 'replacement is required' }); return;
      }
      const created = addBodyRewrite({
        fieldPath,
        pattern,
        replacement,
        ...(fields.name !== undefined ? { name: fields.name } : {}),
        ...(fields.enabled !== undefined ? { enabled: fields.enabled } : {}),
        ...(fields.flags !== undefined ? { flags: fields.flags } : {}),
      });
      res.status(201).json(created);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      dbg('创建 body 重写规则失败: %s', msg);
      res.status(httpStatusFromError(error)).json({ error: msg });
    }
  });

  // PUT /api/body-rewrites/:id
  router.put('/api/body-rewrites/:id', (req, res) => {
    try {
      const { id } = req.params;
      const patch = pickRuleFields(req.body);
      const updated = updateBodyRewrite(id, patch);
      res.json(updated);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      dbg('更新 body 重写规则失败: %s', msg);
      res.status(httpStatusFromError(error)).json({ error: msg });
    }
  });

  // DELETE /api/body-rewrites/:id
  router.delete('/api/body-rewrites/:id', (req, res) => {
    try {
      deleteBodyRewrite(req.params.id);
      res.json({ success: true });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      dbg('删除 body 重写规则失败: %s', msg);
      res.status(httpStatusFromError(error)).json({ error: msg });
    }
  });

  return router;
}
