/**
 * 临时日志清理定时器调度器单测（temp-cleanup-scheduler.ts）
 *
 * 覆盖按 logMode 自适应启停的核心行为：
 * - temporary：常驻，按周期持续触发
 * - off/archive 且无临时行：启动清一次后自停
 * - off/archive 但有未到期存量：续跑，存量清完才自停（自停判定用 count=0 而非「删 0 行」）
 * - start 幂等：重复调用不新增定时器
 *
 * cleanupExpiredLogs / getLogMode 被 mock（行为由 db.test 的 deleteExpiredLogs/countTemporaryLogs
 * 单独覆盖）；countTemporaryLogs 走真实库（initDb 单例），用 cleanupMock 调用次数间接观测
 * 定时器是否在跑 / 是否已自停。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { getLogModeMock, cleanupMock } = vi.hoisted(() => ({
  getLogModeMock: vi.fn<[], 'off' | 'temporary' | 'archive'>(),
  cleanupMock: vi.fn(),
}));

vi.mock('../server/services/log-writer.js', () => ({ cleanupExpiredLogs: cleanupMock }));
vi.mock('../server/config.js', () => ({ getLogMode: getLogModeMock }));

import { initDb, closeDb, getDb } from '../server/services/db-instance.js';
import { startTempCleanupTimer, stopTempCleanupTimer } from '../server/services/temp-cleanup-scheduler.js';

let dir: string;

beforeEach(() => {
  vi.useFakeTimers();
  dir = mkdtempSync(join(tmpdir(), 'lucent-sched-'));
  initDb(join(dir, 'test.db'));
  cleanupMock.mockClear();
  getLogModeMock.mockReset();
});

afterEach(() => {
  stopTempCleanupTimer();
  closeDb();
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

/** 直接插一行控制 expires_at（绕过 insertLog 的完整 entry，countTemporaryLogs 只看 expires_at） */
function insertRow(id: string, expiresAt: string | null): void {
  getDb().prepare(`INSERT INTO logs (id, timestamp, expires_at) VALUES (?, ?, ?)`)
    .run(id, '2026-07-08T00:00:00.000Z', expiresAt);
}

describe('temp-cleanup-scheduler — 按 logMode 自适应启停', () => {
  it('off + 空库：启动清一次后立即自停，后续周期不再触发', () => {
    getLogModeMock.mockReturnValue('off');
    startTempCleanupTimer();
    expect(cleanupMock).toHaveBeenCalledTimes(1); // 启动 tick
    vi.advanceTimersByTime(3 * 180_000); // 推进 3 周期
    expect(cleanupMock).toHaveBeenCalledTimes(1); // 已自停，未再触发
  });

  it('temporary：常驻，按周期持续触发（即使本次删 0 行也不停）', () => {
    getLogModeMock.mockReturnValue('temporary');
    startTempCleanupTimer();
    vi.advanceTimersByTime(3 * 180_000);
    expect(cleanupMock).toHaveBeenCalledTimes(4); // 启动1 + 3 周期
  });

  it('start 幂等：重复调用不新增定时器', () => {
    getLogModeMock.mockReturnValue('temporary');
    startTempCleanupTimer();
    startTempCleanupTimer(); // 幂等：timer 已存在，不重复 setInterval（但各自 start 的启动 tick 仍执行）
    vi.advanceTimersByTime(180_000);
    // 启动 tick(1) + 1 周期(1) = 2（第二次 start 幂等 no-op，不 tick）；若非幂等（2 个 timer）会是 1 + 2 = 3
    expect(cleanupMock).toHaveBeenCalledTimes(2);
  });

  it('off + 未到期存量：定时器续跑，存量清完后才自停（核心正确性）', () => {
    getLogModeMock.mockReturnValue('off');
    insertRow('live', '2099-12-31T00:00:00.000Z'); // 未到期临时行（count=1）
    startTempCleanupTimer(); // 启动 tick：count=1 ≠ 0，off 也不自停
    vi.advanceTimersByTime(2 * 180_000); // 2 周期，count 仍为 1
    expect(cleanupMock).toHaveBeenCalledTimes(3); // 启动1 + 2，未自停

    // 模拟存量被清完（未到期行最终过期删除）
    getDb().prepare(`DELETE FROM logs`).run();
    vi.advanceTimersByTime(180_000); // 下个周期 tick：count=0, off → 自停
    expect(cleanupMock).toHaveBeenCalledTimes(4);
    vi.advanceTimersByTime(3 * 180_000); // 自停后不再触发
    expect(cleanupMock).toHaveBeenCalledTimes(4);
  });

  it('archive 模式同样触发自停（非 temporary 即无临时增量）', () => {
    getLogModeMock.mockReturnValue('archive');
    startTempCleanupTimer();
    expect(cleanupMock).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2 * 180_000);
    expect(cleanupMock).toHaveBeenCalledTimes(1); // archive + 空库 → 启动即自停
  });
});
