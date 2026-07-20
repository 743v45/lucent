/**
 * log-reader 坏 JSON 防御回归（Bug #6：单条 body 损坏炸整页）
 *
 * 现状（bug）：reconstructEntry 内 JSON.parse(request/response) 无 try/catch，单条 body 损坏会
 * 冒泡到 readLogs 外层 catch，整页退化成 logs:[]（与「body 缺失就跳过」的优雅降级不一致）。
 * 修复：在 readLogs 的 map 回调外包 try/catch，解析失败 dbg + 返回 null，复用下游 .filter 跳过 null
 * 管线（保持 reconstructEntry 签名不变，避免波及 log-manager 等其他调用方）。
 * getLogById 由外层 catch 兜底返回 null，单条详情损坏不会冒泡成 500。
 *
 * 用真实 SQLite 临时库插入「正常 + body 损坏」日志，验证 readLogs 只跳过坏的那条、不返回空页。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { initDb, closeDb, getDb } from '../server/services/db-instance.js';
import { readLogs, getLogById, reconstructEntry } from '../server/services/log-reader.js';
import type { LogRow } from '../server/services/db.js';

let dir: string;

const GOOD_REQ = JSON.stringify({
  method: 'POST',
  url: 'https://api.anthropic.com/v1/messages',
  headers: {},
  body: { model: 'claude-3-5-sonnet-20241022', messages: [{ role: 'user', content: 'hi' }] },
});
const GOOD_RESP = JSON.stringify({ status: 200, statusText: 'OK', headers: {}, body: {} });

function makeRow(overrides: Partial<LogRow> = {}): LogRow {
  return {
    rowid: 1,
    id: 'r1',
    timestamp: '2026-07-19T00:00:00.000Z',
    agent_type: 'main',
    client_type: null,
    provider_name: null,
    endpoint_type: 'anthropic-messages',
    model: 'claude-3-5-sonnet-20241022',
    status: 200,
    duration: 10,
    is_stream: 0,
    is_test: 0,
    thread_id: null,
    error: null,
    input_tokens: 100,
    output_tokens: 50,
    cache_read_tokens: null,
    cache_creation_tokens: null,
    expires_at: null,
    ...overrides,
  };
}

/** 直接插 logs + log_bodies（不经 insertLog，以便注入损坏 body 字符串） */
function insertLogWithBody(rowid: number, id: string, ts: string, request: string, response: string): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO logs (rowid, id, timestamp, agent_type, endpoint_type, model, status, duration, is_stream, is_test, input_tokens, output_tokens)
     VALUES (?, ?, ?, 'main', 'anthropic-messages', 'claude-3-5-sonnet-20241022', 200, 10, 0, 0, 100, 50)`,
  ).run(rowid, id, ts);
  db.prepare(
    `INSERT INTO log_bodies (log_rowid, request, response, search_text) VALUES (?, ?, ?, ?)`,
  ).run(rowid, request, response, '');
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lucent-badjson-'));
  initDb(join(dir, 'test.db'));
});

afterEach(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe('reconstructEntry — 坏 JSON 原始行为（仍抛，故 readLogs map 需包 try/catch）', () => {
  it('request 损坏 → 直接抛（readLogs 回调负责兜底）', () => {
    expect(() => reconstructEntry(makeRow(), '{bad request', GOOD_RESP)).toThrow();
  });

  it('response 损坏 → 直接抛（readLogs 回调负责兜底）', () => {
    expect(() => reconstructEntry(makeRow(), GOOD_REQ, '{bad response')).toThrow();
  });

  it('正常 body → 正常重建', () => {
    const entry = reconstructEntry(makeRow(), GOOD_REQ, GOOD_RESP);
    expect(entry.id).toBe('r1');
    expect(entry.request?.url).toBe('https://api.anthropic.com/v1/messages');
  });
});

describe('readLogs — 单条 body 损坏不炸整页（Bug #6 回归）', () => {
  it('跳过坏 body 那条，其余正常返回（不再退化成 logs:[]）', async () => {
    // 两条：valid + 坏 response。listLogs 按 ts DESC → 坏的在前
    insertLogWithBody(1, 'corrupt-1', '2026-07-19T00:00:01.000Z', GOOD_REQ, '{not valid json');
    insertLogWithBody(2, 'valid-1', '2026-07-19T00:00:00.000Z', GOOD_REQ, GOOD_RESP);

    const result = await readLogs({});

    // 关键：未修复时整页 logs:[]（reconstructEntry 抛 → 外层 catch）；修复后只跳过坏的那条
    expect(result.logs).toHaveLength(1);
    expect(result.logs[0].id).toBe('valid-1');
    // total 仍计两条（listLogs 计数不受 body 损坏影响）
    expect(result.total).toBe(2);
  });

  it('全部损坏 → 空页但不抛（logs:[] 经 .filter，total=真实命中数，非外层 catch 的 0）', async () => {
    insertLogWithBody(1, 'corrupt-a', '2026-07-19T00:00:01.000Z', GOOD_REQ, '{bad');
    insertLogWithBody(2, 'corrupt-b', '2026-07-19T00:00:00.000Z', '{bad', GOOD_RESP);

    const result = await readLogs({});

    expect(result.logs).toHaveLength(0);
    // total=2 区分「跳过全部」与「外层 catch 整页失败（会返回 total:0）」
    expect(result.total).toBe(2);
  });
});

describe('getLogById — 坏 JSON 防御', () => {
  it('详情 body 损坏 → 返回 null（不抛）', async () => {
    insertLogWithBody(1, 'bad-detail', '2026-07-19T00:00:00.000Z', GOOD_REQ, '{bad response');
    const result = await getLogById('bad-detail');
    expect(result).toBeNull();
  });

  it('正常详情 → 正常返回', async () => {
    insertLogWithBody(1, 'good-detail', '2026-07-19T00:00:00.000Z', GOOD_REQ, GOOD_RESP);
    const result = await getLogById('good-detail');
    expect(result).not.toBeNull();
    expect(result?.id).toBe('good-detail');
  });
});
