/**
 * /api/logs 路由安全与健壮性测试（Bug #1 路径穿越 / Bug #2 心跳裸 write / Bug #5 连接上限 503）
 *
 * 通过真实 express app + fetch 驱动路由（LogManager 被 mock，聚焦路由层校验）：
 * - export：format 白名单拒绝（400）、路径穿越拒绝（400，不触达 LogManager）
 * - import：filePath 限 logDir 内，穿越拒绝（400）
 * - stream：连接超上限回 503；心跳 res.write 抛错被捕获（无 uncaughtException）且客户端被清理
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { get } from 'node:http';
import { createLogsRouter } from '../server/routes/logs.js';
import {
  registerSseClient,
  unregisterSseClient,
  getSseClientCount,
  MAX_SSE_CLIENTS,
} from '../server/sse-bus.js';

// mock LogManager：避免真实 DB 依赖，聚焦路由层校验（断言"是否被调用 + 入参"）
const { exportLogsMock, importLogsMock } = vi.hoisted(() => ({
  exportLogsMock: vi.fn(),
  importLogsMock: vi.fn(),
}));
vi.mock('../server/log-manager.js', () => ({
  exportLogs: exportLogsMock,
  importLogs: importLogsMock,
  getLogStats: () => ({ totalEntries: 0, totalSize: 0, fileCount: 0 }),
  clearAllLogs: () => ({ success: true, deleted: 0 }),
}));

// mock LogReader：GET /api/logs 断言传入的 LogsQuery（low#6：offset 不应再被收集）
const { readLogsMock } = vi.hoisted(() => ({
  readLogsMock: vi.fn(),
}));
vi.mock('../server/services/log-reader.js', () => ({
  readLogs: readLogsMock,
  invalidateCache: vi.fn(),
  getLogById: vi.fn(),
}));

let dir: string;
let server: ReturnType<import('express').Express['listen']> | undefined;
/** 直接注册的 mock SSE 客户端（503 测试用），按引用清理 */
const directClients: Response[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lucent-routes-sec-'));
  exportLogsMock.mockReset();
  exportLogsMock.mockReturnValue({ success: true, count: 0, path: 'mock' });
  importLogsMock.mockReset();
  importLogsMock.mockReturnValue({ success: true, imported: 0, errors: 0 });
  readLogsMock.mockReset();
  readLogsMock.mockResolvedValue({ logs: [], total: 0, nextCursor: null, hasMore: false });
});

afterEach(async () => {
  if (server) {
    await new Promise<void>(r => server!.close(() => r(undefined)));
    server = undefined;
  }
  for (const res of directClients) unregisterSseClient(res);
  directClients.length = 0;
  expect(getSseClientCount()).toBe(0);
  rmSync(dir, { recursive: true, force: true });
});

/** 构造 express app；breakHeartbeat 时包装 res.write 让心跳抛错（模拟 broken pipe） */
function makeApp(opts: { breakHeartbeat?: boolean; heartbeatIntervalMs?: number } = {}): express.Express {
  const app = express();
  app.use(express.json());
  if (opts.breakHeartbeat) {
    app.use('/api/logs/stream', (req: Request, res: Response, next: NextFunction) => {
      const orig = res.write.bind(res) as (chunk: unknown, ...rest: unknown[]) => boolean;
      let connectedSent = false;
      res.write = ((chunk: unknown, ...rest: unknown[]) => {
        const s = typeof chunk === 'string' ? chunk : '';
        if (connectedSent && s.includes('heartbeat')) {
          throw new Error('write EPIPE (broken pipe)');
        }
        if (s.includes('connected')) connectedSent = true;
        return orig(chunk, ...rest);
      }) as typeof res.write;
      next();
    });
  }
  app.use(
    createLogsRouter({
      resolvedConfig: { logDir: dir, heartbeatIntervalMs: opts.heartbeatIntervalMs ?? 30000 },
      onEnable: () => {},
    }),
  );
  return app;
}

