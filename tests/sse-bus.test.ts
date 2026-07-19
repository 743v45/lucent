import { describe, it, expect, vi } from 'vitest';
import { registerSseClient, unregisterSseClient, broadcastLog } from '../server/sse-bus.js';
import type { LogEntry } from '../server/types.js';

/** mock express Response：记录 write 调用，可配置抛错 */
function mockRes(throws = false) {
  const writes: string[] = [];
  const write = vi.fn((data: string) => {
    if (throws) throw new Error('broken pipe');
    writes.push(data);
    return true;
  });
  return { write, writes } as unknown as import('express').Response & { writes: string[] };
}

describe('sse-bus', () => {
  it('broadcastLog 向已注册客户端推送 event:log 且含 JSON 载荷', () => {
    const res = mockRes();
    registerSseClient(res);
    broadcastLog({ id: 'x', timestamp: 't' } as LogEntry);
    expect((res as any).writes).toHaveLength(1);
    expect((res as any).writes[0]).toContain('event: log');
    expect((res as any).writes[0]).toContain('"id":"x"');
    unregisterSseClient(res);
  });

  it('无客户端时 broadcastLog 不抛错（no-op）', () => {
    expect(() => broadcastLog({ id: 'y' } as LogEntry)).not.toThrow();
  });

  it('write 抛错的客户端被自动剔除，后续广播不再触达它', () => {
    const bad = mockRes(true);
    registerSseClient(bad);
    // 第一次广播：bad.write 抛错 → 被 clients.delete 剔除
    expect(() => broadcastLog({ id: 'z' } as LogEntry)).not.toThrow();
    // 第二次广播：bad 已剔除，不应再调用其 write
    expect(() => broadcastLog({ id: 'z2' } as LogEntry)).not.toThrow();
    expect((bad as any).write).toHaveBeenCalledTimes(1);
  });

  it('unregister 后不再收到广播', () => {
    const res = mockRes();
    registerSseClient(res);
    unregisterSseClient(res);
    broadcastLog({ id: 'w' } as LogEntry);
    expect((res as any).writes).toHaveLength(0);
  });
});
