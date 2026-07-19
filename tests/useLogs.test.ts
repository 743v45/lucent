import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { create, act } from 'react-test-renderer';
import * as React from 'react';

// mock getLogs：路径相对 tests/ → src/utils/api，与 hook 内 '../utils/api' 解析到同一文件
vi.mock('../src/utils/api', () => ({ getLogs: vi.fn() }));

import { useLogs } from '../src/hooks/useLogs';
import { getLogs } from '../src/utils/api';

const mockedGetLogs = vi.mocked(getLogs);

/** 构造一页 N 条最小可用 LogEntry（formatLog 不崩） */
function makePage(count: number, idFrom: number): any[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `id-${String(idFrom + i).padStart(4, '0')}`,
    timestamp: '2026-01-01T00:00:00.000Z',
    request: {
      method: 'POST',
      url: '/v1/messages',
      headers: {},
      body: { model: 'm', messages: [] },
    },
    response: {
      status: 200,
      statusText: 'OK',
      headers: {},
      body: { id: 'r', type: 'message', role: 'assistant', content: [] },
    },
    providerName: 'all',
    endpointType: 'all',
  }));
}

/** flush 微任务/宏任务队列，让被 mock 的 getLogs 立即 resolve 链跑完 */
const flush = () => new Promise(r => setTimeout(r, 0));

/** renderHook 等价：用 react-test-renderer 挂一个只调用 hook 的空组件，把返回捕获到 result.current */
function renderHook<T>(fn: () => T) {
  const result = { current: undefined as T };
  function Probe() {
    result.current = fn();
    return null;
  }
  let renderer: any;
  act(() => {
    renderer = create(React.createElement(Probe));
  });
  return { result, unmount: () => act(() => renderer.unmount()) };
}

beforeEach(() => {
  mockedGetLogs.mockReset();
  // SSE effect 挂载时 new EventSource；node 环境无 EventSource，桩一个避免抛错
  (globalThis as any).EventSource = class FakeEventSource {
    addEventListener() {}
    close() {}
  };
});
afterEach(() => {
  delete (globalThis as any).EventSource;
});

describe('useLogs — loadMore 竞态与软上限分页', () => {
  it('Bug#3 并发 loadMore（同一 cursor 连续两次）只追加一页、不重复', async () => {
    mockedGetLogs.mockImplementation(async (p: any) => {
      if (!p.cursor) return { total: 1000, nextCursor: 'c1', hasMore: true, logs: makePage(50, 1) };
      if (p.cursor === 'c1') return { total: 1000, nextCursor: 'c2', hasMore: true, logs: makePage(50, 51) };
      if (p.cursor === 'c2') return { total: 1000, nextCursor: 'c3', hasMore: true, logs: makePage(50, 101) };
      return { total: 1000, nextCursor: null, hasMore: false, logs: [] };
    });

    const { result, unmount } = renderHook(() =>
      useLogs({ search: '', providerName: 'all', endpointType: 'all' }),
    );
    // 等首页 loadLogs 完成
    await act(async () => {
      await flush();
    });
    expect(result.current!.logs.length).toBe(50);
    expect(result.current!.hasMore).toBe(true);

    // 连续两次 loadMore，第二次在第一次 setLoadingMore 提交前（同一同步批）
    await act(async () => {
      void result.current!.loadMore();
      void result.current!.loadMore();
      await flush();
    });

    // 仅一次 cursor='c1' 的请求（bug 下为 2 次）
    const callsWithC1 = mockedGetLogs.mock.calls.filter(a => a[0]?.cursor === 'c1');
    expect(callsWithC1.length).toBe(1);
    // 首页 50 + 下一页 50 = 100（bug 下 page1 被追加两次 = 150）
    expect(result.current!.logs.length).toBe(100);
    // 无重复 id
    const ids = result.current!.logs.map(l => l.id);
    expect(new Set(ids).size).toBe(ids.length);

    unmount();
  });

  it('Bug#4 列表累计超过 LOGS_SOFT_CAP(500) 后 hasMore 变 false', async () => {
    mockedGetLogs.mockImplementation(async (p: any) => {
      if (!p.cursor) return { total: 1000, nextCursor: 'c1', hasMore: true, logs: makePage(460, 1) };
      if (p.cursor === 'c1') return { total: 1000, nextCursor: 'c2', hasMore: true, logs: makePage(50, 461) };
      return { total: 1000, nextCursor: null, hasMore: false, logs: [] };
    });

    const { result, unmount } = renderHook(() =>
      useLogs({ search: '', providerName: 'all', endpointType: 'all' }),
    );
    await act(async () => {
      await flush();
    });
    expect(result.current!.logs.length).toBe(460);
    expect(result.current!.hasMore).toBe(true);

    await act(async () => {
      await result.current!.loadMore();
    });
    // combined 460 + 50 = 510 > 500 → 裁剪到 500，且分页收口 hasMore=false
    expect(result.current!.logs.length).toBe(500);
    expect(result.current!.hasMore).toBe(false);

    unmount();
  });
});