function listen(app: express.Express): string {
  return new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', () => {
      const addr = server!.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

describe('POST /api/logs/export — format 白名单 + 路径穿越（Bug #1）', () => {
  it('非法 format 被白名单拒绝（400），不触达 LogManager', async () => {
    const base = await listen(makeApp());
    const res = await fetch(`${base}/api/logs/export`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ format: 'evil' }),
    });
    expect(res.status).toBe(400);
    expect(exportLogsMock).not.toHaveBeenCalled();
  });

  it("format='jsonl/../../../foo' 穿越被拒绝（400），不触达 LogManager", async () => {
    const base = await listen(makeApp());
    const res = await fetch(`${base}/api/logs/export`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ format: 'jsonl/../../../foo' }),
    });
    expect(res.status).toBe(400);
    expect(exportLogsMock).not.toHaveBeenCalled();
  });

  it('合法 format=jsonl 通过，且传给 LogManager 的路径落在 logDir 内', async () => {
    const base = await listen(makeApp());
    const res = await fetch(`${base}/api/logs/export`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ format: 'jsonl' }),
    });
    expect(res.status).toBe(200);
    expect(exportLogsMock).toHaveBeenCalledTimes(1);
    const passedPath = exportLogsMock.mock.calls[0][0] as string;
    expect(passedPath.startsWith(dir)).toBe(true);
  });

  it('合法 format=markdown 通过', async () => {
    const base = await listen(makeApp());
    const res = await fetch(`${base}/api/logs/export`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ format: 'markdown' }),
    });
    expect(res.status).toBe(200);
    expect(exportLogsMock).toHaveBeenCalledWith(
      expect.stringContaining('.markdown'),
      expect.objectContaining({ format: 'markdown' }),
    );
  });
});

