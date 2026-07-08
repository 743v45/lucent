/**
 * SQLite 数据库单例
 *
 * 进程级唯一 DB 句柄：initDb 开库 + 建表 + 一次性迁移现有 JSONL（幂等），
 * getDb 供 log-writer / log-reader / log-manager 共用，closeDb 在 shutdown 时关。
 *
 * 迁移语义（决策③：直接替代，无双写）：启动时把 logDir 现有 .jsonl 一次性导入 SQLite，
 * 之后 live 读写只走 SQLite；旧 JSONL 文件留作历史备份，不再被 live 系统读写。
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { openDb, migrateFromJsonl, type DB } from './db.js';
import createDebug from 'debug';

const dbg = createDebug('lucent:db-instance');

let db: DB | null = null;

/**
 * 打开数据库并执行一次性迁移。
 * @returns 迁移结果（imported/skipped/errors/files）
 */
export function initDb(dbPath: string, logDir: string): { imported: number; skipped: number; errors: number; files: number } {
  if (db) return { imported: 0, skipped: 0, errors: 0, files: 0 };
  mkdirSync(dirname(dbPath), { recursive: true });
  db = openDb(dbPath);
  const mig = migrateFromJsonl(db, logDir);
  dbg('initDb: dbPath=%s 迁移 imported=%d skipped=%d errors=%d files=%d',
    dbPath, mig.imported, mig.skipped, mig.errors, mig.files);
  return { imported: mig.imported, skipped: mig.skipped, errors: mig.errors, files: mig.files };
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
