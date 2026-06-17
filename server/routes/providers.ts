/**
 * 供应商管理 API 路由
 *
 * GET    /api/providers                 — 列出 providers
 * GET    /api/providers/:name/full      — 取单个 provider 完整信息
 * POST   /api/providers                 — 新增 provider
 * PUT    /api/providers/:name           — 更新 provider（name 不可改，改名走 rename）
 * DELETE /api/providers/:name           — 删除 provider
 * POST   /api/providers/:name/rename    — 重命名 provider
 * POST   /api/providers/:name/test      — 按 endpointType 测试连接
 */

import { Router } from 'express';
import {
  getConfig,
  findProviderByName,
  createProvider,
  updateProvider,
  renameProvider,
  deleteProvider,
} from '../config.js';
import {
  ANTHROPIC_API_VERSION,
  TEST_MODELS,
  TEST_REQUEST_CONTENT,
  TEST_MAX_TOKENS,
} from '../constants.js';
import { isEndpointType, PRESET_NAMES, type EndpointType, type Provider } from '../types.js';
import createDebug from 'debug';
const dbg = createDebug('lucent:routes:providers');

/**
 * 将 body.endpoints 规范化为 Record<EndpointType, string | null>
 * 缺失或非字符串的键统一置为 null。
 */
function normalizeEndpoints(input: unknown): Provider['endpoints'] {
  const src = (input && typeof input === 'object') ? (input as Record<string, unknown>) : {};
  const pick = (k: EndpointType): string | null => {
    const v = src[k];
    return typeof v === 'string' && v.length > 0 ? v : null;
  };
  return {
    'openai-chat': pick('openai-chat'),
    'openai-responses': pick('openai-responses'),
    'anthropic-messages': pick('anthropic-messages'),
  };
}

/**
 * 把 worker-1 CRUD 工具函数抛出的 Error 翻译为 HTTP 错误响应
 */
function mapErrorToStatus(msg: string): number {
  if (/already exists/i.test(msg)) return 409;
  if (/not found/i.test(msg)) return 404;
  if (/Invalid|Cannot|must/i.test(msg)) return 400;
  return 500;
}

