/**
 * Lucent 查询 CLI 逻辑层（给 AI 用）
 *
 * 设计：commander 只在 bin/cli.ts 负责参数解析；本模块提供纯查询函数（接收 db + 解析后的
 * options，返回结构化对象），便于直接单测，不依赖 spawn 进程。数据访问复用 db.ts 的纯查询
 * 函数 + openDbReadonly 只读句柄，不依赖服务器在跑。
 *
 * 退出码：0 成功（含无结果）/ 2 数据库问题 / 3 参数非法 / 1 其他。
 */

import { join } from 'node:path';
import { CONFIG_DIR } from '../server/constants.js';
import {
  openDbReadonly,
  listLogs,
  searchLogs,
  getLogById,
  getStatsByDimension,
  getStatsDimensionKeys,
  type DB,
  type LogRow,
  type ListFilter,
  type StatsResult,
} from '../server/services/db.js';

// ==================== 错误 / 退出码 ====================

export type ErrorCode = 'db_error' | 'bad_args';

/** 查询错误：带退出码与机读 code，供 CLI 层统一 emit */
export class QueryError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly exitCode: number,
  ) {
    super(message);
    this.name = 'QueryError';
  }
}

// ==================== DB 路径 / 句柄 ====================

/** 解析 db 路径：--db 参数 > LUCENT_DB_PATH > CONFIG_DIR/lucent.db（与服务器一致） */
export function resolveDbPath(override?: string): string {
  return override || process.env.LUCENT_DB_PATH || join(CONFIG_DIR, 'lucent.db');
}

/** 只读开库；失败（文件不存在 / 无法打开）抛 QueryError(db_error) */
export function openQueryDb(dbPath: string): DB {
  try {
    return openDbReadonly(dbPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new QueryError('db_error', `cannot open database: ${dbPath} (${msg})`, 2);
  }
}

// ==================== 时间解析 ====================

const REL_DURATION_RE = /^(\d+)([mhd])$/;

/**
 * 把 --since/--until 值解析成 ISO 字符串。
 * 接受 ISO8601（如 2026-07-29T00:00:00Z）或相对时长（30m / 24h / 7d）。
 * since=now-N，until=now+N。非法抛 QueryError(bad_args)。
 */
export function parseTime(raw: string, kind: 'since' | 'until'): string {
  const s = raw.trim();
  const iso = new Date(s);
  if (!Number.isNaN(iso.getTime())) return iso.toISOString();
  const m = REL_DURATION_RE.exec(s);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2];
    const unitMs = unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
    const base = kind === 'since' ? Date.now() - n * unitMs : Date.now() + n * unitMs;
    return new Date(base).toISOString();
  }
  throw new QueryError('bad_args', `invalid --${kind} value: ${raw} (use ISO or like 7d/24h/30m)`, 3);
}

// ==================== 过滤条件 ====================

/** commander 解析后的过滤选项（camelCase，与 ListFilter 对应） */
export interface ListFilterOptions {
  provider?: string;
  model?: string;
  agentType?: string;
  endpoint?: string;
  status?: string;   // 原始字符串，校验后转 number
  threadId?: string;
  isTest?: boolean;
  since?: string;
  until?: string;
}

/** 把 CLI 过滤选项转成 db.ts 的 ListFilter；status 非整数 / 时间非法抛 QueryError(bad_args) */
export function buildListFilter(opts: ListFilterOptions): ListFilter {
  const filter: ListFilter = {};
  if (opts.provider) filter.providerName = opts.provider;
  if (opts.model) filter.model = opts.model;
  if (opts.agentType && opts.agentType !== 'all') filter.agentType = opts.agentType;
  if (opts.endpoint) filter.endpointType = opts.endpoint;
  if (opts.threadId) filter.threadId = opts.threadId;
  if (opts.isTest != null) filter.isTest = opts.isTest;
  if (opts.status != null && opts.status !== '') {
    const n = Number(opts.status);
    if (!Number.isInteger(n)) throw new QueryError('bad_args', `invalid --status: ${opts.status} (must be integer HTTP code)`, 3);
    filter.status = n;
  }
  if (opts.since) filter.startDate = parseTime(opts.since, 'since');
  if (opts.until) filter.endDate = parseTime(opts.until, 'until');
  return filter;
}

// ==================== limit ====================

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 500;

/** 校验并夹取 limit（默认 20，上限 500，与 Web API 一致） */
export function clampLimit(n: number | undefined): number {
  if (n == null) return DEFAULT_LIMIT;
  if (!Number.isInteger(n) || n < 1) throw new QueryError('bad_args', `invalid --limit: ${n}`, 3);
  return Math.min(n, MAX_LIMIT);
}

