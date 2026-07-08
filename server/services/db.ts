/**
 * SQLite 索引化存储层
 *
 * 替代 JSONL 作为日志主存：小字段入 logs（建索引，扛列表/排序/过滤/分页），
 * 大内容入 log_bodies（仅详情视图与检索时读取），全文检索走 logs_fts（FTS5 trigram）。
 *
 * 写入：拦截器拿到完整 RawLogEntry → insertLog（INSERT OR IGNORE 按 id 幂等）。
 * 迁移：migrateFromJsonl 把现有 JSONL 一次性导入（幂等，可重跑）。
 * 读取：listLogs / searchLogs / getLogById —— 全部走索引，O(命中+limit) 而非 O(全集)。
 *
 * 设计要点：
 * - WAL 模式：多读 + 一写并发，代理写日志不阻塞 Web 查询。
 * - FTS5 trigram：中英文通吃、子串语义；rowid 与 logs 对齐，便于 join 与级联删除。
 * - logs 只存可索引小字段；request/response 原文以 JSON 文本存 log_bodies，避免列表查询拖大内容。
 */
import Database from 'better-sqlite3';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractContext } from '../context-extractors.js';
import { extractFromSSELines } from '../sse-extractor.js';
import type { RawLogEntry } from '../types.js';
import createDebug from 'debug';

const dbg = createDebug('lucent:db');

export type DB = Database.Database;

// ==================== 行类型 ====================

/** logs 表一行（可索引小字段） */
export interface LogRow {
  rowid: number;
  id: string;
  timestamp: string;
  agent_type: string | null;
  client_type: string | null;
  provider_name: string | null;
  endpoint_type: string | null;
  model: string | null;
  status: number | null;
  duration: number;
  is_stream: number;
  is_test: number;
  thread_id: string | null;
  error: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
}

/** 列表查询过滤条件 */
export interface ListFilter {
  agentType?: string | 'all';
  providerName?: string;
  endpointType?: string;
  startDate?: string;
  endDate?: string;
}

// ==================== 建库 / Schema ====================

const SCHEMA = `
CREATE TABLE IF NOT EXISTS logs (
  rowid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  timestamp TEXT NOT NULL,
  agent_type TEXT,
  client_type TEXT,
  provider_name TEXT,
  endpoint_type TEXT,
  model TEXT,
  status INTEGER,
  duration INTEGER NOT NULL DEFAULT 0,
  is_stream INTEGER NOT NULL DEFAULT 0,
  is_test INTEGER NOT NULL DEFAULT 0,
  thread_id TEXT,
  error TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_creation_tokens INTEGER
);
CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_logs_agent ON logs(agent_type);
CREATE INDEX IF NOT EXISTS idx_logs_provider ON logs(provider_name);
CREATE INDEX IF NOT EXISTS idx_logs_endpoint ON logs(endpoint_type);
CREATE INDEX IF NOT EXISTS idx_logs_thread ON logs(thread_id);
CREATE INDEX IF NOT EXISTS idx_logs_model ON logs(model);

CREATE TABLE IF NOT EXISTS log_bodies (
  log_rowid INTEGER PRIMARY KEY REFERENCES logs(rowid) ON DELETE CASCADE,
  request TEXT NOT NULL,
  response TEXT NOT NULL,
  search_text TEXT NOT NULL
);

-- FTS5 trigram：rowid 与 logs.rowid 对齐，便于 join 与级联删除。
-- 仅索引 search_text（已把 url/model/provider/error/system/messages/assistant/tools 拍平）。
CREATE VIRTUAL TABLE IF NOT EXISTS logs_fts USING fts5(
  search_text,
  tokenize = 'trigram'
);
`;

/**
 * 打开/创建数据库并初始化 schema。
 * WAL + synchronous=NORMAL：本地日志工具可接受的持久性，换并发与吞吐。
 */
export function openDb(dbPath: string): DB {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('cache_size = -65536'); // 64MB page cache
  db.exec(SCHEMA);
  const ver = db.prepare('select sqlite_version() as v').get() as { v: string };
  dbg('数据库就绪: %s (sqlite %s)', dbPath, ver.v);
  return db;
}

// ==================== search_text 抽取 ====================

