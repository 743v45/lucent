/**
 * 查询 CLI（bin/query.ts）单测
 *
 * 覆盖：4 个子命令（logs/log/search/stats）、过滤（provider/model/status/agent-type/
 * thread-id/is-test/time）、keyset 游标分页、FTS 搜索、维度聚合 + totals、body 截断、
 * 错误退出码（db_error/bad_args）、db 路径解析、字段投影。
 *
 * 只测 query.ts 导出的纯函数（接收 db + opts）；runCommand（含 process.exit）不在此测。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, insertLog, type DB } from '../server/services/db.js';
import type { RawLogEntry } from '../server/types.js';
import {
  runLogsQuery, runSearchQuery, runLogDetail, runStatsQuery,
  buildListFilter, parseTime, resolveDbPath, openQueryDb, projectFields,
  emitError, QueryError,
} from '../bin/query.js';

// ==================== fixture ====================

function makeEntry(over: Partial<RawLogEntry> & { id: string; timestamp: string }): RawLogEntry {
  return {
    project: '',
    url: 'https://api.anthropic.com/v1/messages',
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: {
      model: 'claude-sonnet-5',
      max_tokens: 4096,
      messages: [{ role: 'user', content: 'hello' }],
      stream: true,
    },
    response: {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'text/event-stream' },
      body: { type: 'sse_raw', lines: [{ event: 'message_stop', data: '{}' }] },
    },
    duration: 100,
    isStream: true,
    mainAgent: true,
    agentType: 'main',
    apiType: 'anthropic-messages',
    clientType: 'claude-code',
    isTest: false,
    providerName: 'anthropic',
    endpointType: 'anthropic-messages',
    tokenUsage: { input_tokens: 100, output_tokens: 50 },
    ...over,
  } as RawLogEntry;
}

let dir: string;
let dbPath: string;
let db: DB;

/** 5 条样本：覆盖 anthropic/openai × 多 model × status 200/500 × main/sub × 3 thread × test × 不同时间 */
function seedDb(database: DB): RawLogEntry[] {
  const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
  const entries: RawLogEntry[] = [
    makeEntry({ id: 'e5', timestamp: iso(0), providerName: 'anthropic', agentType: 'main', threadId: 'T3', body: { model: 'claude-opus-5', messages: [{ role: 'user', content: 'hi' }], stream: true }, tokenUsage: { input_tokens: 1000, output_tokens: 200 }, duration: 500 }),
    makeEntry({ id: 'e1', timestamp: iso(30 * 60_000), providerName: 'anthropic', agentType: 'main', threadId: 'T1', tokenUsage: { input_tokens: 100, output_tokens: 50 }, duration: 120 }),
    makeEntry({ id: 'e2', timestamp: iso(90 * 60_000), providerName: 'anthropic', agentType: 'sub', threadId: 'T1', response: { status: 500, statusText: 'ERR', headers: {}, body: { error: 'boom' } }, tokenUsage: { input_tokens: 200, output_tokens: 0 }, duration: 60 }),
    makeEntry({ id: 'e3', timestamp: iso(3 * 3600_000), providerName: 'openai', agentType: 'main', threadId: 'T2', isTest: true, body: { model: 'gpt-4o', messages: [{ role: 'user', content: 'gpt-4o query' }], stream: true }, tokenUsage: { input_tokens: 300, output_tokens: 100 }, duration: 200 }),
    makeEntry({ id: 'e4', timestamp: iso(5 * 3600_000), providerName: 'openai', agentType: 'sub', threadId: 'T2', body: { model: 'gpt-4o', messages: [{ role: 'user', content: 'another gpt-4o' }], stream: true }, tokenUsage: { input_tokens: 50, output_tokens: 50 }, duration: 80 }),
  ];
  for (const e of entries) insertLog(database, e);
  return entries;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lucent-query-'));
  dbPath = join(dir, 'test.db');
  db = openDb(dbPath);
  seedDb(db);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// ==================== runLogsQuery ====================

describe('runLogsQuery — 列表 + 过滤 + 分页', () => {
  it('默认返回全部，按时间倒序，total 正确', () => {
    const r = runLogsQuery(db, {});
    expect(r.items.map(i => i.id)).toEqual(['e5', 'e1', 'e2', 'e3', 'e4']);
    expect(r.total).toBe(5);
    expect(r.count).toBe(5);
    expect(r.has_more).toBe(false);
    expect(r.cursor).toBeNull();
  });

  it('--provider 过滤', () => {
    const r = runLogsQuery(db, { provider: 'anthropic' });
    expect(r.items.map(i => i.id)).toEqual(['e5', 'e1', 'e2']);
    expect(r.total).toBe(3);
  });

  it('--model 过滤', () => {
    const r = runLogsQuery(db, { model: 'claude-sonnet-5' });
    expect(r.items.map(i => i.id)).toEqual(['e1', 'e2']);
  });

  it('--status 过滤', () => {
    const r = runLogsQuery(db, { status: '500' });
    expect(r.items.map(i => i.id)).toEqual(['e2']);
  });

  it('--agent-type 过滤', () => {
    const r = runLogsQuery(db, { agentType: 'main' });
    expect(r.items.map(i => i.id)).toEqual(['e5', 'e1', 'e3']);
  });

  it('--thread-id 过滤', () => {
    const r = runLogsQuery(db, { threadId: 'T1' });
    expect(r.items.map(i => i.id)).toEqual(['e1', 'e2']);
  });

  it('--is-test 只看测试请求', () => {
    const r = runLogsQuery(db, { isTest: true });
    expect(r.items.map(i => i.id)).toEqual(['e3']);
  });

  it('--since 相对时间过滤（1h 命中最近，2h 命中更多）', () => {
    const h1 = runLogsQuery(db, { since: '1h' });
    expect(h1.items.map(i => i.id)).toEqual(['e5', 'e1']); // 0 和 30m 前
    const h2 = runLogsQuery(db, { since: '2h' });
    expect(h2.items.map(i => i.id)).toEqual(['e5', 'e1', 'e2']); // 含 90m 前
  });

  it('--limit + 游标分页，三页不重叠', () => {
    const p1 = runLogsQuery(db, { limit: 2 });
    expect(p1.items.map(i => i.id)).toEqual(['e5', 'e1']);
    expect(p1.has_more).toBe(true);
    expect(p1.cursor).not.toBeNull();

    const p2 = runLogsQuery(db, { limit: 2, cursor: p1.cursor! });
    expect(p2.items.map(i => i.id)).toEqual(['e2', 'e3']);
    expect(p2.has_more).toBe(true);
    // 无重叠
    expect(p2.items.map(i => i.id)).not.toEqual(expect.arrayContaining(p1.items.map(i => i.id)));

    const p3 = runLogsQuery(db, { limit: 2, cursor: p2.cursor! });
    expect(p3.items.map(i => i.id)).toEqual(['e4']);
    expect(p3.has_more).toBe(false);
    expect(p3.cursor).toBeNull();
  });

  it('--limit 非法抛 bad_args', () => {
    expect(() => runLogsQuery(db, { limit: -1 })).toThrow(QueryError);
    expect(() => runLogsQuery(db, { limit: -1 })).toThrow(expect.objectContaining({ exitCode: 3 }));
  });
});

// ==================== runSearchQuery ====================

describe('runSearchQuery — FTS 搜索', () => {
  it('按关键词命中（gpt-4o → e3,e4）', () => {
    const r = runSearchQuery(db, 'gpt-4o', {});
    expect(r.items.map(i => i.id).sort()).toEqual(['e3', 'e4']);
    expect(r.total).toBe(2);
  });

  it('可叠加过滤（gpt-4o + main → e3）', () => {
    const r = runSearchQuery(db, 'gpt-4o', { agentType: 'main' });
    expect(r.items.map(i => i.id)).toEqual(['e3']);
  });

  it('空关键词抛 bad_args', () => {
    expect(() => runSearchQuery(db, '   ', {})).toThrow(QueryError);
  });
});

// ==================== runLogDetail ====================

describe('runLogDetail — 详情 + body 截断', () => {
  it('返回元数据 + parsed body，未截断', () => {
    const r = runLogDetail(db, { id: 'e1' }) as Record<string, unknown>;
    expect(r.id).toBe('e1');
    expect(r.model).toBe('claude-sonnet-5');
    const body = r.body as Record<string, unknown>;
    expect(body.body_truncated).toBe(false);
    expect(typeof body.request).toBe('object');
    expect(typeof body.response).toBe('object');
  });

  it('--no-body 不含 body 字段', () => {
    const r = runLogDetail(db, { id: 'e1', body: false }) as Record<string, unknown>;
    expect(r.body).toBeUndefined();
  });

  it('--max-body 截断并标 body_truncated', () => {
    const r = runLogDetail(db, { id: 'e1', maxBody: 10 }) as Record<string, unknown>;
    const body = r.body as Record<string, unknown>;
    expect(body.body_truncated).toBe(true);
  });

  it('--full-body 不截断', () => {
    const r = runLogDetail(db, { id: 'e1', maxBody: 10, fullBody: true }) as Record<string, unknown>;
    const body = r.body as Record<string, unknown>;
    expect(body.body_truncated).toBe(false);
  });

  it('未知 id 返回 null（非错误）', () => {
    expect(runLogDetail(db, { id: 'nope' })).toBeNull();
  });
});

// ==================== runStatsQuery ====================

describe('runStatsQuery — 维度聚合 + totals', () => {
  it('by model 聚合 + totals', () => {
    const r = runStatsQuery(db, { by: 'model' });
    const map = new Map(r.buckets.map(b => [String(b.key), b]));
    expect(map.get('claude-sonnet-5')?.count).toBe(2);
    expect(map.get('gpt-4o')?.count).toBe(2);
    expect(map.get('claude-opus-5')?.count).toBe(1);
    expect(r.totals.count).toBe(5);
    expect(r.totals.input_tokens).toBe(1000 + 100 + 200 + 300 + 50);
  });

  it('by provider', () => {
    const r = runStatsQuery(db, { by: 'provider' });
    const map = new Map(r.buckets.map(b => [String(b.key), b]));
    expect(map.get('anthropic')?.count).toBe(3);
    expect(map.get('openai')?.count).toBe(2);
  });

  it('by status', () => {
    const r = runStatsQuery(db, { by: 'status' });
    const map = new Map(r.buckets.map(b => [String(b.key), b]));
    expect(map.get('200')?.count).toBe(4);
    expect(map.get('500')?.count).toBe(1);
  });

  it('默认维度是 model', () => {
    const r = runStatsQuery(db, {});
    expect(r.dimension).toBe('model');
  });

  it('未知 --by 抛 bad_args', () => {
    expect(() => runStatsQuery(db, { by: 'color' })).toThrow(QueryError);
    try {
      runStatsQuery(db, { by: 'color' });
    } catch (e) {
      expect((e as QueryError).exitCode).toBe(3);
    }
  });
});

// ==================== buildListFilter / parseTime / projectFields ====================

describe('buildListFilter', () => {
  it('status 非整数抛 bad_args', () => {
    expect(() => buildListFilter({ status: 'abc' })).toThrow(QueryError);
  });
  it('status 合法转 number', () => {
    expect(buildListFilter({ status: '200' }).status).toBe(200);
  });
  it('isTest 透传', () => {
    expect(buildListFilter({ isTest: true }).isTest).toBe(true);
  });
});

describe('parseTime', () => {
  it('ISO 透传并规范成 ISO', () => {
    const t = parseTime('2026-07-29T00:00:00Z', 'since');
    expect(t).toBe('2026-07-29T00:00:00.000Z');
  });
  it('相对时长 since 早于 now', () => {
    const before = Date.now();
    const t = parseTime('1h', 'since');
    const ms = new Date(t).getTime();
    expect(ms).toBeLessThanOrEqual(before - 59 * 60_000);
    expect(ms).toBeGreaterThanOrEqual(before - 61 * 60_000);
  });
  it('非法抛 bad_args', () => {
    expect(() => parseTime('not-a-time', 'since')).toThrow(QueryError);
  });
});

describe('projectFields', () => {
  it('只保留指定字段', () => {
    const items = [{ id: 'a', model: 'm', status: 200 }, { id: 'b', model: 'n', status: 500 }];
    const out = projectFields(items, 'id,model');
    expect(out).toEqual([{ id: 'a', model: 'm' }, { id: 'b', model: 'n' }]);
  });
  it('不传 fields 原样返回', () => {
    const items = [{ id: 'a' }];
    expect(projectFields(items)).toEqual(items);
  });
});

// ==================== 路径 / 错误退出码 ====================

describe('resolveDbPath', () => {
  const orig = process.env.LUCENT_DB_PATH;
  afterEach(() => {
    if (orig === undefined) delete process.env.LUCENT_DB_PATH;
    else process.env.LUCENT_DB_PATH = orig;
  });

  it('override 参数优先', () => {
    process.env.LUCENT_DB_PATH = '/env/x.db';
    expect(resolveDbPath('/override.db')).toBe('/override.db');
  });
  it('env 次之', () => {
    process.env.LUCENT_DB_PATH = '/env/x.db';
    expect(resolveDbPath()).toBe('/env/x.db');
  });
  it('默认 endsWith lucent.db', () => {
    delete process.env.LUCENT_DB_PATH;
    expect(resolveDbPath()).toMatch(/lucent\.db$/);
  });
});

describe('openQueryDb', () => {
  it('文件不存在抛 db_error (exitCode 2)', () => {
    try {
      openQueryDb(join(tmpdir(), 'lucent-nope-' + Date.now() + '.db'));
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(QueryError);
      expect((e as QueryError).code).toBe('db_error');
      expect((e as QueryError).exitCode).toBe(2);
    }
  });
});

describe('emitError — 退出码映射', () => {
  it('QueryError 返回其 exitCode', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const code = emitError(new QueryError('bad_args', 'bad', 3), 'json');
    expect(code).toBe(3);
    expect(JSON.parse(spy.mock.calls[0][0])).toEqual({ error: 'bad_args', message: 'bad' });
    spy.mockRestore();
  });
  it('普通错误返回 1', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(emitError(new Error('boom'), 'json')).toBe(1);
    spy.mockRestore();
  });
});
