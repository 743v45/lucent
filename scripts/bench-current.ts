/**
 * 现状基准：直接调用现有 JSONL readLogs / getLogById
 *
 * 跑在合成语料上（BENCH_LOG_DIR 指向 bench/logs），测：
 *   - 冷列表查询（首次，全量解析）
 *   - 热列表查询（fileCache 命中，但仍内存排序/过滤）
 *   - search 命中 / 未命中（现有 4 字段子串扫）
 *   - getLogById（线性扫文件）
 * 记录每次延迟与堆内存。
 *
 * 用法：npx tsx scripts/bench-current.ts
 */
import { resolveEffectiveConfig } from '../server/config.js';
import * as LogReader from '../server/services/log-reader.js';

process.env.LUCENT_CONFIG_DIR = process.env.LUCENT_CONFIG_DIR || 'bench/cfg';
process.env.LUCENT_LOG_DIR = process.env.LUCENT_LOG_DIR || 'bench/logs';

const cfg = resolveEffectiveConfig();
LogReader.init(cfg);

function heapMB(): number {
  return Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
}
function nowNs(): bigint {
  return process.hrtime.bigint();
}
function ms(ns: bigint): number {
  return Number(ns) / 1e6;
}
async function time<T>(fn: () => Promise<T>): Promise<{ result: T; ms: number; heapAfter: number }> {
  const t0 = nowNs();
  const result = await fn();
  const elapsed = ms(nowNs() - t0);
  return { result, ms: elapsed, heapAfter: heapMB() };
}

async function main() {
  if (typeof globalThis.gc === 'function') globalThis.gc();
  const baseHeap = heapMB();
  console.log(`[current] logDir=${cfg.logDir} baseHeap=${baseHeap}MB`);

  const cold = await time(() => LogReader.readLogs({ limit: 50, offset: 0 }));
  console.log(`[current] list cold   ${cold.ms.toFixed(0)}ms  heap=${cold.heapAfter}MB  total=${cold.result.total} returned=${cold.result.logs.length}`);

  const sampleId = cold.result.logs[0]?.id;
  const sampleModel = cold.result.logs[0]?.metadata.model ?? 'claude';

  const warm = await time(() => LogReader.readLogs({ limit: 50, offset: 50 }));
  console.log(`[current] list warm   ${warm.ms.toFixed(0)}ms  heap=${warm.heapAfter}MB  (cache hit, still full in-mem sort/filter)`);

  const searchHit = await time(() => LogReader.readLogs({ limit: 50, offset: 0, search: sampleModel }));
  console.log(`[current] search hit  ${searchHit.ms.toFixed(0)}ms  heap=${searchHit.heapAfter}MB  term="${sampleModel}" total=${searchHit.result.total}`);

  const searchBody = await time(() => LogReader.readLogs({ limit: 50, offset: 0, search: '基准锚点中文' }));
  console.log(`[current] search body ${searchBody.ms.toFixed(0)}ms  heap=${searchBody.heapAfter}MB  term="基准锚点中文" total=${searchBody.result.total} (现状搜不到正文)`);

  const searchMiss = await time(() => LogReader.readLogs({ limit: 50, offset: 0, search: 'zzznomatchzzz' }));
  console.log(`[current] search miss ${searchMiss.ms.toFixed(0)}ms  heap=${searchMiss.heapAfter}MB  total=${searchMiss.result.total}`);

  const byId = await time(() => LogReader.getLogById(sampleId!));
  console.log(`[current] getLogById  ${byId.ms.toFixed(0)}ms  heap=${byId.heapAfter}MB  found=${!!byId.result}`);

  const reps = 5;
  let warmSum = 0;
  for (let i = 0; i < reps; i++) {
    const r = await time(() => LogReader.readLogs({ limit: 50, offset: 0 }));
    warmSum += r.ms;
  }
  console.log(`[current] list warm x${reps} avg=${(warmSum / reps).toFixed(0)}ms`);
}

main().catch(e => { console.error(e); process.exit(1); });
