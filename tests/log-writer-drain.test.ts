/**
 * log-writer drainWriteQueue timer 清理回归（Bug #5：timer 泄漏被动延迟 shutdown）
 *
 * 现状（bug）：drainWriteQueue 用 Promise.race([writeQueue, timer])，writeQueue 先 resolve 时
 * setTimeout 句柄未 clear，shutdown 被动延迟最长 DRAIN_TIMEOUT_MS（5s）才退出。
 * 修复：拿到 timer 句柄，race 结束后（finally）clearTimeout。
 *
 * 用 fake timer + spy 断言：writeQueue 先 resolve 时 drain 创建的那个 timer 句柄被显式 clearTimeout。
 * 修复前无 finally → clearTimeout 不会被调用；修复后 finally 必清。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../server/services/db.js', () => ({
  insertLog: vi.fn(),
  deleteOldLogs: vi.fn(),
  deleteExpiredLogs: vi.fn(),
  vacuum: vi.fn(),
}));
vi.mock('../server/services/db-instance.js', () => ({
  initDb: vi.fn(),
  getDb: vi.fn(() => ({})),
}));
vi.mock('../server/sse-bus.js', () => ({ broadcastLog: vi.fn() }));
vi.mock('../server/services/log-reader.js', () => ({
  invalidateCache: vi.fn(),
  normalizeLogEntry: vi.fn((x: unknown) => x),
}));
vi.mock('../server/config.js', () => ({
  getLogMode: vi.fn(() => 'archive'),
  getTempTtlMinutes: vi.fn(() => 60),
  getRetentionDays: vi.fn(() => 3),
}));

import { drainWriteQueue, writeLogEntry } from '../server/services/log-writer.js';
import { insertLog } from '../server/services/db.js';
import type { RawLogEntry } from '../server/types.js';

function makeEntry(): RawLogEntry {
  return {
    id: 'test-drain',
    timestamp: '2026-07-19T00:00:00.000Z',
    project: '',
    url: 'https://api.anthropic.com/v1/messages',
    method: 'POST',
    headers: {},
    body: { model: 'claude-3-5-sonnet-20241022', messages: [{ role: 'user', content: 'hi' }] },
    response: { status: 200, statusText: 'OK', headers: {}, body: {} },
    duration: 10,
    isStream: false,
    mainAgent: true,
    agentType: 'main',
    isTest: true,
  } as unknown as RawLogEntry;
}

describe('drainWriteQueue — writeQueue 先 resolve 时清掉 timer（Bug #5）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(insertLog).mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('入队一条写入（快速完成）→ drain 创建的唯一 timer 被显式 clearTimeout', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

    // 入队一条写入（insertLog 已 mock 为 noop），writeQueue 短暂 pending 后 resolve
    writeLogEntry(makeEntry());

    const drainP = drainWriteQueue();
    await drainP; // 微任务刷新：writeQueue 完成 → race 经 writeQueue resolve → finally clearTimeout

    // 入队的写入确实落地（drain 等的是真实排空，不是空队列）
    expect(insertLog).toHaveBeenCalledTimes(1);

    // drain 创建了唯一的超时 timer（writeLogEntry 路径无其他 setTimeout）
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
    const handle = setTimeoutSpy.mock.results[0].value;

    // 关键断言：writeQueue 先 resolve → timer 必须被显式清掉，否则 shutdown 被动延迟 5s
    expect(clearTimeoutSpy).toHaveBeenCalledWith(handle);

    setTimeoutSpy.mockRestore();
    clearTimeoutSpy.mockRestore();
  });

  it('空队列（writeQueue 已 resolved）drain 也立即清掉新建的 timer', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

    await drainWriteQueue();

    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
    const handle = setTimeoutSpy.mock.results[0].value;
    expect(clearTimeoutSpy).toHaveBeenCalledWith(handle);

    setTimeoutSpy.mockRestore();
    clearTimeoutSpy.mockRestore();
  });
});