/** 把字符串/内容块数组拍平成纯文本 */
function flattenContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b: any) => (typeof b === 'string' ? b : (b?.text ?? (typeof b?.content === 'string' ? b.content : ''))))
      .filter(Boolean)
      .join(' ');
  }
  return '';
}

/**
 * 从 RawLogEntry 抽出可检索文本：url / model / provider / error / system / 各轮消息 / 助手回复 / 工具名。
 * 复用 extractContext（统一 Anthropic / OpenAI 消息格式）与 extractFromSSELines（SSE 流文本）。
 */
export function buildSearchText(entry: RawLogEntry): string {
  const parts: string[] = [];
  if (entry.url) parts.push(entry.url);
  const body = entry.body as any;
  const model = body?.model;
  if (model) parts.push(String(model));
  if (entry.providerName) parts.push(entry.providerName);
  if (entry.error) parts.push(entry.error);

  const extracted = extractContext(body, entry.url);
  if (extracted) {
    if (extracted.systemPrompt) parts.push(extracted.systemPrompt);
    for (const m of extracted.messages) parts.push(flattenContent(m.content));
    for (const t of extracted.tools) parts.push(t.name);
  } else if (body?.messages && Array.isArray(body.messages)) {
    // extractContext 未命中时的兜底：直接拍平 messages
    for (const m of body.messages) parts.push(flattenContent(m.content));
  }

  // 助手回复文本
  const respBody = entry.response?.body as any;
  if (respBody?.type === 'sse_raw' && Array.isArray(respBody.lines)) {
    const sse = extractFromSSELines(respBody.lines);
    if (sse.text) parts.push(sse.text);
    for (const tc of sse.toolCalls) parts.push(tc.name);
  } else if (respBody && typeof respBody === 'object') {
    // 非流式：Anthropic content[].text 或 OpenAI choices[].message.content
    if (Array.isArray(respBody.content)) parts.push(flattenContent(respBody.content));
    else if (Array.isArray(respBody.choices)) {
      for (const c of respBody.choices) parts.push(flattenContent(c?.message?.content));
    }
  }

  return parts.join('\n');
}

// ==================== 写入 ====================

const INSERT_LOG = `
INSERT OR IGNORE INTO logs
  (id, timestamp, agent_type, client_type, provider_name, endpoint_type, model,
   status, duration, is_stream, is_test, thread_id, error,
   input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens)
VALUES
  (@id, @timestamp, @agent_type, @client_type, @provider_name, @endpoint_type, @model,
   @status, @duration, @is_stream, @is_test, @thread_id, @error,
   @input_tokens, @output_tokens, @cache_read_tokens, @cache_creation_tokens)`;

const INSERT_BODY = `INSERT OR REPLACE INTO log_bodies (log_rowid, request, response, search_text) VALUES (?, ?, ?, ?)`;
const INSERT_FTS = `INSERT INTO logs_fts (rowid, search_text) VALUES (?, ?)`;

/** 把 RawLogEntry 拆成 logs 行参数 */
function toLogParams(entry: RawLogEntry): Record<string, unknown> {
  const body = entry.body as any;
  const tu = entry.tokenUsage;
  return {
    id: entry.id,
    timestamp: entry.timestamp,
    agent_type: entry.agentType ?? null,
    client_type: entry.clientType ?? null,
    provider_name: entry.providerName ?? null,
    endpoint_type: entry.endpointType ?? entry.apiType ?? null,
    model: body?.model ?? null,
    status: entry.response?.status ?? null,
    duration: entry.duration ?? 0,
    is_stream: entry.isStream ? 1 : 0,
    is_test: entry.isTest ? 1 : 0,
    thread_id: entry.threadId ?? null,
    error: entry.error ?? null,
    input_tokens: tu?.input_tokens ?? null,
    output_tokens: tu?.output_tokens ?? null,
    cache_read_tokens: tu?.cache_read_tokens ?? null,
    cache_creation_tokens: tu?.cache_creation_tokens ?? null,
  };
}