export function createProvidersRouter(): Router {
  const router = Router();

  // GET /api/providers
  router.get('/api/providers', (_req, res) => {
    try {
      const config = getConfig();
      res.json({ providers: config.providers });
    } catch (error) {
      dbg('列出 providers 失败: %O', error);
      res.status(500).json({ error: 'Failed to list providers' });
    }
  });

  // GET /api/providers/:name/full
  router.get('/api/providers/:name/full', (req, res) => {
    try {
      const { name } = req.params;
      const provider = findProviderByName(getConfig(), name);
      if (!provider) { res.status(404).json({ error: 'Provider not found' }); return; }
      res.json(provider);
    } catch (error) {
      dbg('获取 provider 详情失败: %O', error);
      res.status(500).json({ error: 'Failed to get provider' });
    }
  });

  // POST /api/providers
  router.post('/api/providers', (req, res) => {
    try {
      const { name, endpoints, presetName } = req.body ?? {};
      if (typeof name !== 'string' || !name) {
        res.status(400).json({ error: 'name is required' }); return;
      }
      const created = createProvider({
        name,
        endpoints: normalizeEndpoints(endpoints),
        ...(presetName ? { presetName } : {}),
      });
      res.status(201).json(created);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      dbg('创建 provider 失败: %s', msg);
      res.status(mapErrorToStatus(msg)).json({ error: msg });
    }
  });

  // PUT /api/providers/:name
  router.put('/api/providers/:name', (req, res) => {
    try {
      const { name } = req.params;
      const { endpoints } = req.body ?? {};

      const provider = findProviderByName(getConfig(), name);
      if (!provider) { res.status(404).json({ error: 'Provider not found' }); return; }

      const patch: { endpoints?: Provider['endpoints'] } = {};
      if (endpoints !== undefined) patch.endpoints = normalizeEndpoints(endpoints);

      const updated = updateProvider(provider.id, patch);
      res.json(updated);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      dbg('更新 provider 失败: %s', msg);
      res.status(mapErrorToStatus(msg)).json({ error: msg });
    }
  });

  // DELETE /api/providers/:name
  router.delete('/api/providers/:name', (req, res) => {
    try {
      const { name } = req.params;
      const provider = findProviderByName(getConfig(), name);
      if (!provider) { res.status(404).json({ error: 'Provider not found' }); return; }
      deleteProvider(provider.id);
      res.json({ success: true });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      dbg('删除 provider 失败: %s', msg);
      res.status(mapErrorToStatus(msg)).json({ error: msg });
    }
  });

  // POST /api/providers/:name/rename
  router.post('/api/providers/:name/rename', (req, res) => {
    try {
      const { name } = req.params;
      const { newName } = req.body ?? {};
      if (typeof newName !== 'string' || !newName) {
        res.status(400).json({ error: 'newName is required' }); return;
      }
      if (PRESET_NAMES.has(newName)) {
        res.status(400).json({ error: 'Cannot rename to a reserved preset name' }); return;
      }
      const provider = findProviderByName(getConfig(), name);
      if (!provider) { res.status(404).json({ error: 'Provider not found' }); return; }
      const renamed = renameProvider(provider.id, newName);
      res.json(renamed);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      dbg('重命名 provider 失败: %s', msg);
      res.status(mapErrorToStatus(msg)).json({ error: msg });
    }
  });

  // POST /api/providers/:name/test
  router.post('/api/providers/:name/test', async (req, res) => {
    try {
      const { name } = req.params;
      const { endpointType } = req.body ?? {};
      if (typeof endpointType !== 'string' || !isEndpointType(endpointType)) {
        res.status(400).json({
          error: 'endpointType 不合法，必须为 anthropic-messages / openai-chat / openai-responses',
        });
        return;
      }

      const provider = findProviderByName(getConfig(), name);
      if (!provider) { res.status(404).json({ error: 'Provider not found' }); return; }

      const rawBaseUrl = provider.endpoints[endpointType];
      if (!rawBaseUrl) {
        res.status(400).json({
          error: `Provider "${name}" 未配置 ${endpointType} 协议的端点（endpoints["${endpointType}"] = null）`,
        });
        return;
      }

      // 归一化 baseUrl：去除尾部斜杠，避免用户填 `https://x/` 时拼接出 `//v1/messages`
      const baseUrl = rawBaseUrl.replace(/\/+$/, '');

      const startTime = Date.now();
      dbg('🧪 测试连接: provider=%s, endpointType=%s, baseUrl=%s',
        name, endpointType, baseUrl);

      let testUrl: string;
      let testBody: unknown;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };

      // baseUrl 已含版本路径（与 presets 一致：如 https://api.anthropic.com/v1），
      // 此处只补协议路径，不重复加 /v1。与 proxy 主转发（proxy.ts:211 strip 下游 /v1 后拼 baseUrl）同源。
      switch (endpointType) {
        case 'anthropic-messages':
          testUrl = `${baseUrl}/messages`;
          headers['anthropic-version'] = ANTHROPIC_API_VERSION;
          testBody = {
            model: TEST_MODELS['anthropic-messages'],
            max_tokens: TEST_MAX_TOKENS,
            messages: [{ role: 'user', content: TEST_REQUEST_CONTENT }],
          };
          break;
        case 'openai-chat':
          testUrl = `${baseUrl}/chat/completions`;
          testBody = {
            model: TEST_MODELS['openai-chat'],
            max_tokens: TEST_MAX_TOKENS,
            messages: [{ role: 'user', content: TEST_REQUEST_CONTENT }],
          };
          break;
        case 'openai-responses':
          testUrl = `${baseUrl}/responses`;
          testBody = {
            model: TEST_MODELS['openai-responses'],
            input: TEST_REQUEST_CONTENT,
          };
          break;
      }

      dbg('📤 测试请求: url=%s', testUrl);
      const response = await fetch(testUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(testBody),
        signal: AbortSignal.timeout(10000),
      });
      const duration = Date.now() - startTime;
      dbg('📥 测试响应: status=%d, ok=%s, duration=%dms', response.status, response.ok, duration);

      if (response.status < 500) {
        // 2xx-4xx：端点可达（没有 apiKey，4xx 是合理的）
        res.json({ ok: true, status: response.status, duration, message: '端点可达' });
      } else {
        res.json({ ok: false, status: response.status, duration, message: `服务端错误: ${response.status}` });
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      dbg('❌ 测试失败: %s', msg);
      // AbortSignal.timeout 抛 TimeoutError（name 含 'Timeout'）或 DOMException(name='TimeoutError')，
      // 翻译成对用户友好的中文提示
      const isTimeout =
        (error instanceof Error && /timeout/i.test(error.name)) ||
        /timeout|abort/i.test(msg);
      res.json({
        ok: false,
        duration: 0,
        message: isTimeout ? '连接超时' : `连接失败: ${msg}`,
      });
    }
  });

  return router;
}
