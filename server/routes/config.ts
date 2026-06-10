/**
 * 配置管理 API 路由
 *
 * GET    /api/config                          — 获取配置（脱敏）
 * GET    /api/config/:apiType/:id/full        — 获取 profile 完整信息
 * POST   /api/config/:apiType/profiles        — 创建 profile
 * PUT    /api/config/:apiType/profiles/:id    — 更新 profile
 * POST   /api/config/:apiType/active          — 切换激活 profile
 * PUT    /api/config/:apiType/profiles/:id/rename — 重命名 profile
 * DELETE /api/config/:apiType/profiles/:id    — 删除 profile
 * POST   /api/config/test                     — 测试上游连接
 */

import { Router } from 'express';
import * as Config from '../config.js';
import { serializeGroupSafe } from '../utils.js';
import {
  ANTHROPIC_API_VERSION,
  TEST_MODELS,
  TEST_REQUEST_CONTENT,
  TEST_MAX_TOKENS,
} from '../constants.js';
import type { ApiProviderType } from '../types.js';
import createDebug from 'debug';
const dbg = createDebug('lucent:routes:config');

/**
 * 返回指定 API 类型的序列化 group 数据
 */
function respondGroup(res: any, apiType: string): void {
  const config = Config.getConfig();
  const group = config.groups.find(g => g.apiType === apiType);
  if (!group) {
    res.status(404).json({ error: 'Group not found' });
    return;
  }
  res.json(serializeGroupSafe(group));
}