// ==================== logs / search ====================

export interface ListQueryOptions extends ListFilterOptions {
  limit?: number;
  cursor?: string;
}

export interface LogsOutput {
  items: LogRow[];
  cursor: string | null;
  count: number;
  total: number;
  has_more: boolean;
}

/** 列表查询（复用 listLogs 的 keyset 分页 + 过滤） */
export function runLogsQuery(db: DB, opts: ListQueryOptions): LogsOutput {
  const limit = clampLimit(opts.limit);
  const filter = buildListFilter(opts);
  const { logs, total, nextCursor, hasMore } = listLogs(db, { limit, cursor: opts.cursor, filter });
  return { items: logs, cursor: nextCursor, count: logs.length, total, has_more: hasMore };
}

/** 全文搜索（复用 searchLogs：≥3 字符走 FTS5，<3 回退 LIKE） */
export function runSearchQuery(db: DB, keyword: string, opts: ListQueryOptions): LogsOutput {
  const trimmed = keyword.trim();
  if (!trimmed) throw new QueryError('bad_args', 'search keyword is empty', 3);
  const limit = clampLimit(opts.limit);
  const filter = buildListFilter(opts);
  const { logs, total, nextCursor, hasMore } = searchLogs(db, trimmed, { limit, cursor: opts.cursor, filter });
  return { items: logs, cursor: nextCursor, count: logs.length, total, has_more: hasMore };
}

// ==================== log 详情 ====================

const DEFAULT_MAX_BODY = 50_000;

export interface DetailOptions {
  id: string;
  body?: boolean;       // 默认 true；--no-body 置 false
  maxBody?: number;     // 默认 50000
  fullBody?: boolean;   // 置 true 时不截断
}

/** 单条详情：全部 LogRow 字段 + body（默认截断到 maxBody）。未找到返回 null（非错误）。 */
export function runLogDetail(db: DB, opts: DetailOptions): Record<string, unknown> | null {
  const raw = getLogById(db, opts.id);
  if (!raw) return null;

  const result: Record<string, unknown> = { ...raw.row };

  const includeBody = opts.body !== false;
  if (includeBody) {
    const max = opts.fullBody ? Infinity : (opts.maxBody ?? DEFAULT_MAX_BODY);
    result.body = truncateBody(raw.request, raw.response, max);
  }
  return result;
}

/** 截断 body：分别序列化 request/response，超 max 截断并标 truncated；未超则返回 parse 后的对象（AI 友好） */
function truncateBody(requestRaw: string, responseRaw: string, max: number): Record<string, unknown> {
  const reqParsed = safeParse(requestRaw);
  const respParsed = safeParse(responseRaw);

  const reqStr = JSON.stringify(reqParsed);
  const respStr = JSON.stringify(respParsed);
  const r = truncateOnce(reqStr, max);
  const s = truncateOnce(respStr, max);

  return {
    request: r.truncated ? r.text : reqParsed,
    response: s.truncated ? s.text : respParsed,
    body_truncated: r.truncated || s.truncated,
  };
}

function safeParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}

function truncateOnce(text: string, max: number): { text: string; truncated: boolean } {
  if (max !== Infinity && text.length > max) return { text: text.slice(0, max), truncated: true };
  return { text, truncated: false };
}

// ==================== stats ====================

export interface StatsQueryOptions extends ListFilterOptions {
  by?: string;
}

/** 维度聚合（默认 model）；未知 --by 抛 QueryError(bad_args) */
export function runStatsQuery(db: DB, opts: StatsQueryOptions): StatsResult {
  const dimension = opts.by ?? 'model';
  if (!getStatsDimensionKeys().includes(dimension)) {
    throw new QueryError('bad_args', `unknown --by: ${dimension} (valid: ${getStatsDimensionKeys().join(', ')})`, 3);
  }
  const filter = buildListFilter(opts);
  return getStatsByDimension(db, { dimension, filter });
}

// ==================== 字段投影 / 输出 ====================

/** --fields 投影：items 每条只保留指定字段（逗号分隔）；未指定则原样返回 */
export function projectFields<T>(items: T[], fields?: string): T[] {
  if (!fields) return items;
  const keys = fields.split(',').map(s => s.trim()).filter(Boolean);
  if (keys.length === 0) return items;
  return items.map(it => {
    const src = it as Record<string, unknown>;
    const o: Record<string, unknown> = {};
    for (const k of keys) if (k in src) o[k] = src[k];
    return o as T;
  });
}