describe('POST /api/logs/import — filePath 限 logDir 内（Bug #1）', () => {
  it('绝对路径越界（/etc/passwd）被拒绝（400），不触达 LogManager', async () => {
    const base = await listen(makeApp());
    const res = await fetch(`${base}/api/logs/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePath: '/etc/passwd' }),
    });
    expect(res.status).toBe(400);
    expect(importLogsMock).not.toHaveBeenCalled();
  });

  it("相对穿越 '../secret' 被拒绝（400）", async () => {
    const base = await listen(makeApp());
    const res = await fetch(`${base}/api/logs/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePath: join(dir, '../secret.jsonl') }),
    });
    expect(res.status).toBe(400);
    expect(importLogsMock).not.toHaveBeenCalled();
  });

  it('logDir 内的路径通过', async () => {
    const base = await listen(makeApp());
    const res = await fetch(`${base}/api/logs/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePath: join(dir, 'import.jsonl') }),
    });
    expect(res.status).toBe(200);
    expect(importLogsMock).toHaveBeenCalledTimes(1);
  });
});

describe('GET /api/logs/stream — 连接上限 + 心跳安全（Bug #2 / #5）', () => {
  it('连接数达上限后新连接返回 503', async () => {
    // 填满 SSE 连接池
    for (let i = 0; i < MAX_SSE_CLIENTS; i++) {
      const res = { write: () => true } as unknown as Response;
      directClients.push(res);
      registerSseClient(res);
    }
    expect(getSseClientCount()).toBe(MAX_SSE_CLIENTS);

    const base = await listen(makeApp());
    const res = await fetch(`${base}/api/logs/stream`);
    expect(res.status).toBe(503);
  });

  it('正常连接收到 connected 事件，断开后客户端被清理', async () => {
    const base = await listen(makeApp({ heartbeatIntervalMs: 10000 }));
    const res = await fetch(`${base}/api/logs/stream`);
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    expect(text).toContain('event: connected');
    expect(getSseClientCount()).toBe(1);
    await reader.cancel();
    // 给 req.on('close') 一点时间清理
    await new Promise(r => setTimeout(r, 50));
    expect(getSseClientCount()).toBe(0);
  });

  it('心跳 res.write 抛错被捕获：无 uncaughtException 且客户端被清理', async () => {
    const base = await listen(makeApp({ breakHeartbeat: true, heartbeatIntervalMs: 30 }));
    let uncaught: unknown = null;
    const onUncaught = (err: unknown) => {
      uncaught = err;
    };
    process.on('uncaughtException', onUncaught);

    try {
      // 用 node:http 直接消费：服务端 destroy 会导致 socket abrupt close，
      // 客户端 sres 的 end/error 都视作预期完成（重点观测服务端无 uncaughtException）
      const { got } = await new Promise<{ got: string }>(resolve => {
        let got = '';
        let settled = false;
        const finish = () => {
          if (!settled) {
            settled = true;
            resolve({ got });
          }
        };
        const req = get(`${base}/api/logs/stream`, sres => {
          sres.on('data', (c: Buffer) => {
            got += c.toString();
          });
          sres.on('end', finish); // 服务端 destroy → 客户端看到 EOF
          sres.on('error', finish); // abrupt close → error，预期内
          setTimeout(finish, 500); // 兜底
        });
        req.on('error', finish);
      });
      // 给服务端 destroySseClient 清理一点时间
      await new Promise(r => setTimeout(r, 30));
      expect(got).toContain('connected'); // connected 在心跳之前已成功发送
      expect(uncaught).toBeNull(); // 关键：心跳抛错被 writeSse 捕获，未冒泡
      expect(getSseClientCount()).toBe(0); // destroySseClient 已清理
    } finally {
      process.off('uncaughtException', onUncaught);
    }
  });
});

describe('GET /api/logs — offset 不再被收集（low#6：API 只支持 cursor 翻页）', () => {
  // 现状：路由曾把 offset 塞进 LogsQuery，但 LogReader.readLogs 走 keyset cursor 根本不读 offset，
  // 调用方按 offset 翻页会一直拿到首页。修复：路由不再收集 offset（未知 query 不报错）。
  it('传 offset 不报错（200），且 offset 不进入传给 readLogs 的 query', async () => {
    const base = await listen(makeApp());
    const res = await fetch(`${base}/api/logs?offset=50&limit=10`);
    expect(res.status).toBe(200);
    expect(readLogsMock).toHaveBeenCalledTimes(1);
    const query = readLogsMock.mock.calls[0][0] as Record<string, unknown>;
    expect(query).not.toHaveProperty('offset');
    // limit 仍正常透传
    expect(query.limit).toBe(10);
  });

  it('不传 offset 同样正常，query 无 offset 字段', async () => {
    const base = await listen(makeApp());
    const res = await fetch(`${base}/api/logs?limit=5`);
    expect(res.status).toBe(200);
    const query = readLogsMock.mock.calls[0][0] as Record<string, unknown>;
    expect(query).not.toHaveProperty('offset');
    expect(query.limit).toBe(5);
  });

  it('offset 与无 offset 传入相同 query 形状（offset 不再影响该 API 翻页）', async () => {
    const base = await listen(makeApp());
    await fetch(`${base}/api/logs?offset=999`);
    await fetch(`${base}/api/logs`);
    expect(readLogsMock).toHaveBeenCalledTimes(2);
    const q1 = readLogsMock.mock.calls[0][0] as Record<string, unknown>;
    const q2 = readLogsMock.mock.calls[1][0] as Record<string, unknown>;
    expect(q1).toEqual(q2);
  });
});

describe('POST /api/logs/{export,import} — req.body 缺失不 500（low#7 null 守卫）', () => {
  // 无 body / 非 JSON Content-Type 时 req.body 为 undefined，裸解构会抛 TypeError 被吞成 500。
  // 守卫：解构前 req.body ?? {}。fetch 不带 body / Content-Type → express.json 跳过 → req.body=undefined。
  it('export 无 body 不 500（format 走默认 jsonl，触达 LogManager）', async () => {
    const base = await listen(makeApp());
    const res = await fetch(`${base}/api/logs/export`, { method: 'POST' });
    expect(res.status).not.toBe(500);
    expect(res.status).toBe(200);
    expect(exportLogsMock).toHaveBeenCalledTimes(1);
    expect(exportLogsMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ format: 'jsonl', includeMeta: false }),
    );
  });

  it('import 无 body 回 400（filePath 缺失），而非 500', async () => {
    const base = await listen(makeApp());
    const res = await fetch(`${base}/api/logs/import`, { method: 'POST' });
    expect(res.status).not.toBe(500);
    expect(res.status).toBe(400);
    expect(importLogsMock).not.toHaveBeenCalled();
  });

  it('export 非 JSON Content-Type（text/plain）req.body 仍守卫，不 500', async () => {
    const base = await listen(makeApp());
    const res = await fetch(`${base}/api/logs/export`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '',
    });
    expect(res.status).not.toBe(500);
  });
});
