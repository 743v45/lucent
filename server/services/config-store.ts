/**
 * 配置的 SQLite 持久化层（config 表，单行 JSON blob）。
 *
 * 与日志同库（lucent.db），但用**瞬时连接**：每次操作 new Database → 执行 → close，
 * 不复用 db-instance 的日志单例。原因：
 *  - 配置 IO 极低频（loadConfig 读一次 + 偶发 saveConfig），开/关连接开销可忽略；
 *  - 避免单例：单测里 vi.resetModules + 不同 LUCENT_CONFIG_DIR 不会撞上进程级唯一句柄，
 *    测试隔离干净；日志高频写仍走 db-instance 单例（互不影响）。
 *  - WAL 支持多连接并发，配置写与日志写各走各的连接。
 *
 * 本模块只做「哑持久化」：读写 config 表的 JSON blob、生成/解析导入导出载荷。校验与
 * ProxyConfig 类型归 config.ts，故本模块不 import config.ts（避免循环依赖）。
 *
 * DB 路径固定为 LUCENT_DB_PATH || DB_PATH（constants），不依赖 config 内容（鸡生蛋）。
 */
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DB_PATH } from '../constants.js';
import createDebug from 'debug';

const dbg = createDebug('lucent:config-store');

export type ConfigDB = Database.Database;

const CONFIG_ROW_ID = 1;
const CONFIG_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`;

/** 固定 DB 路径：env 优先，否则默认 CONFIG_DIR/lucent.db。不读 config（鸡生蛋）。 */
export function resolveConfigDbPath(): string {
  return process.env.LUCENT_DB_PATH || DB_PATH;
}

/**
 * 打开一个瞬时连接，建 config 表，执行 fn，关闭返回。
 * WAL/synchronous 设定：WAL 持久于库文件（设一次即可，重复设无害）；synchronous=NORMAL 每连接生效。
 */
function withConfigDb<T>(fn: (db: ConfigDB) => T): T {
  const path = resolveConfigDbPath();
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.exec(CONFIG_TABLE_DDL);
    return fn(db);
  } finally {
    db.close();
  }
}

/** 读 config 行的 JSON（未校验）。无行或 JSON 解析失败返回 null（调用方回落默认/迁移）。 */
export function readConfigJson(): unknown | null {
  return withConfigDb((db) => {
    const row = db.prepare('SELECT data FROM config WHERE id = ?').get(CONFIG_ROW_ID) as { data: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.data);
    } catch (e) {
      dbg('config 行 JSON 解析失败（视为空，回落默认/迁移）: %O', e);
      return null;
    }
  });
}

/** 事务覆盖 config 行。调用方须先校验 data。 */
export function writeConfigJson(data: unknown): void {
  withConfigDb((db) => {
    const json = JSON.stringify(data, null, 2);
    const ts = new Date().toISOString();
    const tx = db.transaction(() => {
      db.prepare('INSERT OR REPLACE INTO config (id, data, updated_at) VALUES (?, ?, ?)')
        .run(CONFIG_ROW_ID, json, ts);
    });
    tx();
  });
}

/** 生成可移植 SQL 脚本：幂等建 config 表 + INSERT OR REPLACE 当前行。 */
export function exportConfigSql(): string {
  return withConfigDb((db) => {
    const row = db.prepare('SELECT data, updated_at FROM config WHERE id = ?').get(CONFIG_ROW_ID) as
      | { data: string; updated_at: string } | undefined;
    const data = row?.data ?? JSON.stringify({ note: 'no config stored' });
    const ts = row?.updated_at ?? new Date().toISOString();
    const esc = (s: string) => "'" + s.replace(/'/g, "''") + "'";
    return (
      `-- Lucent 配置导出（config 表，单行 JSON blob）\n` +
      `-- 导入：POST /api/config/import { "payload": "<本文件内容>" }\n` +
      `CREATE TABLE IF NOT EXISTS config (\n` +
      `  id INTEGER PRIMARY KEY CHECK (id = 1),\n` +
      `  data TEXT NOT NULL,\n` +
      `  updated_at TEXT NOT NULL\n` +
      `);\n` +
      `INSERT OR REPLACE INTO config (id, data, updated_at) VALUES (${CONFIG_ROW_ID}, ${esc(data)}, ${esc(ts)});\n`
    );
  });
}

/**
 * 从导入载荷解析出候选 config 对象（未校验）。支持：
 *  - 直接 JSON 对象 / JSON 字符串；
 *  - 导出的 SQL 脚本（正则抽 data 字面量，'' → ' 还原）。
 * 解析失败抛 Error（路由层转 400）。
 */
export function parseImportPayload(payload: unknown): unknown {
  // 1. 对象（express.json 解析后的 JSON 体）
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) return payload;
  // 2. 字符串
  if (typeof payload === 'string') {
    const s = payload.trim();
    // 2a. 直接 JSON
    if (s.startsWith('{')) {
      try {
        return JSON.parse(s);
      } catch {
        // 不是裸 JSON，落到 SQL 抽取
      }
    }
    // 2b. SQL：抽 INSERT [OR REPLACE] INTO config (...) VALUES (1, '<data>', ...)
    const m = s.match(/INSERT(?:\s+OR\s+REPLACE)?\s+INTO\s+config\s*\([^)]*\)\s*VALUES\s*\(\s*1\s*,\s*'((?:[^']|'')*)'/i);
    if (m) {
      const json = m[1].replace(/''/g, "'");
      try {
        return JSON.parse(json);
      } catch (e) {
        throw new Error(`SQL 中 data 不是合法 JSON: ${(e as Error).message}`);
      }
    }
  }
  throw new Error('无法识别的导入载荷：需 JSON 对象/字符串，或导出的 SQL 脚本');
}