export type OutputFormat = 'json' | 'human';

/** 序列化结果：json（默认，AI 读）或 human（备用人类可读表） */
export function formatOutput(result: unknown, format: OutputFormat): string {
  if (format === 'human') return humanize(result);
  return JSON.stringify(result, null, 2);
}

/** 把错误以机读形式发到 stderr，返回应退出的码 */
export function emitError(err: unknown, format: OutputFormat): number {
  if (err instanceof QueryError) {
    if (format === 'human') console.error(`[lucent] ${err.message}`);
    else console.error(JSON.stringify({ error: err.code, message: err.message }));
    return err.exitCode;
  }
  const msg = err instanceof Error ? err.message : String(err);
  console.error(JSON.stringify({ error: 'internal', message: msg }));
  return 1;
}

// ==================== 顶层编排（commander action 调用） ====================

/** commander 解析后的全部 options（位置参数 id/keyword 由 cli.ts 塞入） */
export interface CommandOptions extends ListQueryOptions {
  db?: string;
  human?: boolean;
  fields?: string;
  by?: string;
  keyword?: string;
  id?: string;
  maxBody?: number;
  fullBody?: boolean;
  body?: boolean;
}

/**
 * 跑一个 query 子命令：open → run → format → print → close → exit。
 * 失败走 emitError + 非零退出。纯查询函数（runLogsQuery 等）单独导出供测试，不经过此函数。
 */
export async function runCommand(kind: 'logs' | 'log' | 'search' | 'stats', opts: CommandOptions): Promise<void> {
  const format: OutputFormat = opts.human ? 'human' : 'json';
  let db: DB | null = null;
  try {
    db = openQueryDb(resolveDbPath(opts.db));
    let result: unknown;
    if (kind === 'logs') {
      const r = runLogsQuery(db, opts);
      result = { ...r, items: projectFields(r.items, opts.fields) };
    } else if (kind === 'search') {
      const r = runSearchQuery(db, opts.keyword ?? '', opts);
      result = { ...r, items: projectFields(r.items, opts.fields) };
    } else if (kind === 'log') {
      result = runLogDetail(db, { id: opts.id ?? '', body: opts.body, maxBody: opts.maxBody, fullBody: opts.fullBody });
    } else {
      result = runStatsQuery(db, opts);
    }
    console.log(formatOutput(result, format));
    db.close();
    process.exit(0);
  } catch (err) {
    if (db) { try { db.close(); } catch { /* 忽略关闭错误 */ } }
    process.exit(emitError(err, format));
  }
}

// ==================== human 可读（备用） ====================

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}

function humanize(result: unknown): string {
  const r = result as Record<string, unknown> | null;
  if (r == null) return 'not found';

  const items = (r as { items?: unknown[] }).items;
  if (Array.isArray(items)) {
    const header = `${pad('timestamp', 24)}  ${pad('provider', 12)}  ${pad('model', 26)}  status  dur(ms)  id`;
    const lines = items.map((it) => {
      const o = it as Record<string, unknown>;
      return `${pad(String(o.timestamp ?? ''), 24)}  ${pad(String(o.provider_name ?? '-'), 12)}  ${pad(String(o.model ?? '-'), 26)}  ${pad(String(o.status ?? '-'), 6)}  ${pad(String(o.duration ?? 0), 8)}  ${o.id ?? ''}`;
    });
    const foot = `${(r as { count?: number }).count ?? items.length} of ${(r as { total?: number }).total ?? '?'} (has_more=${(r as { has_more?: boolean }).has_more ?? false}) cursor=${(r as { cursor?: string }).cursor ?? '-'}`;
    return [header, ...lines, foot].join('\n');
  }

  const buckets = (r as { buckets?: unknown[] }).buckets;
  if (Array.isArray(buckets)) {
    const lines = buckets.map((b) => {
      const o = b as Record<string, unknown>;
      return `${pad(String(o.key ?? '-'), 28)}  count=${o.count}  in=${o.input_tokens}  out=${o.output_tokens}  dur=${o.total_duration_ms}ms`;
    });
    const t = (r as { totals?: Record<string, unknown> }).totals ?? {};
    return [`by ${(r as { dimension?: string }).dimension}:`, ...lines, `totals: count=${t.count} in=${t.input_tokens} out=${t.output_tokens}`].join('\n');
  }

  // detail
  return Object.entries(r)
    .map(([k, v]) => `${k}: ${typeof v === 'object' && v !== null ? JSON.stringify(v) : v}`)
    .join('\n');
}