export function createConfigRouter(): Router {
  const router = Router();

  // GET /api/config
  router.get('/api/config', (_req, res) => {
    try {
      const config = Config.getConfig();
      res.json({
        proxyPort: config.proxyPort,
        webPort: config.webPort,
        groups: config.groups.map(serializeGroupSafe),
      });
    } catch (error) {
      dbg('获取配置失败: %O', error);
      res.status(500).json({ error: 'Failed to get config' });
    }
  });

  // GET /api/config/:apiType/:id/full
  router.get('/api/config/:apiType/:id/full', (req, res) => {
    try {
      const { apiType, id } = req.params;
      const group = Config.getGroupByApiType(apiType as Config.ApiProviderType);
      if (!group) { res.status(404).json({ error: 'Group not found' }); return; }

      const profile = group.profiles.find(p => p.id === id);
      if (!profile) { res.status(404).json({ error: 'Profile not found' }); return; }

      res.json({
        id: profile.id,
        name: profile.name,
        upstreamBaseUrl: profile.upstreamBaseUrl,
        apiKey: profile.apiKey,
        apiType: group.apiType,
      });
    } catch (error) {
      dbg('获取配置详情失败: %O', error);
      res.status(500).json({ error: 'Failed to get config' });
    }
  });

  // POST /api/config/:apiType/profiles
  router.post('/api/config/:apiType/profiles', (req, res) => {
    try {
      const { apiType } = req.params;
      const { name, upstreamBaseUrl, apiKey } = req.body;
      if (!name || !upstreamBaseUrl) { res.status(400).json({ error: 'name and upstreamBaseUrl are required' }); return; }

      const result = Config.createProfile(apiType as Config.ApiProviderType, { name, upstreamBaseUrl, apiKey: apiKey || '' });
      if (!result) { res.status(409).json({ error: 'Profile already exists or invalid apiType' }); return; }

      respondGroup(res, apiType);
    } catch (error) {
      dbg('创建配置失败: %O', error);
      res.status(500).json({ error: 'Failed to create config' });
    }
  });

  // PUT /api/config/:apiType/profiles/:id
  router.put('/api/config/:apiType/profiles/:id', (req, res) => {
    try {
      const { apiType, id } = req.params;
      const { upstreamBaseUrl, apiKey } = req.body;

      const result = Config.updateProfile(apiType as Config.ApiProviderType, id, { upstreamBaseUrl, apiKey });
      if (!result) { res.status(404).json({ error: 'Profile not found or invalid apiType' }); return; }

      respondGroup(res, apiType);
    } catch (error) {
      dbg('更新配置失败: %O', error);
      res.status(500).json({ error: 'Failed to update config' });
    }
  });

  // POST /api/config/:apiType/active
  router.post('/api/config/:apiType/active', (req, res) => {
    try {
      const { apiType } = req.params;
      const { profileId } = req.body;
      if (!profileId) { res.status(400).json({ error: 'profileId is required' }); return; }

      const result = Config.setActiveProfile(apiType as Config.ApiProviderType, profileId);
      if (!result) { res.status(404).json({ error: 'Profile not found or invalid apiType' }); return; }

      respondGroup(res, apiType);
    } catch (error) {
      dbg('切换配置失败: %O', error);
      res.status(500).json({ error: 'Failed to switch config' });
    }
  });

  // PUT /api/config/:apiType/profiles/:id/rename
  router.put('/api/config/:apiType/profiles/:id/rename', (req, res) => {
    try {
      const { apiType, id } = req.params;
      const { newName } = req.body;
      if (!newName) { res.status(400).json({ error: 'newName is required' }); return; }

      const result = Config.renameProfile(apiType as Config.ApiProviderType, id, newName);
      if (!result) { res.status(409).json({ error: 'Rename failed (name conflict or profile not found)' }); return; }

      respondGroup(res, apiType);
    } catch (error) {
      dbg('重命名配置失败: %O', error);
      res.status(500).json({ error: 'Failed to rename config' });
    }
  });

  // DELETE /api/config/:apiType/profiles/:id
  router.delete('/api/config/:apiType/profiles/:id', (req, res) => {
    try {
      const { apiType, id } = req.params;
      const result = Config.deleteProfile(apiType as Config.ApiProviderType, id);
      if (!result) { res.status(400).json({ error: 'Cannot delete profile (last profile or not found)' }); return; }

      respondGroup(res, apiType);
    } catch (error) {
      dbg('删除配置失败: %O', error);
      res.status(500).json({ error: 'Failed to delete config' });
    }
  });

  // POST /api/config/test
  router.post('/api/config/test', async (req, res) => {
    try {
      const { apiType, upstreamBaseUrl, apiKey } = req.body;
      if (!apiType || !upstreamBaseUrl) { res.status(400).json({ error: 'apiType and upstreamBaseUrl are required' }); return; }

      const startTime = Date.now();
      const hasApiKey = apiKey && apiKey.length > 0;

      dbg('🧪 测试连接: apiType=%s, baseUrl=%s, hasApiKey=%s',
        apiType, upstreamBaseUrl, hasApiKey ? `yes(${apiKey.slice(0, 8)}...)` : 'no');

      let testUrl: string;
      let testBody: any;
      let headers: Record<string, string> = { 'Content-Type': 'application/json' };

      switch (apiType as ApiProviderType) {
        case 'anthropic-messages':
          testUrl = `${upstreamBaseUrl}/v1/messages`;
          headers['anthropic-version'] = ANTHROPIC_API_VERSION;
          headers['x-api-key'] = apiKey || '';
          testBody = { model: TEST_MODELS['anthropic-messages'], max_tokens: TEST_MAX_TOKENS, messages: [{ role: 'user', content: TEST_REQUEST_CONTENT }] };
          break;
        case 'openai-chat':
          testUrl = `${upstreamBaseUrl}/v1/chat/completions`;
          headers['authorization'] = `Bearer ${apiKey || ''}`;
          testBody = { model: TEST_MODELS['openai-chat'], max_tokens: TEST_MAX_TOKENS, messages: [{ role: 'user', content: TEST_REQUEST_CONTENT }] };
          break;
        case 'openai-responses':
          testUrl = `${upstreamBaseUrl}/v1/responses`;
          headers['authorization'] = `Bearer ${apiKey || ''}`;
          testBody = { model: TEST_MODELS['openai-responses'], input: TEST_REQUEST_CONTENT };
          break;
        default:
          res.status(400).json({ error: 'Invalid apiType' });
          return;
      }

      // Debug: 显示发送的请求
      dbg('📤 测试请求: url=%s', testUrl);
      dbg('📤 测试请求头: x-api-key=%s, authorization=%s',
        headers['x-api-key'] ? (headers['x-api-key'].slice(0, 8) + '...') : '(none)',
        headers['authorization'] ? (headers['authorization'].slice(0, 20) + '...') : '(none)');

      const response = await fetch(testUrl, { method: 'POST', headers, body: JSON.stringify(testBody) });
      const duration = Date.now() - startTime;

      dbg('📥 测试响应: status=%d, ok=%s, duration=%dms', response.status, response.ok, duration);

      if (response.ok) {
        dbg('✅ 测试成功: 连接正常');
        res.json({ ok: true, status: response.status, duration, message: '连接正常' });
      } else if (response.status === 401) {
        dbg('⚠️ 测试失败: API Key 无效');
        res.json({ ok: false, status: response.status, duration, message: '连接正常，但 API Key 无效' });
      } else if (response.status === 404) {
        dbg('⚠️ 测试失败: 路径不存在');
        res.json({ ok: false, status: response.status, duration, message: '路径不存在，请检查上游地址' });
      } else {
        dbg('⚠️ 测试失败: status=%d %s', response.status, response.statusText);
        res.json({ ok: false, status: response.status, duration, message: `错误: ${response.statusText}` });
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      dbg('❌ 测试失败: %s', msg);
      res.json({ ok: false, duration: 0, message: `连接失败: ${msg}` });
    }
  });

  return router;
}
