/**
 * SSE 总线健壮性单测（Bug #2 心跳裸 write / Bug #5 背压慢泄漏 + 连接数上限）
 *
 * 重点：
 * - writeSse 捕获 res.write 同步抛错，不向调用方冒泡（避免 uncaughtException 拖垮进程）
 * - 持续背压（write 持续返回 false）的客户端达阈值后被剔除 + destroy
 * - registerSseClient 超 MAX_SSE_CLIENTS 返回 false（供 stream 路由回 503）
 * - destroySseClient 统一清理（注销 + 清背压状态 + destroy），幂等，缺 destroy 守卫
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  writeSse,
  destroySseClient,
  registerSseClient,
  unregisterSseClient,
  broadcastLog,
  getSseClientCount,
  MAX_SSE_CLIENTS,
} from '../server/sse-bus.js';
import type { LogEntry } from '../server/types.js';

type MockRes = import('express').Response & {
  writes: string[];
  isDestroyed: () => boolean;
  emit: (evt: string, ...args: unknown[]) => void;
};

/** 构造 mock Response：write 行为可配置（成功 / 抛错 / 背压） */
function mockRes(opts: { throws?: boolean; backpressure?: boolean } = {}): MockRes {
  const writes: string[] = [];
  let destroyed = false;
  const onFns: Record<string, Array<(...a: unknown[]) => void>> = {};
  const obj = {
    write: vi.fn((data: string) => {
      if (opts.throws) throw new Error('write EPIPE');
      writes.push(data);
      return !opts.backpressure; // 背压时返回 false
    }),
    destroy: vi.fn(() => {
      destroyed = true;
    }),
    on: vi.fn((evt: string, cb: (...a: unknown[]) => void) => {
      (onFns[evt] ??= []).push(cb);
      return obj;
    }),
    isDestroyed: () => destroyed,
    emit: (evt: string, ...args: unknown[]) => (onFns[evt] || []).forEach(cb => cb(...args)),
    get writes() {
      return writes;
    },
  };
  return obj as unknown as MockRes;
}

const registered: MockRes[] = [];

beforeEach(() => {
  registered.length = 0;
});

afterEach(() => {
  // 清理本轮注册的客户端，避免污染模块级 clients 集合
  for (const res of registered) {
    destroySseClient(res);
  }
  registered.length = 0;
  expect(getSseClientCount()).toBe(0);
});

/** 注册并记录，便于 afterEach 统一清理 */
function track(res: MockRes): boolean {
  registered.push(res);
  return registerSseClient(res);
}

describe('writeSse — 单点写入守卫', () => {
  it('成功写入返回 true，payload 原样下发', () => {
    const res = mockRes();
    expect(writeSse(res, 'data: hello\n\n')).toBe(true);
    expect(res.writes).toEqual(['data: hello\n\n']);
  });

  it('捕获 res.write 同步抛错，返回 false，不向调用方冒泡（Bug #2 核心）', () => {
    const res = mockRes({ throws: true });
    expect(() => writeSse(res, ': heartbeat\n\n')).not.toThrow();
    expect(writeSse(res, ': heartbeat\n\n')).toBe(false);
  });
});

describe('broadcastLog — 背压 / 写失败剔除（Bug #5）', () => {
  it('持续背压的客户端达阈值后被剔除 + destroy', () => {
    const slow = mockRes({ backpressure: true }); // write 恒返回 false
    track(slow);
    // 阈值内：客户端仍保留（broadcastLog 不剔除），但本轮 write 失败计数累加
    broadcastLog({ id: 'a' } as LogEntry);
    broadcastLog({ id: 'b' } as LogEntry);
    expect(getSseClientCount()).toBe(1);
    // 达阈值：broadcastLog 剔除 + destroy
    broadcastLog({ id: 'c' } as LogEntry);
    expect(getSseClientCount()).toBe(0);
    expect(slow.isDestroyed()).toBe(true);
  });

  it('单次背压后恢复，不剔除（避免过度剔除瞬时背压）', () => {
    // 自定义 write：前一次 false，之后 true
    let callCount = 0;
    const writes: string[] = [];
    const res = {
      write: vi.fn((data: string) => {
        callCount += 1;
        writes.push(data);
        return callCount !== 1; // 第一次背压，后续正常
      }),
      destroy: vi.fn(),
      on: vi.fn(),
    } as unknown as MockRes;
    track(res);
    broadcastLog({ id: 'x' } as LogEntry); // 背压 1 次
    broadcastLog({ id: 'y' } as LogEntry); // 恢复，streak 清零
    broadcastLog({ id: 'z' } as LogEntry); // 正常
    expect(getSseClientCount()).toBe(1);
    expect((res as any).destroy).not.toHaveBeenCalled();
  });

  it('write 抛错的客户端立即剔除（回归：原 broadcastLog 已有行为）', () => {
    const bad = mockRes({ throws: true });
    track(bad);
    expect(() => broadcastLog({ id: 'z' } as LogEntry)).not.toThrow();
    expect(getSseClientCount()).toBe(0);
    expect((bad as any).write).toHaveBeenCalledTimes(1);
  });
});

describe('registerSseClient — 连接数上限（Bug #5）', () => {
  it('达到 MAX_SSE_CLIENTS 后拒绝新连接（返回 false，不加入集合）', () => {
    expect(MAX_SSE_CLIENTS).toBeGreaterThan(0);
    // 填满连接池
    const pool: MockRes[] = [];
    for (let i = 0; i < MAX_SSE_CLIENTS; i++) {
      const res = mockRes();
      expect(track(res)).toBe(true);
      pool.push(res);
    }
    expect(getSseClientCount()).toBe(MAX_SSE_CLIENTS);
    // 超限：被拒绝
    const overflow = mockRes();
    expect(registerSseClient(overflow)).toBe(false);
    expect(getSseClientCount()).toBe(MAX_SSE_CLIENTS); // 未增加
    // overflow 不应被广播触达
    broadcastLog({ id: 'nope' } as LogEntry);
    expect(overflow.writes).toHaveLength(0);
  });
});

describe('destroySseClient — 统一清理', () => {
  it('注销集合 + 清背压状态 + destroy，幂等', () => {
    const res = mockRes();
    registerSseClient(res);
    expect(getSseClientCount()).toBe(1);
    destroySseClient(res);
    expect(getSseClientCount()).toBe(0);
    expect(res.isDestroyed()).toBe(true);
    // 幂等：再次调用不抛错
    expect(() => destroySseClient(res)).not.toThrow();
  });

  it('缺 destroy 的 mock 也不报错（typeof 守卫）', () => {
    const res = { write: vi.fn(() => true), on: vi.fn() } as unknown as MockRes;
    registerSseClient(res);
    expect(() => destroySseClient(res)).not.toThrow();
    unregisterSseClient(res);
  });
});
