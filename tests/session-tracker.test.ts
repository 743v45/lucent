import { describe, it, expect } from 'vitest';
import { computeAnchorKey, computeFingerprintSeq, findContinuation } from '../server/session-tracker.js';

describe('computeAnchorKey', () => {
  it('首条 user 文本生成稳定锚点', () => {
    const msgs = [{ role: 'user', content: '帮我重构代码' }];
    const key = computeAnchorKey(msgs as any);
    expect(key).toMatch(/^thread_[a-z0-9]+$/);
    expect(computeAnchorKey(msgs as any)).toBe(key); // 稳定
  });

  it('空白/大小写不影响锚点（normalize 后）', () => {
    const a = computeAnchorKey([{ role: 'user', content: '帮我 重构' }] as any);
    const b = computeAnchorKey([{ role: 'user', content: '帮我重构' }] as any);
    expect(a).toBe(b);
  });

  it('ContentBlock[] 内容也能提取文本', () => {
    const msgs = [{ role: 'user', content: [{ type: 'text', text: '你好' }] }];
    expect(computeAnchorKey(msgs as any)).toMatch(/^thread_/);
  });

  it('无 user 消息返回 undefined', () => {
    expect(computeAnchorKey([{ role: 'assistant', content: 'x' }] as any)).toBeUndefined();
    expect(computeAnchorKey([] as any)).toBeUndefined();
  });

  it('首条 user 内容为空返回 undefined', () => {
    expect(computeAnchorKey([{ role: 'user', content: '' }] as any)).toBeUndefined();
  });
});

describe('computeFingerprintSeq', () => {
  it('每条 message 一个指纹，长度等于 messages', () => {
    const msgs = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
    ];
    const seq = computeFingerprintSeq(msgs as any);
    expect(seq).toHaveLength(2);
    expect(seq[0]).not.toBe(seq[1]);
  });
});

describe('findContinuation', () => {
  it('前缀匹配返回该 lineage', () => {
    const lineages = [{ threadId: 'thread_x', msgFingerprints: ['u:1', 'a:2'], lastTimestamp: '2026-01-01', requestCount: 1 }];
    const fpSeq = ['u:1', 'a:2', 'u:3'];
    expect(findContinuation(lineages as any, fpSeq)).toBe(lineages[0]);
  });

  it('无前缀匹配返回 undefined', () => {
    const lineages = [{ threadId: 'thread_x', msgFingerprints: ['u:1', 'a:2'], lastTimestamp: '2026-01-01', requestCount: 1 }];
    expect(findContinuation(lineages as any, ['u:9', 'a:8'])).toBeUndefined();
  });

  it('多个匹配取最近时间戳', () => {
    const lineages = [
      { threadId: 'thread_x', msgFingerprints: ['u:1'], lastTimestamp: '2026-01-01', requestCount: 1 },
      { threadId: 'thread_x-2', msgFingerprints: ['u:1'], lastTimestamp: '2026-01-02', requestCount: 1 },
    ];
    const got = findContinuation(lineages as any, ['u:1', 'a:2']);
    expect(got?.threadId).toBe('thread_x-2');
  });
});
