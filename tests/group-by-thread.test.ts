import { describe, it, expect } from 'vitest';
import { groupByThread } from '../src/utils/group-by-thread.js';
import type { LogEntry } from '../src/types.js';

function mkLog(partial: Partial<LogEntry>): LogEntry {
  return {
    id: partial.id ?? 'x',
    timestamp: partial.timestamp ?? '2026-01-01T00:00:00Z',
    request: partial.request ?? { method: 'POST', url: 'u', headers: {}, body: { model: 'm', messages: [] } },
    response: partial.response ?? { status: 200, statusText: 'OK', headers: {}, body: {} },
    agentType: partial.agentType ?? 'main',
    duration: partial.duration ?? 0,
    metadata: partial.metadata ?? { model: 'm', provider: 'claude', stream: false },
    ...partial,
  } as LogEntry;
}

describe('groupByThread', () => {
  it('同 threadId 的 main 请求归一组', () => {
    const logs = [
      mkLog({ id: '1', threadId: 'thread_a', timestamp: '2026-01-01T00:00:00Z' }),
      mkLog({ id: '2', threadId: 'thread_a', timestamp: '2026-01-01T00:00:01Z' }),
      mkLog({ id: '3', threadId: 'thread_b', timestamp: '2026-01-01T00:00:02Z' }),
    ];
    const { groups, ungrouped } = groupByThread(logs);
    expect(groups).toHaveLength(2);
    const a = groups.find(g => g.threadId === 'thread_a')!;
    expect(a.mainLogs).toHaveLength(2);
    expect(a.mainLogs.map(l => l.id)).toEqual(['1', '2']); // 组内时间升序
  });

  it('无 threadId 的 sub 归属时间不晚于它的最近 main 会话', () => {
    const logs = [
      mkLog({ id: 'm1', threadId: 'thread_a', agentType: 'main', timestamp: '2026-01-01T00:00:00Z' }),
      mkLog({ id: 's1', threadId: undefined, agentType: 'sub', timestamp: '2026-01-01T00:00:01Z' }),
      mkLog({ id: 'm2', threadId: 'thread_a', agentType: 'main', timestamp: '2026-01-01T00:00:02Z' }),
    ];
    const { groups } = groupByThread(logs);
    const a = groups.find(g => g.threadId === 'thread_a')!;
    expect(a.subLogs.map(l => l.id)).toEqual(['s1']);
  });

  it('无 threadId 且无邻近 main → ungrouped', () => {
    const logs = [mkLog({ id: 's1', threadId: undefined, agentType: 'sub', timestamp: '2026-01-01T00:00:00Z' })];
    const { groups, ungrouped } = groupByThread(logs);
    expect(groups).toHaveLength(0);
    expect(ungrouped.map(l => l.id)).toEqual(['s1']);
  });

  it('token 汇总与时间跨度正确', () => {
    const logs = [
      mkLog({ id: '1', threadId: 'thread_a', timestamp: '2026-01-01T00:00:00Z', tokenUsage: { input_tokens: 100, output_tokens: 50 } }),
      mkLog({ id: '2', threadId: 'thread_a', timestamp: '2026-01-01T00:10:00Z', tokenUsage: { input_tokens: 200, output_tokens: 50 } }),
    ];
    const { groups } = groupByThread(logs);
    const a = groups[0];
    expect(a.totalTokens).toBe(400);
    expect(a.startTime).toBe('2026-01-01T00:00:00Z');
    expect(a.endTime).toBe('2026-01-01T00:10:00Z');
  });
});