/**
 * 写入一条日志的三条语句（logs / log_bodies / logs_fts），不含事务。
 * 调用方必须自行包事务以保证三表原子一致：
 *   - 单条 live 写入用 insertLog（已套事务）；
 *   - 批量迁移用 migrateFromJsonl（整批一个事务，调用本函数，免 per-entry savepoint）。
 * 返回是否实际写入（false = 因 id 重复跳过）。
 */
function insertLogInner(db: DB, entry: RawLogEntry): boolean {
  const info = db.prepare(INSERT_LOG).run(toLogParams(entry));
  if (info.changes === 0) return false; // id 已存在，幂等跳过
  const rowid = Number(info.lastInsertRowid);
  const request = JSON.stringify({ method: entry.method ?? 'GET', url: entry.url ?? '', headers: entry.headers ?? {}, body: entry.body });
  const response = JSON.stringify(entry.response);
  const search_text = buildSearchText(entry);
  db.prepare(INSERT_BODY).run(rowid, request, response, search_text);
  db.prepare(INSERT_FTS).run(rowid, search_text);
  return true;
}

/**
 * 写入一条日志（live 写入入口，幂等：id 已存在则跳过）。
 * 内部套事务：logs / log_bodies / logs_fts 三表原子一致，中途抛错不留孤儿
 * （避免「logs 有行、body/fts 没有」导致搜不到也取不到详情）。
 */
export function insertLog(db: DB, entry: RawLogEntry): boolean {
  let inserted = false;
  db.transaction(() => { inserted = insertLogInner(db, entry); })();
  return inserted;
}

/**
 * 批量写入（导入用）：整批一个事务，内部走 insertLogInner 免 per-entry savepoint。
 * 单条抛错被捕获、记 error，不中断整批；适用于一次性迁移 / 用户导入（低频，批量原子足够）。
 */
export function insertLogsBatch(db: DB, entries: RawLogEntry[]): { imported: number; skipped: number; errors: number } {
  let imported = 0;
  let skipped = 0;
  let errors = 0;
  db.transaction(() => {
    for (const e of entries) {
      try {
        if (insertLogInner(db, e)) imported++;
        else skipped++;
      } catch (err) {
        errors++;
        dbg('批量写入单条失败 id=%s: %O', (e as RawLogEntry)?.id, err);
      }
    }
  })();
  return { imported, skipped, errors };
}

// ==================== 迁移 ====================

/**
 * 从 JSONL 目录一次性迁移导入（幂等，可重跑）。
 * 每批 BATCH 条一个事务，兼顾吞吐与内存。
 */
export function migrateFromJsonl(
  db: DB,
  logDir: string,
  onProgress?: (done: number, total: number, file: string) => void,
): { imported: number; skipped: number; files: number; errors: number } {
  if (!existsSync(logDir)) return { imported: 0, skipped: 0, files: 0, errors: 0 };

  const files = readdirSync(logDir)
    .filter(f => f.endsWith('.jsonl') && !f.startsWith('export_'))
    .sort()
    .reverse();

  const BATCH = 500;
  let imported = 0;
  let skipped = 0;
  let errors = 0;

  const tx = db.transaction((entries: RawLogEntry[]) => {
    for (const e of entries) {
      try {
        // 直接走 inner：整批已在事务里，免 per-entry savepoint（迁移是一次性，批量原子足够）
        if (insertLogInner(db, e)) imported++;
        else skipped++;
      } catch (err) {
        errors++;
        dbg('迁移单条失败 id=%s: %O', e?.id, err);
      }
    }
  });

  for (const file of files) {
    const filePath = join(logDir, file);
    let content: string;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch (err) {
      dbg('读取迁移文件失败 %s: %O', file, err);
      errors++;
      continue;
    }
    const lines = content.split('\n');
    let batch: RawLogEntry[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        batch.push(JSON.parse(trimmed) as RawLogEntry);
        if (batch.length >= BATCH) { tx(batch); batch = []; }
      } catch {
        errors++;
      }
    }
    if (batch.length) tx(batch);
    if (onProgress) onProgress(imported + skipped, imported + skipped, file);
  }

  dbg('迁移完成: imported=%d skipped=%d errors=%d files=%d', imported, skipped, errors, files.length);
  return { imported, skipped, files: files.length, errors };
}

// ==================== 读取 ====================

