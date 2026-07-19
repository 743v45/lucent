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

import { SessionTracker } from '../server/session-tracker.js';

describe('SessionTracker.identify', () => {
  it('续：同会话第二次请求返回相同 threadId', () => {
    const t = new SessionTracker();
    const body1 = { messages: [{ role: 'user', content: '你好' }] };
    const body2 = { messages: [
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '嗨' },
      { role: 'user', content: '再见' },
    ] };
    const id1 = t.identify(body1, 'https://api.anthropic.com/v1/messages', '2026-01-01T00:00:00Z');
    const id2 = t.identify(body2, 'https://api.anthropic.com/v1/messages', '2026-01-01T00:00:01Z');
    expect(id1).toMatch(/^thread_/);
    expect(id2).toBe(id1);
  });

  it('分叉：同首条 user 但前缀不匹配 → 分会话 -2', () => {
    const t = new SessionTracker();
    const body1 = { messages: [{ role: 'user', content: '你好' }, { role: 'assistant', content: 'A' }] };
    const body2 = { messages: [{ role: 'user', content: '你好' }, { role: 'assistant', content: 'B' }] };
    const id1 = t.identify(body1, 'https://api.anthropic.com/v1/messages', '2026-01-01T00:00:00Z');
    const id2 = t.identify(body2, 'https://api.anthropic.com/v1/messages', '2026-01-01T00:00:01Z');
    expect(id2).toBe(`${id1}-2`);
  });

  it('无 user → undefined（未归类）', () => {
    const t = new SessionTracker();
    expect(t.identify({ messages: [{ role: 'assistant', content: 'x' }] }, 'u', 't')).toBeUndefined();
  });

  it('内容寻址：reset 后重算 id 一致', () => {
    const t = new SessionTracker();
    const body = { messages: [{ role: 'user', content: '稳定锚点' }] };
    const id1 = t.identify(body, 'u', '2026-01-01');
    t.reset();
    const id2 = t.identify(body, 'u', '2026-01-02');
    expect(id2).toBe(id1);
  });

  it('OpenAI-Responses 协议（body.input）也能识别', () => {
    const t = new SessionTracker();
    const body = { input: [{ role: 'user', content: 'resp 协议' }] };
    const id = t.identify(body, 'https://api.openai.com/v1/responses', '2026-01-01');
    expect(id).toMatch(/^thread_/);
  });
});

describe('SessionTracker.findRecentThread', () => {
  // 用真实 URL 让 extractContext 正常解析、identify 真正建立 lineage（url='u' 会让 extractContext 返回 null）
  const U = 'https://api.anthropic.com/v1/messages';
  it('返回 lastTimestamp ≤ cutoff 的最近 main threadId', () => {
    const t = new SessionTracker();
    const id1 = t.identify({ messages: [{ role: 'user', content: '会话一' }] }, U, '2026-01-01T00:00:00Z');
    const id2 = t.identify({ messages: [{ role: 'user', content: '会话二' }] }, U, '2026-01-02T00:00:00Z');
    expect(id1).toMatch(/^thread_/);
    expect(id2).toMatch(/^thread_/);
    // sub 在 2026-01-03，应归属最近 main（id2 @ 2026-01-02）
    expect(t.findRecentThread('2026-01-03T00:00:00Z')).toBe(id2);
  });

  it('cutoff 早于所有 main lineage → undefined', () => {
    const t = new SessionTracker();
    t.identify({ messages: [{ role: 'user', content: '会话一' }] }, U, '2026-01-02T00:00:00Z');
    expect(t.findRecentThread('2026-01-01T00:00:00Z')).toBeUndefined();
  });

  it('无任何 lineage → undefined', () => {
    expect(new SessionTracker().findRecentThread('2026-01-03T00:00:00Z')).toBeUndefined();
  });

  it('多个候选取 lastTimestamp 最大者', () => {
    const t = new SessionTracker();
    const id1 = t.identify({ messages: [{ role: 'user', content: '会话一' }] }, U, '2026-01-01T00:00:00Z');
    const id2 = t.identify({ messages: [{ role: 'user', content: '会话二' }] }, U, '2026-01-02T00:00:00Z');
    expect(t.findRecentThread('2026-01-05T00:00:00Z')).toBe(id2);
    expect(t.findRecentThread('2026-01-05T00:00:00Z')).not.toBe(id1);
  });

  it('同锚点分叉 lineage 也参与（取 lastTimestamp 最大）', () => {
    const t = new SessionTracker();
    const id1 = t.identify(
      { messages: [{ role: 'user', content: '同开场' }, { role: 'assistant', content: 'A' }] },
      U, '2026-01-01T00:00:00Z');
    const id2 = t.identify(
      { messages: [{ role: 'user', content: '同开场' }, { role: 'assistant', content: 'B' }] },
      U, '2026-01-03T00:00:00Z');
    expect(id1).toMatch(/^thread_/);
    expect(id2).toBe(`${id1}-2`);
    expect(t.findRecentThread('2026-01-04T00:00:00Z')).toBe(id2);
  });
});
