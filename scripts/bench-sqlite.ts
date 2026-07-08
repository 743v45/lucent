/**
 * 改造后基准：SQLite 存储层（db.ts）
 *
 * 在同一合成语料上：
 *   - 一次性迁移导入（计时 + 导入数 + 库体积）
 *   - 列表/检索/getById 查询延迟与堆内存
 *   - 重点验证：正文锚点检索能命中（现状 0 命中）
 *
 * 用法：npx tsx scripts/bench-sqlite.ts
 */
import { rmSync, existsSync, statSync } from 'node:fs';
import { openDb, migrateFromJsonl, listLogs, searchLogs, getLogById, countLogs } from '../server/services/db.js';

process.env.LUCENT_LOG_DIR = process.env.LUCENT_LOG_DIR || 'bench/logs';
const DB_PATH = 'bench/lucent.db';
const LOG_DIR = process.env.LUCENT_LOG_DIR;

function heapMB(): number {
  return Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
}
function nowNs(): bigint {
  return process.hrtime.bigint();
}
function ms(ns: bigint): number {
  return Number(ns) / 1e6;
}
function time<T>(fn: () => T): { result: T; ms: number; heapAfter: number } {
  const t0 = nowNs();
  const result = fn();
  return { result, ms: ms(nowNs() - t0), heapAfter: heapMB() };
}
function dbSizeMB(): number {
  let sum = 0;
  for (const ext of ['', '-wal', '-shm']) {
    if (existsSync(DB_PATH + ext)) sum += statSync(DB_PATH + ext).size;
  }
  return Math.round(sum / 1024 / 1024);
}

if (existsSync(DB_PATH)) {
  for (const ext of ['', '-wal', '-shm']) {
    if (existsSync(DB_PATH + ext)) rmSync(DB_PATH + ext);
  }
}

const baseHeap = heapMB();
console.log(`[sqlite] baseHeap=${baseHeap}MB  logDir=${LOG_DIR}  dbPath=${DB_PATH}`);

const db = openDb(DB_PATH);

// 1. 迁移
if (typeof globalThis.gc === 'function') globalThis.gc();
const mig = time(() => migrateFromJsonl(db, LOG_DIR!));
console.log(`[sqlite] migrate     ${mig.ms.toFixed(0)}ms  heap=${mig.heapAfter}MB  imported=${mig.result.imported} skipped=${mig.result.skipped} errors=${mig.result.errors} files=${mig.result.files}`);
console.log(`[sqlite] db size=${dbSizeMB()}MB  count=${countLogs(db)}`);

// checkpoint 把 wal 并入主库后再看主库体积
db.pragma('wal_checkpoint(TRUNCATE)');
console.log(`[sqlite] db size after checkpoint=${dbSizeMB()}MB`);

// 2. 冷列表（首次查询，无任何进程级缓存——DB 本身即索引）
const cold = time(() => listLogs(db, { limit: 50, offset: 0 }));
console.log(`[sqlite] list cold   ${cold.ms.toFixed(0)}ms  heap=${cold.heapAfter}MB  total=${cold.result.total} returned=${cold.result.logs.length}`);
const sampleId = cold.result.logs[0]?.id;
const sampleModel = cold.result.logs[0]?.model ?? 'claude';

// 3. 热列表（keyset 分页：取下一页）
const firstTs = cold.result.logs[cold.result.logs.length - 1]?.timestamp;
const warm = time(() => listLogs(db, { limit: 50, offset: 50 }));
console.log(`[sqlite] list warm   ${warm.ms.toFixed(0)}ms  heap=${warm.heapAfter}MB  (offset 分页)`);
const keyset = time(() => listLogs(db, { limit: 50, offset: 0, filter: { endDate: firstTs } }));
console.log(`[sqlite] list keyset ${keyset.ms.toFixed(0)}ms  heap=${keyset.heapAfter}MB  total=${keyset.result.total}`);

// 4. search 命中（model，与现状同字段对比）
const sHit = time(() => searchLogs(db, sampleModel!, { limit: 50, offset: 0 }));
console.log(`[sqlite] search hit  ${sHit.ms.toFixed(0)}ms  heap=${sHit.heapAfter}MB  term="${sampleModel}" total=${sHit.result.total}`);

// 5. search 正文锚点（现状 0 命中，FTS 应命中）
const sBody = time(() => searchLogs(db, '基准锚点中文', { limit: 50, offset: 0 }));
console.log(`[sqlite] search body ${sBody.ms.toFixed(0)}ms  heap=${sBody.heapAfter}MB  term="基准锚点中文" total=${sBody.result.total} (现状=0)`);

// 5b. search 英文正文锚点
const sBodyEn = time(() => searchLogs(db, 'BENCHNEEDLE-EN', { limit: 50, offset: 0 }));
console.log(`[sqlite] search bodyEN ${sBodyEn.ms.toFixed(0)}ms  heap=${sBodyEn.heapAfter}MB  term="BENCHNEEDLE-EN" total=${sBodyEn.result.total}`);

// 5c. 2 字符回退 LIKE
const s2 = time(() => searchLogs(db, '代理', { limit: 50, offset: 0 }));
console.log(`[sqlite] search 2char ${s2.ms.toFixed(0)}ms  heap=${s2.heapAfter}MB  term="代理" total=${s2.result.total} (LIKE 回退)`);

// 6. search 未命中
const sMiss = time(() => searchLogs(db, 'zzznomatchzzz', { limit: 50, offset: 0 }));
console.log(`[sqlite] search miss ${sMiss.ms.toFixed(0)}ms  heap=${sMiss.heapAfter}MB  total=${sMiss.result.total}`);

// 7. getLogById（主键直查）
const byId = time(() => getLogById(db, sampleId!));
console.log(`[sqlite] getLogById  ${byId.ms.toFixed(0)}ms  heap=${byId.heapAfter}MB  found=${!!byId.result}`);

// 8. 重复列表取均值
const reps = 5;
let sum = 0;
for (let i = 0; i < reps; i++) {
  const r = time(() => listLogs(db, { limit: 50, offset: 0 }));
  sum += r.ms;
}
console.log(`[sqlite] list x${reps} avg=${(sum / reps).toFixed(0)}ms`);

db.close();
