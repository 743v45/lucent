/**
 * 临时日志过期清理定时器调度器
 *
 * 按 logMode 自适应启停（避免 off / archive 模式下空转扫描一个不再增长的库）：
 * - logMode === 'temporary'：定时器持续运行（清增量 + 存量）。
 * - logMode !== 'temporary'（off / archive）：每次清理后，若库内无任何临时行
 *   （countTemporaryLogs === 0，含未到期存量）则 clearInterval 自停；未到期存量行会
 *   继续被定时器等到过期删完才停——故自停判定用 count=0 而非「删除返回 0 行」，
 *   否则关闭时残存的未到期临时行会因本次删 0 而触发自停、永不清理。
 * - 切回 temporary：由 POST /api/recording 路由层调 startTempCleanupTimer()（幂等）重启。
 *
 * 解耦：config.ts 的 setLogMode 不直接操作定时器（避免 config → index 耦合），
 * 重启 hook 由路由层在 setLogMode 成功后触发；本模块单向依赖 Config.getLogMode。
 */

import { cleanupExpiredLogs } from './log-writer.js';
import { countTemporaryLogs } from './db.js';
import { getDb } from './db-instance.js';
import { getLogMode } from '../config.js';
import { TEMP_LOG_CLEANUP_INTERVAL_MS } from '../constants.js';
import createDebug from 'debug';

const dbg = createDebug('lucent:temp-cleanup-scheduler');

let timer: NodeJS.Timeout | null = null;

/** 单次清理 + 自停评估。 */
function tick(): void {
  try {
    cleanupExpiredLogs();
  } catch (err) {
    dbg('定时临时日志清理失败: %O', err);
  }
  // 自停判定：非 temporary 模式（无临时增量）且库内无任何临时行（含未到期存量清完）→ 停。
  if (getLogMode() !== 'temporary') {
    try {
      if (countTemporaryLogs(getDb()) === 0) {
        dbg('非 temporary 模式且临时日志存量已清空，自停定时器');
        stopTempCleanupTimer();
      }
    } catch (err) {
      dbg('自停判定失败: %O', err);
    }
  }
}

/**
 * 启动临时日志清理定时器（幂等：已在跑则 no-op）。
 * 启动时立即清一次（不等首个 tick），随后按 TEMP_LOG_CLEANUP_INTERVAL_MS 周期清理 + 评估自停。
 */
export function startTempCleanupTimer(): void {
  if (timer) return; // 幂等
  timer = setInterval(tick, TEMP_LOG_CLEANUP_INTERVAL_MS);
  timer.unref();
  dbg('临时日志清理定时器已启动（间隔 %dms）', TEMP_LOG_CLEANUP_INTERVAL_MS);
  tick(); // 启动清一次；若 non-temporary 且无存量，tick 内立即自停（此时 timer 已就位可 clearInterval）
}

/** 停止临时日志清理定时器（幂等：未在跑则 no-op）。 */
export function stopTempCleanupTimer(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
    dbg('临时日志清理定时器已停止');
  }
}
