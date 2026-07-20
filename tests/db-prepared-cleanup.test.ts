/**
 * db.ts 性能与清理修复回归测试
 *
 * 覆盖：
 * - #8 prepared statement 复用（shadow db.prepare 计数：复用后编译次数 << 操作次数）
 *   + 功能等价（插入 / list / search 结果不变）
 * - #7 / low#4 deleteOld/deleteExpired 子查询删除 + 抽 deleteLogsByPredicate helper
 *   （批量删、级联 FTS/bodies、坏数据清理不误删存档行 expires_at NULL、两路径共存）
 * - low#5 migrateFromJsonl onProgress 语义（每文件回调一次，done/total 为已处理累计条数）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openDb, insertLog, listLogs, searchLogs, deleteOldLogs, deleteExpiredLogs,
  countLogs, migrateFromJsonl, type DB,
} from '../server/services/db.js';
import type { RawLogEntry } from '../server/types.js';

// ==================== fixture（与 db.test.ts 同构）====================

function makeEntry(over: Partial<RawLogEntry> & { id: string; timestamp: string }): RawLogEntry {
  return {
    project: '',
    url: 'https://api.anthropic.com/v1/messages',
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: {
      model: 'claude-opus-4-8',
      max_tokens: 4096,
      messages: [{ role: 'user', content: [{ type: 'text', text: '帮我分析代码结构' }] }],
      system: 'You are a helpful coding assistant.',
      tools: [{ name: 'Bash', description: 'run cmd', input_schema: {} }],
      stream: true,
    },
    response: {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'text/event-stream' },
      body: {
        type: 'sse_raw',
        lines: [
          { event: 'message_start', data: '{}' },
          { event: 'content_block_delta', data: JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: '代理拦截请求并记录对话' } }) },
          { event: 'message_stop', data: '{}' },
        ],
      },
    },
    duration: 123,
    isStream: true,
    mainAgent: true,
    agentType: 'main',
    apiType: 'anthropic-messages',
    clientType: 'claude-code',
    isTest: false,
    providerName: 'anthropic',
    endpointType: 'anthropic-messages',
    tokenUsage: { input_tokens: 100, output_tokens: 50, cache_read_tokens: 10, cache_creation_tokens: 5 },
    ...over,
  } as RawLogEntry;
}

let dir: string;
let dbPath: string;
let db: DB;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lucent-db-perf-'));
  dbPath = join(dir, 'test.db');
  db = openDb(dbPath);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// ==================== #8 prepared statement 复用 ====================

describe('#8 prepared statement 复用', () => {
  it('写入热路径：N 条日志的 INSERT 类语句各只编译一次（非每条 3 次）', () => {
    const origPrepare = db.prepare.bind(db);
    let insertPrepares = 0;
    // shadow db.prepare 计数 INSERT 类语句的编译次数（事务控制 BEGIN/COMMIT 等不计入）
    // @ts-expect-error 测试用：实例上 shadow 计数
    db.prepare = (sql: string) => {
      if (/^\s*INSERT\b/i.test(sql)) insertPrepares++;
      return origPrepare(sql);
    };
    for (let i = 0; i < 5; i++) {
      insertLog(db, makeEntry({ id: `reuse${i}`, timestamp: `2026-07-08T0${i}:00:00.000Z` }));
    }
    // @ts-expect-error 测试用 shadow 后还原
    db.prepare = origPrepare;

    // 旧实现每条 3 次 prepare → 5 条共 15；复用后 INSERT_LOG/INSERT_BODY/INSERT_FTS 各编译一次 = 3
    expect(insertPrepares).toBe(3);
    expect(countLogs(db)).toBe(5);
  });

  it('功能等价：复用后插入 + list + search 结果正确', () => {
    insertLog(db, makeEntry({ id: 'eq1', timestamp: '2026-07-08T01:00:00.000Z', agentType: 'main', providerName: 'anthropic' }));
    insertLog(db, makeEntry({ id: 'eq2', timestamp: '2026-07-08T02:00:00.000Z', agentType: 'sub', providerName: 'openai', endpointType: 'openai-chat', url: 'https://api.openai.com/v1/chat/completions' }));

    // list 全量倒序
    const page = listLogs(db, { limit: 10, offset: 0 });
    expect(page.total).toBe(2);
    expect(page.logs.map(l => l.id)).toEqual(['eq2', 'eq1']);

    // search FTS 命中
    const s = searchLogs(db, '代理拦截请求', { limit: 10, offset: 0 });
    expect(s.total).toBe(2);

    // search 叠加过滤
    const sf = searchLogs(db, '代理拦截请求', { limit: 10, offset: 0, filter: { providerName: 'openai' } });
    expect(sf.total).toBe(1);
    expect(sf.logs[0].id).toBe('eq2');
  });

  it('listLogs：相同 SQL 形状多次调用只编译一次（COUNT + SELECT 各 1）', () => {
    // 先塞数据（不计入计数）
    for (let i = 0; i < 3; i++) insertLog(db, makeEntry({ id: `l${i}`, timestamp: `2026-07-08T0${i}:00:00.000Z` }));

    const origPrepare = db.prepare.bind(db);
    let selectPrepares = 0;
    // @ts-expect-error 测试用 shadow
    db.prepare = (sql: string) => {
      if (/^\s*SELECT\b/i.test(sql)) selectPrepares++;
      return origPrepare(sql);
    };
    // OFFSET 模式（显式 offset、无 cursor）：COUNT + 主 SELECT 两条固定 SQL
    listLogs(db, { limit: 10, offset: 0 });
    listLogs(db, { limit: 10, offset: 0 });
    // @ts-expect-error 还原
    db.prepare = origPrepare;

    // 两次调用同形状 → 两条 SQL 各编译一次 = 2（旧实现每次 2 条共 4）
    expect(selectPrepares).toBe(2);
  });

  it('searchLogs：FTS 与 LIKE 两分支的 COUNT/SELECT 均按 SQL 形状缓存', () => {
    for (let i = 0; i < 3; i++) insertLog(db, makeEntry({ id: `s${i}`, timestamp: `2026-07-08T0${i}:00:00.000Z` }));

    const origPrepare = db.prepare.bind(db);
    let selectPrepares = 0;
    // @ts-expect-error 测试用 shadow
    db.prepare = (sql: string) => {
      if (/^\s*SELECT\b/i.test(sql)) selectPrepares++;
      return origPrepare(sql);
    };
    // ≥3 字符走 FTS（COUNT + SELECT = 2 条 SQL）；<3 字符走 LIKE（另一组 2 条 SQL）
    searchLogs(db, '代理拦截请求', { limit: 10, offset: 0 });
    searchLogs(db, '代理拦截请求', { limit: 10, offset: 0 });
    searchLogs(db, '代理', { limit: 10, offset: 0 });
    searchLogs(db, '代理', { limit: 10, offset: 0 });
    // @ts-expect-error 还原
    db.prepare = origPrepare;

    // FTS 分支 2 条 + LIKE 分支 2 条 = 4（旧实现：FTS 2 调用 ×2 + LIKE 2 调用 ×2 = 8）
    expect(selectPrepares).toBe(4);
    // 功能仍正确
    expect(searchLogs(db, '代理拦截请求', { limit: 10, offset: 0 }).total).toBe(3);
    expect(searchLogs(db, '代理', { limit: 10, offset: 0 }).total).toBe(3);
  });
});

// ==================== #7 / low#4 子查询删除 + helper ====================

describe('#7/low#4 deleteOld/deleteExpired 子查询删除', () => {
  it('deleteOldLogs 批量删旧行：logs / log_bodies / FTS 全部级联，新行保留', () => {
    for (let i = 0; i < 10; i++) insertLog(db, makeEntry({ id: `old${i}`, timestamp: `2026-06-0${(i % 9) + 1}T00:00:00.000Z` }));
    insertLog(db, makeEntry({ id: 'keep', timestamp: '2026-07-08T00:00:00.000Z' }));
    expect(countLogs(db)).toBe(11);

    const n = deleteOldLogs(db, '2026-07-01T00:00:00.000Z');
    expect(n).toBe(10);
    expect(countLogs(db)).toBe(1);
    const bodies = db.prepare(`SELECT COUNT(*) AS c FROM log_bodies`).get() as { c: number };
    expect(bodies.c).toBe(1);
    const fts = db.prepare(`SELECT COUNT(*) AS c FROM logs_fts`).get() as { c: number };
    expect(fts.c).toBe(1);
    // 旧行文本删后搜不到
    expect(searchLogs(db, '代理拦截请求', { limit: 10, offset: 0 }).total).toBe(1);
  });

  it('deleteOldLogs 无匹配行返回 0（子查询空集，不报错）', () => {
    insertLog(db, makeEntry({ id: 'x', timestamp: '2026-07-08T00:00:00.000Z' }));
    expect(deleteOldLogs(db, '2026-07-01T00:00:00.000Z')).toBe(0);
    expect(countLogs(db)).toBe(1);
  });

  it('deleteExpiredLogs 子查询删除过期临时行，未到期临时 + 存档（NULL）行保留', () => {
    for (let i = 0; i < 5; i++) insertLog(db, makeEntry({ id: `exp${i}`, timestamp: '2026-07-08T00:00:00.000Z', expiresAt: '2026-07-01T00:00:00.000Z' }));
    insertLog(db, makeEntry({ id: 'live', timestamp: '2026-07-08T00:00:00.000Z', expiresAt: '2099-12-31T00:00:00.000Z' }));
    insertLog(db, makeEntry({ id: 'archive', timestamp: '2026-07-08T00:00:00.000Z' })); // 无 expiresAt = 存档

    const n = deleteExpiredLogs(db, '2026-07-08T00:00:00.000Z');
    expect(n).toBe(5);
    expect(countLogs(db)).toBe(2);
    const bodies = db.prepare(`SELECT COUNT(*) AS c FROM log_bodies`).get() as { c: number };
    expect(bodies.c).toBe(2);
    const ids = db.prepare(`SELECT id FROM logs ORDER BY id`).all() as { id: string }[];
    expect(ids.map(r => r.id)).toEqual(['archive', 'live']);
  });

  it('deleteExpiredLogs 无临时日志（全存档）返回 0，不误删', () => {
    insertLog(db, makeEntry({ id: 'a1', timestamp: '2026-07-08T00:00:00.000Z' }));
    insertLog(db, makeEntry({ id: 'a2', timestamp: '2026-07-08T00:00:00.000Z' }));
    expect(deleteExpiredLogs(db, '2099-12-31T00:00:00.000Z')).toBe(0);
    expect(countLogs(db)).toBe(2);
  });

  it('两路径共存：deleteOld 与 deleteExpired 各自谓词隔离、互不误删（helper 抽取后回归）', () => {
    insertLog(db, makeEntry({ id: 'old_archive', timestamp: '2026-06-01T00:00:00.000Z' })); // 存档 + 旧
    insertLog(db, makeEntry({ id: 'old_exp', timestamp: '2026-06-01T00:00:00.000Z', expiresAt: '2026-06-01T00:00:00.000Z' })); // 过期 + 旧
    insertLog(db, makeEntry({ id: 'new_exp', timestamp: '2026-07-08T00:00:00.000Z', expiresAt: '2099-12-31T00:00:00.000Z' })); // 未到期临时 + 新
    insertLog(db, makeEntry({ id: 'new_archive', timestamp: '2026-07-08T00:00:00.000Z' })); // 存档 + 新

    // 先按过期清：只删 old_exp（new_exp 未到期；存档行不论过期都不动）
    expect(deleteExpiredLogs(db, '2026-07-08T00:00:00.000Z')).toBe(1);
    expect(countLogs(db)).toBe(3);
    // 再按保留期清（cutoff=2026-07-01）：删 old_archive（old_exp 已不在）
    expect(deleteOldLogs(db, '2026-07-01T00:00:00.000Z')).toBe(1);
    expect(countLogs(db)).toBe(2);
    const ids = db.prepare(`SELECT id FROM logs ORDER BY id`).all() as { id: string }[];
    expect(ids.map(r => r.id)).toEqual(['new_archive', 'new_exp']);
  });
});

// ==================== low#5 migrateFromJsonl onProgress 语义 ====================

describe('low#5 migrateFromJsonl onProgress 语义', () => {
  it('每文件回调一次，done/total 均为「已处理累计条数」且随文件递增', () => {
    const logDir = join(dir, 'logs');
    mkdirSync(logDir, { recursive: true });
    const fileA = [
      makeEntry({ id: 'p1', timestamp: '2026-07-08T01:00:00.000Z' }),
      makeEntry({ id: 'p2', timestamp: '2026-07-08T02:00:00.000Z' }),
    ];
    const fileB = [makeEntry({ id: 'p3', timestamp: '2026-07-08T03:00:00.000Z' })];
    writeFileSync(join(logDir, 'a.jsonl'), fileA.map(e => JSON.stringify(e)).join('\n') + '\n');
    writeFileSync(join(logDir, 'b.jsonl'), fileB.map(e => JSON.stringify(e)).join('\n') + '\n');

    const calls: { done: number; total: number; file: string }[] = [];
    migrateFromJsonl(db, logDir, (done, total, file) => calls.push({ done, total, file }));

    expect(calls.length).toBe(2); // 2 文件各回调一次
    // 文档语义：total 镜像 done（累计已处理条数，非分母）
    expect(calls.every(c => c.total === c.done)).toBe(true);
    // done 随文件处理单调递增（两文件分别处理 1 条与 2 条，累计集合为 {1,3}，不卡在固定值）
    expect(calls.map(c => c.done).sort((a, b) => a - b)).toEqual([1, 3]);
    expect(countLogs(db)).toBe(3);
  });
});
