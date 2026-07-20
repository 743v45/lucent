/**
 * 共享 httpStatusFromError util + providers/body-rewrites 路由状态码一致性测试（#14）
 *
 * 验证：
 * 1. httpStatusFromError 单元：err.code 优先 + message 关键词正则兜底 + 默认 500
 *    —— 含 'must'/'invalid' 但携带系统 code（EACCES/ENOSPC 等）的错误 → 500，
 *      不被正则误判 400（#14 核心修复）。
 * 2. providers / body-rewrites 两路由共用同一 util → 同类错误状态码一致：
 *    通过 mock config.ts 让 CRUD 抛受控错误，端到端断言路由实际返回的状态码。
 *
 * config.ts 由并发 agent 改动，此处整体 vi.mock 替换，互不干扰。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import { httpStatusFromError } from '../server/routes/errors.js';
import { createProvidersRouter } from '../server/routes/providers.js';
import { createBodyRewritesRouter } from '../server/routes/body-rewrites.js';

// mock config.ts：providers 与 body-rewrites 路由均从 ../config.js 取 CRUD，
// 此处提供两者并集，按测试需要让特定函数抛受控错误。
const { createProviderMock, updateBodyRewriteMock } = vi.hoisted(() => ({
  createProviderMock: vi.fn(),
  updateBodyRewriteMock: vi.fn(),
}));
vi.mock('../server/config.js', () => ({
  getConfig: () => ({ providers: [] }),
  findProviderByName: () => null,
  findProviderById: () => null,
  createProvider: createProviderMock,
  updateProvider: vi.fn(),
  renameProvider: vi.fn(),
  deleteProvider: vi.fn(),
  getBodyRewrites: () => [],
  addBodyRewrite: vi.fn(),
  updateBodyRewrite: updateBodyRewriteMock,
  deleteBodyRewrite: vi.fn(),
}));

let server: ReturnType<express.Express['listen']> | undefined;

beforeEach(() => {
  createProviderMock.mockReset();
  updateBodyRewriteMock.mockReset();
});

afterEach(async () => {
  if (server) {
    await new Promise<void>(r => server!.close(() => r(undefined)));
    server = undefined;
  }
});

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(createProvidersRouter());
  app.use(createBodyRewritesRouter());
  return app;
}

function listen(app: express.Express): Promise<string> {
  return new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', () => {
      const addr = server!.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

// ==================== httpStatusFromError 单元 ====================

describe('httpStatusFromError — code 优先 + message 正则兜底', () => {
  it('EINVALID → 400', () => {
    expect(httpStatusFromError(Object.assign(new Error('bad'), { code: 'EINVALID' }))).toBe(400);
  });
  it('ENOTFOUND → 404', () => {
    expect(httpStatusFromError(Object.assign(new Error('missing'), { code: 'ENOTFOUND' }))).toBe(404);
  });
  it('ECONFLICT → 409', () => {
    expect(httpStatusFromError(Object.assign(new Error('dup'), { code: 'ECONFLICT' }))).toBe(409);
  });

  it('未知 code（系统错误 EACCES）→ 500，即便 message 含 "must"（#14 核心：不被正则误判 400）', () => {
    const err = Object.assign(new Error('EACCES: config must be writable'), { code: 'EACCES' });
    expect(httpStatusFromError(err)).toBe(500);
  });
  it('未知 code（ENOSPC）message 含 "invalid" → 500', () => {
    const err = Object.assign(new Error('ENOSPC: invalid disk'), { code: 'ENOSPC' });
    expect(httpStatusFromError(err)).toBe(500);
  });

  it('无 code + "already exists" → 409', () => {
    expect(httpStatusFromError(new Error('Provider name already exists: foo'))).toBe(409);
  });
  it('无 code + "Duplicate" → 409', () => {
    expect(httpStatusFromError(new Error('Duplicate provider name: foo'))).toBe(409);
  });
  it('无 code + "not found" → 404', () => {
    expect(httpStatusFromError(new Error('Body rewrite rule not found: x'))).toBe(404);
  });
  it('无 code + "Invalid" → 400', () => {
    expect(httpStatusFromError(new Error('Invalid provider name'))).toBe(400);
  });
  it('无 code + "Cannot" → 400', () => {
    expect(httpStatusFromError(new Error('Cannot delete the last provider'))).toBe(400);
  });
  it('无 code + "must" → 400（当前 config 校验抛错形态，向后兼容）', () => {
    expect(httpStatusFromError(new Error('Provider[0].id must be a non-empty string'))).toBe(400);
  });
  it('无 code + "unknown key" → 400', () => {
    expect(httpStatusFromError(new Error('bodyRewrites[0] has unknown key: regex'))).toBe(400);
  });
  it('无 code + 无关键词 → 500', () => {
    expect(httpStatusFromError(new Error('something broke'))).toBe(500);
  });

  it('非 Error 值（字符串）→ message 兜底', () => {
    expect(httpStatusFromError('not found')).toBe(404);
    expect(httpStatusFromError('boom')).toBe(500);
  });
  it('null/undefined → 500（不抛）', () => {
    expect(httpStatusFromError(null)).toBe(500);
    expect(httpStatusFromError(undefined)).toBe(500);
  });
});

// ==================== providers / body-rewrites 路由一致性 ====================

describe('providers 与 body-rewrites 共用 httpStatusFromError（#14 一致性 + 端到端）', () => {
  it('providers：createProvider 抛 "already exists" → 409（util 正常映射）', async () => {
    createProviderMock.mockImplementation(() => {
      throw new Error('Provider name already exists: foo');
    });
    const base = await listen(makeApp());
    const res = await fetch(`${base}/api/providers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'foo' }),
    });
    expect(res.status).toBe(409);
  });

  it('providers：createProvider 抛携带 EACCES code 且 message 含 "must" 的错误 → 500（#14 端到端修复）', async () => {
    createProviderMock.mockImplementation(() => {
      throw Object.assign(new Error('EACCES: config must be writable'), { code: 'EACCES' });
    });
    const base = await listen(makeApp());
    const res = await fetch(`${base}/api/providers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'foo' }),
    });
    // 修复前：local 正则 /must/ 命中 → 400（bug）；修复后：code EACCES 优先 → 500
    expect(res.status).toBe(500);
  });

  it('body-rewrites：updateBodyRewrite 抛 "not found" → 404（util 正常映射）', async () => {
    updateBodyRewriteMock.mockImplementation(() => {
      throw new Error('Body rewrite rule not found: r1');
    });
    const base = await listen(makeApp());
    const res = await fetch(`${base}/api/body-rewrites/r1`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x' }),
    });
    expect(res.status).toBe(404);
  });

  it('body-rewrites：updateBodyRewrite 抛携带 ENOSPC code 且 message 含 "must" 的错误 → 500（#14 端到端修复）', async () => {
    updateBodyRewriteMock.mockImplementation(() => {
      throw Object.assign(new Error('ENOSPC: must free space'), { code: 'ENOSPC' });
    });
    const base = await listen(makeApp());
    const res = await fetch(`${base}/api/body-rewrites/r1`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x' }),
    });
    // 修复前：local 正则 /must/ 命中 → 400（bug）；修复后：code ENOSPC 优先 → 500
    expect(res.status).toBe(500);
  });

  it('两路由对同类 message（"not found"）返回一致状态码（均 404，单源 util 保证）', async () => {
    // providers 侧：createProvider 抛含 "not found" 的错误 → util → 404
    createProviderMock.mockImplementation(() => {
      throw new Error('upstream rule not found');
    });
    // body-rewrites 侧：updateBodyRewrite 抛含 "not found" 的错误 → util → 404
    updateBodyRewriteMock.mockImplementation(() => {
      throw new Error('upstream rule not found');
    });
    const base = await listen(makeApp());
    const [provRes, brRes] = await Promise.all([
      fetch(`${base}/api/providers`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'foo' }),
      }),
      fetch(`${base}/api/body-rewrites/r1`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'x' }),
      }),
    ]);
    expect(provRes.status).toBe(404);
    expect(brRes.status).toBe(404);
    expect(provRes.status).toBe(brRes.status);
  });
});
