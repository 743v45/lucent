/**
 * SQLite 数据库单例
 *
 * 进程级唯一 DB 句柄：initDb 开库 + 建表，getDb 供 log-writer / log-reader / log-manager 共用，
 * closeDb 在 shutdown 时关（WAL checkpoint 落盘）。
 *
 * 存储语义（决策③：直接替代，无双写）：live 读写只走 SQLite；logs/*.jsonl 为历史备份，
 * 不再被 live 系统读写，也不在启动时迁移。如需导入某批 JSONL，手动调 db.ts 的 migrateFromJsonl。
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { openDb, type DB } from './db.js';
import createDebug from 'debug';

const dbg = createDebug('lucent:db-instance');

let db: DB | null = null;

/**
 * 打开/创建数据库并初始化 schema。进程级单例，重复调用短路返回。
 */
export function initDb(dbPath: string): void {
  if (db) return;
  mkdirSync(dirname(dbPath), { recursive: true });
  db = openDb(dbPath);
  dbg('initDb: dbPath=%s', dbPath);
}

/** 取 DB 句柄（未初始化抛错，尽早暴露调用顺序问题） */
export function getDb(): DB {
  if (!db) throw new Error('DB 未初始化：请先调用 initDb');
  return db;
}

/** 关闭数据库（shutdown 时调用，WAL checkpoint 落盘） */
export function closeDb(): void {
  if (db) {
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
    db = null;
    dbg('数据库已关闭');
  }
}