/**
 * 把用户输入转成 FTS5 MATCH 安全的查询串：
 * 按空白拆 token，每个 token 包成双引号短语（trigram 下即子串匹配），
 * 转义内部双引号（" → ""），token 间空格 = AND。
 * 这样含 / - * 等操作符字符的查询（如 model 名）也不会触发 FTS5 语法错误。
 */
function buildFtsQuery(input: string): string {
  return input
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(t => '"' + t.replace(/"/g, '""') + '"')
    .join(' ');
}

function applyFilter(filter: ListFilter, where: string[], params: unknown[]): void {
  if (filter.agentType && filter.agentType !== 'all') { where.push('agent_type = ?'); params.push(filter.agentType); }
  if (filter.providerName) { where.push('provider_name = ?'); params.push(filter.providerName); }
  if (filter.endpointType) { where.push('endpoint_type = ?'); params.push(filter.endpointType); }
  if (filter.startDate) { where.push('timestamp >= ?'); params.push(filter.startDate); }
  if (filter.endDate) { where.push('timestamp <= ?'); params.push(filter.endDate); }
}

/** 列表/检索统一返回：行 + 总数（「N 条」展示用）+ 下一页 keyset 游标 + 是否还有更多 */
export interface PageResult {
  logs: LogRow[];
  total: number;
  nextCursor: string | null;
  hasMore: boolean;
}

const LOG_COLS = `rowid, id, timestamp, agent_type, client_type, provider_name, endpoint_type,
            model, status, duration, is_stream, is_test, thread_id, error,
            input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens`;

const LOG_COLS_L = LOG_COLS.replace(/\b(rowid|id|timestamp|agent_type|client_type|provider_name|endpoint_type|model|status|duration|is_stream|is_test|thread_id|error|input_tokens|output_tokens|cache_read_tokens|cache_creation_tokens)\b/g, 'l.$1');

/**
 * keyset 分页游标：编码「上一页最后一条」的 (timestamp, id) 为不透明 token。
 * 排序为 timestamp DESC, id DESC（id 唯一，作稳定 tiebreaker），故「下一页更早」
 * = timestamp 更小，或 timestamp 相同且 id 更小。OFFSET 深翻会线性扫跳过行，
 * keyset 用索引直接定位，深页不退化。
 */
export function encodeCursor(ts: string, id: string): string {
  return Buffer.from(JSON.stringify({ ts, id }), 'utf-8').toString('base64url');
}
/** 解码游标；缺失或非法返回 null（调用方按无游标的首页处理） */
export function decodeCursor(token?: string | null): { ts: string; id: string } | null {
  if (!token) return null;
  try {
    const o = JSON.parse(Buffer.from(token, 'base64url').toString('utf-8'));
    if (o && typeof o.ts === 'string' && typeof o.id === 'string') return o;
    return null;
  } catch {
    return null;
  }
}

/** 列表查询（索引-backed 排序/过滤；cursor=keyset 深分页，无 cursor=OFFSET 旧模式供 bench/旧调用） */
export function listLogs(
  db: DB,
  opts: { limit: number; offset?: number; cursor?: string; filter?: ListFilter },
): PageResult {
  const filterWhere: string[] = [];
  const filterParams: unknown[] = [];
  if (opts.filter) applyFilter(opts.filter, filterWhere, filterParams);
  const filterClause = filterWhere.length ? `WHERE ${filterWhere.join(' AND ')}` : '';

  // total：全量命中数（不含 keyset 限制，供「N 条」展示）
  const total = (db.prepare(`SELECT COUNT(*) AS c FROM logs ${filterClause}`).get(...filterParams) as { c: number }).c;

  const cur = decodeCursor(opts.cursor);
  // 显式 offset（bench / 旧调用）走 OFFSET；否则 keyset（首页无 cursor、续页有 cursor，LIMIT+1 探测 hasMore）
  if (opts.offset == null || cur) {
    const where = [...filterWhere];
    const params = [...filterParams];
    if (cur) { where.push('(timestamp < ? OR (timestamp = ? AND id < ?))'); params.push(cur.ts, cur.ts, cur.id); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = db.prepare(
      `SELECT ${LOG_COLS} FROM logs ${clause} ORDER BY timestamp DESC, id DESC LIMIT ?`,
    ).all(...params, opts.limit + 1) as LogRow[];
    const hasMore = rows.length > opts.limit;
    const logs = hasMore ? rows.slice(0, opts.limit) : rows;
    const last = logs[logs.length - 1];
    const nextCursor = hasMore && last ? encodeCursor(last.timestamp, last.id) : null;
    return { logs, total, nextCursor, hasMore };
  }

  // OFFSET 旧模式
  const logs = db.prepare(
    `SELECT ${LOG_COLS} FROM logs ${filterClause} ORDER BY timestamp DESC, id DESC LIMIT ? OFFSET ?`,
  ).all(...filterParams, opts.limit, opts.offset ?? 0) as LogRow[];
  return { logs, total, nextCursor: null, hasMore: logs.length >= opts.limit };
}

/**
 * 全文检索。query ≥3 字符走 FTS5 trigram（倒排）；<3 字符回退 LIKE（单列扫，仍优于全量重解析）。
 * 同 listLogs 支持 keyset 游标（深分页）与 OFFSET 旧模式。
 */
export function searchLogs(
  db: DB,
  query: string,
  opts: { limit: number; offset?: number; cursor?: string; filter?: ListFilter },
): PageResult {
  const filterWhere: string[] = [];
  const filterParams: unknown[] = [];
  if (opts.filter) applyFilter(opts.filter, filterWhere, filterParams);
  const andFilter = filterWhere.length ? `AND ${filterWhere.join(' AND ')}` : '';
  const trimmed = query.trim();
  const cur = decodeCursor(opts.cursor);
  const andKeyset = cur ? 'AND (l.timestamp < ? OR (l.timestamp = ? AND l.id < ?))' : '';
  const keysetParams = cur ? [cur.ts, cur.ts, cur.id] : [];
  const useFts = trimmed.length >= 3;

  // total：全量命中数（不含 keyset 限制）
  const total = useFts
    ? (db.prepare(`SELECT COUNT(*) AS c FROM logs_fts f JOIN logs l ON l.rowid = f.rowid WHERE logs_fts MATCH ? ${andFilter}`).get(buildFtsQuery(trimmed), ...filterParams) as { c: number }).c
    : (db.prepare(`SELECT COUNT(*) AS c FROM log_bodies b JOIN logs l ON l.rowid = b.log_rowid WHERE b.search_text LIKE ? ${andFilter}`).get(`%${trimmed}%`, ...filterParams) as { c: number }).c;

  const baseFrom = useFts
    ? `FROM logs_fts f JOIN logs l ON l.rowid = f.rowid WHERE logs_fts MATCH ?`
    : `FROM log_bodies b JOIN logs l ON l.rowid = b.log_rowid WHERE b.search_text LIKE ?`;
  const leadParam = useFts ? buildFtsQuery(trimmed) : `%${trimmed}%`;

  if (opts.offset == null || cur) {
    // keyset：首页无 cursor、续页有 cursor；LIMIT+1 探测 hasMore
    const rows = db.prepare(
      `SELECT ${LOG_COLS_L} ${baseFrom} ${andFilter} ${andKeyset} ORDER BY l.timestamp DESC, l.id DESC LIMIT ?`,
    ).all(leadParam, ...filterParams, ...keysetParams, opts.limit + 1) as LogRow[];
    const hasMore = rows.length > opts.limit;
    const logs = hasMore ? rows.slice(0, opts.limit) : rows;
    const last = logs[logs.length - 1];
    const nextCursor = hasMore && last ? encodeCursor(last.timestamp, last.id) : null;
    return { logs, total, nextCursor, hasMore };
  }

  // OFFSET 旧模式
  const logs = db.prepare(
    `SELECT ${LOG_COLS_L} ${baseFrom} ${andFilter} ORDER BY l.timestamp DESC, l.id DESC LIMIT ? OFFSET ?`,
  ).all(leadParam, ...filterParams, opts.limit, opts.offset ?? 0) as LogRow[];
  return { logs, total, nextCursor: null, hasMore: logs.length >= opts.limit };
}

/** 按 id 取详情（主键 + bodies），返回重建所需全部字段 */
export function getLogById(db: DB, id: string): { row: LogRow; request: string; response: string; search_text: string } | null {
  const row = db.prepare(
    `SELECT l.rowid, l.id, l.timestamp, l.agent_type, l.client_type, l.provider_name, l.endpoint_type,
            l.model, l.status, l.duration, l.is_stream, l.is_test, l.thread_id, l.error,
            l.input_tokens, l.output_tokens, l.cache_read_tokens, l.cache_creation_tokens,
            b.request, b.response, b.search_text
     FROM logs l JOIN log_bodies b ON b.log_rowid = l.rowid
     WHERE l.id = ?`,
  ).get(id) as (LogRow & { request: string; response: string; search_text: string }) | undefined;
  if (!row) return null;
  const { request, response, search_text, ...logRow } = row;
  return { row: logRow as LogRow, request, response, search_text };
}

/** 按 rowid 取 bodies（用于按 rowid 重建） */
export function getBodiesByRowid(db: DB, rowid: number): { request: string; response: string; search_text: string } | null {
  const row = db.prepare(`SELECT request, response, search_text FROM log_bodies WHERE log_rowid = ?`).get(rowid) as { request: string; response: string; search_text: string } | undefined;
  return row ?? null;
}

/**
 * 批量取一组 rowid 的 bodies（列表查询只取小列，分页后再批量拉 bodies 重建）。
 * 避免 JOIN 在 LIMIT 前把全量 body 拖进来——保证 O(页大小) body 读。
 */
export function fetchBodies(db: DB, rowids: number[]): Map<number, { request: string; response: string }> {
  const map = new Map<number, { request: string; response: string }>();
  if (rowids.length === 0) return map;
  const placeholders = rowids.map(() => '?').join(',');
  const rows = db.prepare(`SELECT log_rowid, request, response FROM log_bodies WHERE log_rowid IN (${placeholders})`).all(...rowids) as { log_rowid: number; request: string; response: string }[];
  for (const r of rows) map.set(r.log_rowid, { request: r.request, response: r.response });
  return map;
}

// ==================== 统计 / 清空 ====================

/** 统计：条数 + 最旧/最新时间戳 */
export function getStats(db: DB): { count: number; oldest: string | null; newest: string | null } {
  const row = db.prepare(`SELECT COUNT(*) AS c, MIN(timestamp) AS oldest, MAX(timestamp) AS newest FROM logs`).get() as { c: number; oldest: string | null; newest: string | null };
  return { count: row.c, oldest: row.oldest, newest: row.newest };
}

/** 清空所有日志（logs 级联 log_bodies，FTS 手动清），再 VACUUM 回收空间 */
export function clearAllLogs(db: DB): number {
  const n = countLogs(db);
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM logs_fts`).run();
    db.prepare(`DELETE FROM logs`).run(); // ON DELETE CASCADE 清 log_bodies
  });
  tx();
  db.exec('VACUUM');
  dbg('清空全部日志: 删除 %d 行', n);
  return n;
}

// ==================== 保留期清理 ====================

/** 删除早于 cutoff 的日志（级联 log_bodies + 手动删 FTS） */
export function deleteOldLogs(db: DB, cutoffISO: string): number {
  const tx = db.transaction(() => {
    const rowids = db.prepare(`SELECT rowid FROM logs WHERE timestamp < ?`).all(cutoffISO) as { rowid: number }[];
    if (rowids.length === 0) return 0;
    const idList = rowids.map(r => r.rowid).join(',');
    db.prepare(`DELETE FROM logs_fts WHERE rowid IN (${idList})`).run();
    db.prepare(`DELETE FROM logs WHERE rowid IN (${idList})`).run(); // ON DELETE CASCADE 清 log_bodies
    return rowids.length;
  });
  const n = tx();
  dbg('保留期清理: 删除 %d 行 (cutoff=%s)', n, cutoffISO);
  return n;
}

/** 重建碎片空间（低频调用，如每日清理后） */
export function vacuum(db: DB): void {
  db.exec('VACUUM');
}

/** 日志条数（统计用） */
export function countLogs(db: DB): number {
  return (db.prepare(`SELECT COUNT(*) AS c FROM logs`).get() as { c: number }).c;
}
