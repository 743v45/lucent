/**
 * SQLite 存储层单测（db.ts）
 *
 * 覆盖：schema 建表与幂等重开、insertLog 幂等、迁移幂等（按 id 跳过）、
 * FTS5 trigram 中文/英文/特殊字符子串命中与 2 字符 LIKE 回退、
 * listLogs 过滤+排序+分页、searchLogs 带过滤、retention 级联删除。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openDb, insertLog, migrateFromJsonl, listLogs, searchLogs, getLogById,
  buildSearchText, deleteOldLogs, countLogs, getStats, clearAllLogs, type DB,
} from '../server/services/db.js';
import type { RawLogEntry } from '../server/types.js';

// ==================== fixture ====================

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
  dir = mkdtempSync(join(tmpdir(), 'lucent-db-'));
  dbPath = join(dir, 'test.db');
  db = openDb(dbPath);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// ==================== schema ====================

describe('openDb / schema', () => {
  it('建表后三张表存在且 FTS5 trigram 生效', () => {
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[];
    const names = tables.map(t => t.name);
    expect(names).toContain('logs');
    expect(names).toContain('log_bodies');
    expect(names).toContain('logs_fts');
    const tok = db.prepare(`SELECT sql FROM sqlite_master WHERE name='logs_fts'`).get() as { sql: string };
    expect(tok.sql).toContain('trigram');
  });
  it('重复 openDb 同路径不报错（IF NOT EXISTS）', () => {
    db.close();
    expect(() => { db = openDb(dbPath); }).not.toThrow();
    expect(countLogs(db)).toBe(0);
  });
});

// ==================== 写入 ====================

describe('insertLog', () => {
  it('写入后可按 id 取回 request/response 原文', () => {
    const e = makeEntry({ id: 'a1', timestamp: '2026-07-08T01:00:00.000Z' });
    expect(insertLog(db, e)).toBe(true);
    const got = getLogById(db, 'a1');
    expect(got).not.toBeNull();
    const req = JSON.parse(got!.request);
    expect(req.url).toBe(e.url);
    expect(req.body.model).toBe('claude-opus-4-8');
    const resp = JSON.parse(got!.response);
    expect(resp.body.type).toBe('sse_raw');
  });
  it('同 id 二次写入幂等跳过', () => {
    const e = makeEntry({ id: 'a2', timestamp: '2026-07-08T02:00:00.000Z' });
    expect(insertLog(db, e)).toBe(true);
    expect(insertLog(db, e)).toBe(false);
    expect(countLogs(db)).toBe(1);
  });
});

// ==================== buildSearchText ====================

describe('buildSearchText', () => {
  it('包含 model / system / user / assistant / tool 名', () => {
    const st = buildSearchText(makeEntry({ id: 's1', timestamp: '2026-07-08T03:00:00.000Z' }));
    expect(st).toContain('claude-opus-4-8');
    expect(st).toContain('helpful coding');
    expect(st).toContain('帮我分析代码结构');
    expect(st).toContain('代理拦截请求并记录对话');
    expect(st).toContain('Bash');
  });
});

// ==================== 迁移 ====================

describe('migrateFromJsonl', () => {
  it('导入 3 条且重跑幂等（imported=0 skipped=3）', () => {
    const logDir = join(dir, 'logs');
    mkdirSync(logDir, { recursive: true });
    const entries = [
      makeEntry({ id: 'm1', timestamp: '2026-07-08T10:00:00.000Z' }),
      makeEntry({ id: 'm2', timestamp: '2026-07-08T11:00:00.000Z' }),
      makeEntry({ id: 'm3', timestamp: '2026-07-08T12:00:00.000Z' }),
    ];
    writeFileSync(join(logDir, 'lucent_2026-07-08_10-00-00.jsonl'), entries.map(e => JSON.stringify(e)).join('\n') + '\n');
    const r1 = migrateFromJsonl(db, logDir);
    expect(r1.imported).toBe(3);
    expect(r1.errors).toBe(0);
    expect(countLogs(db)).toBe(3);
    const r2 = migrateFromJsonl(db, logDir);
    expect(r2.imported).toBe(0);
    expect(r2.skipped).toBe(3);
    expect(countLogs(db)).toBe(3);
  });
});

// ==================== listLogs ====================

describe('listLogs', () => {
  beforeEach(() => {
    insertLog(db, makeEntry({ id: 'l1', timestamp: '2026-07-08T01:00:00.000Z', agentType: 'main', providerName: 'anthropic' }));
    insertLog(db, makeEntry({ id: 'l2', timestamp: '2026-07-08T02:00:00.000Z', agentType: 'sub', providerName: 'openai', endpointType: 'openai-chat', url: 'https://api.openai.com/v1/chat/completions' }));
    insertLog(db, makeEntry({ id: 'l3', timestamp: '2026-07-08T03:00:00.000Z', agentType: 'sub', providerName: 'anthropic' }));
  });
  it('按 timestamp 倒序', () => {
    const { logs, total } = listLogs(db, { limit: 10, offset: 0 });
    expect(total).toBe(3);
    expect(logs.map(l => l.id)).toEqual(['l3', 'l2', 'l1']);
  });
  it('过滤 agentType=sub', () => {
    const { logs, total } = listLogs(db, { limit: 10, offset: 0, filter: { agentType: 'sub' } });
    expect(total).toBe(2);
    expect(logs.every(l => l.agent_type === 'sub')).toBe(true);
  });
  it('过滤 providerName + 分页', () => {
    const page1 = listLogs(db, { limit: 1, offset: 0, filter: { providerName: 'anthropic' } });
    expect(page1.total).toBe(2);
    expect(page1.logs.length).toBe(1);
    const page2 = listLogs(db, { limit: 1, offset: 1, filter: { providerName: 'anthropic' } });
    expect(page2.logs.length).toBe(1);
    expect(page1.logs[0].id).not.toBe(page2.logs[0].id);
  });
});

// ==================== searchLogs (FTS trigram) ====================

describe('searchLogs — FTS5 trigram', () => {
  beforeEach(() => {
    insertLog(db, makeEntry({ id: 'k1', timestamp: '2026-07-08T01:00:00.000Z' }));
    insertLog(db, makeEntry({ id: 'k2', timestamp: '2026-07-08T02:00:00.000Z', providerName: 'openai', endpointType: 'openai-chat' }));
  });
  it('中文子串命中', () => {
    const { logs, total } = searchLogs(db, '代理拦截请求', { limit: 10, offset: 0 });
    expect(total).toBe(2);
    expect(logs.length).toBe(2);
  });
  it('英文子串命中', () => {
    const { total } = searchLogs(db, 'helpful coding', { limit: 10, offset: 0 });
    expect(total).toBe(2);
  });
  it('含特殊字符的查询（model 名带 / -）不报语法错且命中', () => {
    const { total } = searchLogs(db, 'claude-opus-4-8', { limit: 10, offset: 0 });
    expect(total).toBe(2);
    expect(() => searchLogs(db, 'openai/gpt', { limit: 10, offset: 0 })).not.toThrow();
  });
  it('2 字符查询走 LIKE 回退且命中', () => {
    const { total } = searchLogs(db, '代理', { limit: 10, offset: 0 });
    expect(total).toBe(2);
  });
  it('未命中返回 0', () => {
    const { total } = searchLogs(db, 'zzznomatchzzz', { limit: 10, offset: 0 });
    expect(total).toBe(0);
  });
  it('search 叠加过滤', () => {
    const { total } = searchLogs(db, '代理拦截请求', { limit: 10, offset: 0, filter: { providerName: 'openai' } });
    expect(total).toBe(1);
  });
});

// ==================== retention ====================

describe('deleteOldLogs — 级联清理', () => {
  it('删除旧行并级联 log_bodies 与 FTS（删除后搜不到）', () => {
    insertLog(db, makeEntry({ id: 'old', timestamp: '2026-06-01T00:00:00.000Z' }));
    insertLog(db, makeEntry({ id: 'new', timestamp: '2026-07-08T00:00:00.000Z' }));
    expect(countLogs(db)).toBe(2);
    expect(searchLogs(db, '代理拦截请求', { limit: 10, offset: 0 }).total).toBe(2);

    const n = deleteOldLogs(db, '2026-07-01T00:00:00.000Z');
    expect(n).toBe(1);
    expect(countLogs(db)).toBe(1);
    const bodies = db.prepare(`SELECT COUNT(*) AS c FROM log_bodies`).get() as { c: number };
    expect(bodies.c).toBe(1);
    const s = searchLogs(db, '代理拦截请求', { limit: 10, offset: 0 });
    expect(s.total).toBe(1);
    expect(s.logs[0].id).toBe('new');
  });
});

// ==================== 统计 / 清空 ====================

describe('getStats / clearAllLogs', () => {
  it('getStats 返回条数与最旧/最新时间戳', () => {
    insertLog(db, makeEntry({ id: 'st1', timestamp: '2026-06-01T00:00:00.000Z' }));
    insertLog(db, makeEntry({ id: 'st2', timestamp: '2026-07-08T00:00:00.000Z' }));
    const s = getStats(db);
    expect(s.count).toBe(2);
    expect(s.oldest).toBe('2026-06-01T00:00:00.000Z');
    expect(s.newest).toBe('2026-07-08T00:00:00.000Z');
  });
  it('clearAllLogs 清空 logs/log_bodies/fts（删后搜不到）', () => {
    insertLog(db, makeEntry({ id: 'c1', timestamp: '2026-07-08T01:00:00.000Z' }));
    insertLog(db, makeEntry({ id: 'c2', timestamp: '2026-07-08T02:00:00.000Z' }));
    expect(countLogs(db)).toBe(2);
    expect(searchLogs(db, '代理拦截请求', { limit: 10, offset: 0 }).total).toBe(2);
    const n = clearAllLogs(db);
    expect(n).toBe(2);
    expect(countLogs(db)).toBe(0);
    const bodies = db.prepare(`SELECT COUNT(*) AS c FROM log_bodies`).get() as { c: number };
    expect(bodies.c).toBe(0);
    const fts = db.prepare(`SELECT COUNT(*) AS c FROM logs_fts`).get() as { c: number };
    expect(fts.c).toBe(0);
    expect(searchLogs(db, '代理拦截请求', { limit: 10, offset: 0 }).total).toBe(0);
  });
});
