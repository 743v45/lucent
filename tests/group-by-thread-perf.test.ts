import { describe, expect, it } from 'vitest';
import { groupByThread } from '../src/utils/group-by-thread';
import type { LogEntry } from '../src/types';

function mkLog(partial: Partial<LogEntry>): LogEntry {
  return {
    id: partial.id ?? 'x',
    timestamp: partial.timestamp ?? '2026-01-01T00:00:00Z',
    request: { method: 'POST', url: 'u', headers: {}, body: { model: 'm', messages: [] } },
    response: { status: 200, statusText: 'OK', headers: {}, body: {} },
    agentType: partial.agentType ?? 'main',
    duration: 0,
    metadata: { model: 'm', provider: 'claude', stream: false },
    ...partial,
  } as LogEntry;
}

describe('low#10/low#13 groupByThread — 二分归属 + 预计算排序结果不变', () => {
  it('sub 归属时间不晚于它的最近 main 会话（多会话交错，二分查找正确）', () => {
    const logs = [
      mkLog({ id: 'm_a1', threadId: 'A', timestamp: '2026-01-01T00:00:00Z' }),
      mkLog({ id: 's1', threadId: undefined, agentType: 'sub', timestamp: '2026-01-01T00:00:30Z' }), // → A
      mkLog({ id: 'm_b1', threadId: 'B', timestamp: '2026-01-01T00:01:00Z' }),
      mkLog({ id: 's2', threadId: undefined, agentType: 'sub', timestamp: '2026-01-01T00:01:30Z' }), // → B
      mkLog({ id: 'm_b2', threadId: 'B', timestamp: '2026-01-01T00:02:00Z' }),
      mkLog({ id: 's3', threadId: undefined, agentType: 'sub', timestamp: '2026-01-01T00:02:30Z' }), // → B
      mkLog({ id: 'm_c1', threadId: 'C', timestamp: '2026-01-01T00:03:00Z' }),
      mkLog({ id: 's4', threadId: undefined, agentType: 'sub', timestamp: '2026-01-01T00:03:30Z' }), // → C
    ];
    const { groups, ungrouped } = groupByThread(logs);
    expect(ungrouped).toHaveLength(0);
    const a = groups.find(g => g.threadId === 'A')!;
    const b = groups.find(g => g.threadId === 'B')!;
    const c = groups.find(g => g.threadId === 'C')!;
    expect(a.subLogs.map(l => l.id)).toEqual(['s1']);
    expect(b.subLogs.map(l => l.id)).toEqual(['s2', 's3']);
    expect(c.subLogs.map(l => l.id)).toEqual(['s4']);
  });

  it('早于所有会话的 sub（二分无命中）→ ungrouped', () => {
    const logs = [
      mkLog({ id: 's0', threadId: undefined, agentType: 'sub', timestamp: '2025-12-31T00:00:00Z' }),
      mkLog({ id: 'm_a1', threadId: 'A', timestamp: '2026-01-01T00:00:00Z' }),
    ];
    const { groups, ungrouped } = groupByThread(logs);
    expect(groups).toHaveLength(1);
    expect(ungrouped.map(l => l.id)).toEqual(['s0']);
  });

  it('sub 时间等于会话起点 → 归属该会话（<= 边界）', () => {
    const logs = [
      mkLog({ id: 'm_a1', threadId: 'A', timestamp: '2026-01-01T00:00:00Z' }),
      mkLog({ id: 's1', threadId: undefined, agentType: 'sub', timestamp: '2026-01-01T00:00:00Z' }), // 同时刻 → A
    ];
    const { groups } = groupByThread(logs);
    expect(groups.find(g => g.threadId === 'A')!.subLogs.map(l => l.id)).toEqual(['s1']);
  });

  it('groups 按 startTime 倒序（最新会话在前，预计算时间排序）', () => {
    const logs = [
      mkLog({ id: 'm_a', threadId: 'A', timestamp: '2026-01-03T00:00:00Z' }),
      mkLog({ id: 'm_b', threadId: 'B', timestamp: '2026-01-01T00:00:00Z' }),
      mkLog({ id: 'm_c', threadId: 'C', timestamp: '2026-01-02T00:00:00Z' }),
    ];
    const { groups } = groupByThread(logs);
    expect(groups.map(g => g.threadId)).toEqual(['A', 'C', 'B']);
  });

  it('乱序输入下组内 main 仍按时间升序（预计算 t 排序）', () => {
    const logs = [
      mkLog({ id: 'm3', threadId: 'A', timestamp: '2026-01-01T00:00:03Z' }),
      mkLog({ id: 'm1', threadId: 'A', timestamp: '2026-01-01T00:00:01Z' }),
      mkLog({ id: 'm2', threadId: 'A', timestamp: '2026-01-01T00:00:02Z' }),
    ];
    const { groups } = groupByThread(logs);
    expect(groups[0]!.mainLogs.map(l => l.id)).toEqual(['m1', 'm2', 'm3']);
    expect(groups[0]!.startTime).toBe('2026-01-01T00:00:01Z');
    expect(groups[0]!.endTime).toBe('2026-01-01T00:00:03Z');
  });
});
