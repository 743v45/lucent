import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { create, act } from 'react-test-renderer';
import * as React from 'react';

// mock getLogs：路径相对 tests/ → src/utils/api，与 hook 内 '../utils/api' 解析到同一文件
vi.mock('../src/utils/api', () => ({ getLogs: vi.fn() }));

import { useLogs } from '../src/hooks/useLogs';
import { getLogs } from '../src/utils/api';
import type { LogEntry } from '../src/types';

const mockedGetLogs = vi.mocked(getLogs);

/** 构造一页 N 条最小可用 LogEntry（formatLog 不崩） */
function makePage(count: number, idFrom: number): any[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `id-${String(idFrom + i).padStart(4, '0')}`,
    timestamp: '2026-01-01T00:00:00.000Z',
    request: { method: 'POST', url: '/v1/messages', headers: {}, body: { model: 'm', messages: [] } },
    response: { status: 200, statusText: 'OK', headers: {}, body: { id: 'r', type: 'message', role: 'assistant', content: [] } },
    providerName: 'all',
    endpointType: 'all',
  }));
}

/** flush 宏任务队列（real timers 下让被 mock 的 getLogs 立即 resolve） */
const flush = () => new Promise(r => setTimeout(r, 0));
/** 仅排空微任务（fake timers 下 setTimeout 不会自动触发，用 microtask drain 让 async getLogs resolve） */
const flushMicro = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

/** renderHook 等价：用 react-test-renderer 挂一个只调用 hook 的空组件 */
function renderHook<T>(fn: () => T) {
  const result = { current: undefined as T };
  function Probe() { result.current = fn(); return null; }
  let renderer: any;
  act(() => { renderer = create(React.createElement(Probe)); });
  return { result, unmount: () => act(() => renderer.unmount()) };
}

/** 带 listener 捕获的 EventSource 桩：测试可主动 emit('error'/'log') 触发回调 */
class FakeEventSource {
  listeners: Record<string, Array<(e: any) => void>> = {};
  closed = false;
  addEventListener(ev: string, cb: (e: any) => void) {
    (this.listeners[ev] ||= []).push(cb);
  }
  removeEventListener(ev: string, cb: (e: any) => void) {
    this.listeners[ev] = (this.listeners[ev] || []).filter(f => f !== cb);
  }
  emit(ev: string, e: any) {
    (this.listeners[ev] || []).forEach(cb => cb(e));
  }
  close() { this.closed = true; }
}

let esInstances: FakeEventSource[] = [];

beforeEach(() => {
  mockedGetLogs.mockReset();
  esInstances = [];
  (globalThis as any).EventSource = class extends FakeEventSource {
    constructor(_url: string) { super(); esInstances.push(this); }
  };
});
afterEach(() => {
  delete (globalThis as any).EventSource;
});

describe('Bug#22 nowTick 级联重算 — 无 expiresAt 时 visibleLogs 保持原引用', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('本分钟无日志过期且无 expiresAt 项 → nowTick 推进后 logs 引用不变', async () => {
    mockedGetLogs.mockImplementation(async () => ({
      total: 2, nextCursor: null, hasMore: false, logs: makePage(2, 1),
    }));

    const { result, unmount } = renderHook(() =>
      useLogs({ search: '', providerName: 'all', endpointType: 'all' }),
    );
    await act(async () => { await flushMicro(); });
    expect(result.current!.logs).toHaveLength(2);
    const ref1 = result.current!.logs;

    // 推进 60s → nowTick++ → visibleLogs useMemo 重算
    await act(async () => { vi.advanceTimersByTime(60_000); await flushMicro(); });
    const ref2 = result.current!.logs;
    // 修复后：无 expiresAt 项 → 直接返回 logs 原引用，不触发下游级联重算（bug 下 filter 每次返回新数组 → ref 变）
    expect(ref2).toBe(ref1);

    unmount();
  });
});

describe('Bug#25 EventSource 错误处理 — 暴露 connectionLost', () => {
  it('SSE error 事件触发 connectionLost=true', async () => {
    mockedGetLogs.mockImplementation(async () => ({ total: 0, nextCursor: null, hasMore: false, logs: [] }));
    const { result, unmount } = renderHook(() =>
      useLogs({ search: '', providerName: 'all', endpointType: 'all' }),
    );
    await act(async () => { await flush(); });
    expect(result.current!.connectionLost).toBe(false);

    await act(async () => { esInstances[0]!.emit('error', {}); });
    expect(result.current!.connectionLost).toBe(true);
    unmount();
  });

  it('连续 5 次 error 后主动 close()（熔断，避免无限重连）', async () => {
    mockedGetLogs.mockImplementation(async () => ({ total: 0, nextCursor: null, hasMore: false, logs: [] }));
    const { result, unmount } = renderHook(() =>
      useLogs({ search: '', providerName: 'all', endpointType: 'all' }),
    );
    await act(async () => { await flush(); });
    const es = esInstances[0]!;
    expect(es.closed).toBe(false);

    await act(async () => {
      for (let i = 0; i < 5; i++) es.emit('error', {});
    });
    expect(es.closed).toBe(true);
    expect(result.current!.connectionLost).toBe(true);
    unmount();
  });
});

describe('Bug#27 loadMore 失败 → setError（不再静默）', () => {
  it('续页请求 reject 时 error 被设置', async () => {
    mockedGetLogs.mockImplementation(async (p: any) => {
      if (!p.cursor) return { total: 10, nextCursor: 'c1', hasMore: true, logs: makePage(2, 1) };
      throw new Error('续页爆炸');
    });

    const { result, unmount } = renderHook(() =>
      useLogs({ search: '', providerName: 'all', endpointType: 'all' }),
    );
    await act(async () => { await flush(); });
    expect(result.current!.error).toBeNull();
    expect(result.current!.logs).toHaveLength(2);

    await act(async () => { await result.current!.loadMore(); });
    expect(result.current!.error).toBe('续页爆炸');
    unmount();
  });
});

describe('Bug#28 loadThread 迭代上限 — 后端 hasMore=true 且 cursor 不变不无限循环', () => {
  it('getLogs 永远返回 hasMore=true 同 cursor → 迭代有上限', async () => {
    mockedGetLogs.mockImplementation(async () => ({
      total: 1, nextCursor: 'same', hasMore: true, logs: makePage(1, 1),
    }));

    const { result, unmount } = renderHook(() =>
      useLogs({ search: '', providerName: 'all', endpointType: 'all' }),
    );
    await act(async () => { await flush(); });

    let ret: LogEntry[] = [];
    await act(async () => { ret = await result.current!.loadThread('thread_x'); });

    const calls = mockedGetLogs.mock.calls.filter(a => a[0]?.threadId === 'thread_x');
    // 迭代上限生效：不会无限循环（无上限时会 hang 直至测试超时）
    expect(calls.length).toBeLessThan(210);
    expect(calls.length).toBeGreaterThan(1);
    // 每页 1 条全量收回（与调用次数一致）
    expect(ret.length).toBe(calls.length);
    unmount();
  });
});
