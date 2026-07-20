import type { LogEntry } from '../types';

export interface ThreadGroup {
  threadId: string;
  title: string;
  mainLogs: LogEntry[];
  subLogs: LogEntry[];
  startTime: string;
  endTime: string;
}

export interface GroupResult {
  groups: ThreadGroup[];
  ungrouped: LogEntry[];
}

/** 单条日志的 input + output token 总和 */
function tokenSum(log: LogEntry): number {
  const u = log.tokenUsage;
  return (u?.input_tokens ?? 0) + (u?.output_tokens ?? 0);
}

/** 末条 main 请求的 messages 数（会话当前对话消息总条数；messages 非数组或缺省 → 0） */
function lastMainMessageCount(logs: LogEntry[]): number {
  const mains = logs.filter(l => l.agentType === 'main');
  if (mains.length === 0) return 0;
  const last = mains[mains.length - 1];
  const msgs = (last.request?.body as { messages?: unknown })?.messages;
  return Array.isArray(msgs) ? msgs.length : 0;
}

export interface ThreadSummary {
  requestCount: number;
  messageCount: number;
  tokenTotal: number;
}

/**
 * 合并全量加载结果（fullLogs）与当前分页增量（freshLogs）。
 * fullLogs 提供历史全量；freshLogs（自动刷新拉到的分页）提供最新增量。
 * 按 id 去重、按 timestamp 升序；fullLogs 为 null 时直接用 freshLogs。
 */
export function mergeThreadLogs(fullLogs: LogEntry[] | null, freshLogs: LogEntry[]): LogEntry[] {
  const base = fullLogs ?? freshLogs;
  const seen = new Set(base.map(l => l.id));
  const fresh = freshLogs.filter(l => !seen.has(l.id));
  // 预计算时间戳再排序，避免 comparator 内 O(n log n) 次反复 new Date()
  return [...base, ...fresh]
    .map(l => ({ log: l, t: new Date(l.timestamp).getTime() }))
    .sort((a, b) => a.t - b.t)
    .map(x => x.log);
}

/** 汇总一个会话的行集：请求数 / 末条 main 消息数 / token 总和 */
export function summarizeThreadLogs(logs: LogEntry[]): ThreadSummary {
  return {
    requestCount: logs.length,
    messageCount: lastMainMessageCount(logs),
    tokenTotal: logs.reduce((sum, l) => sum + tokenSum(l), 0),
  };
}

/** 取首条 user 文本作为会话标题（截断 40 字符） */
function deriveTitle(logs: LogEntry[]): string {
  for (const log of logs) {
    const msgs = (log.request?.body as { messages?: unknown })?.messages;
    if (Array.isArray(msgs)) {
      const u = msgs.find((m: { role?: string }) => m.role === 'user');
      const text =
        typeof u?.content === 'string'
          ? u.content
          : Array.isArray(u?.content)
            ? (u.content as Array<{ text?: string }>).map((b) => b?.text ?? '').join('')
            : '';
      if (text) return text.replace(/\s+/g, ' ').slice(0, 40);
    }
  }
  return '（无标题）';
}

/**
 * 按 threadId 分组。无 threadId 的 sub 请求归属 timestamp 不晚于它的最近 main 会话。
 *
 * 输入 logs 通常按时间倒序（来自 useLogs），组内统一转升序便于展示。
 * 返回 groups 按 startTime 倒序（最新会话在前）。
 */
export function groupByThread(logs: LogEntry[]): GroupResult {
  // 预计算每条日志时间戳并按时间升序，后续排序/二分/附属判定全部复用预计算值，
  // 避免 comparator 内 O(n log n) 次反复 new Date()（low#13）。
  const withTime = logs
    .map(l => ({ log: l, t: new Date(l.timestamp).getTime() }))
    .sort((a, b) => a.t - b.t);

  const byThread = new Map<string, LogEntry[]>();
  // 各 thread 首条 main 的时间，用于 sub 邻近附属判定；随 withTime 升序构建，天然有序
  const threadStart: { threadId: string; time: number }[] = [];
  for (const { log, t } of withTime) {
    if (!log.threadId) continue;
    if (!byThread.has(log.threadId)) {
      byThread.set(log.threadId, []);
      threadStart.push({ threadId: log.threadId, time: t });
    }
    byThread.get(log.threadId)!.push(log);
  }
  // threadId → 首条时间，供 groups 排序复用，避免 comparator 内 new Date()
  const startMs = new Map(threadStart.map(s => [s.threadId, s.time]));

  // 无 threadId 的 sub：二分查找时间不晚于它的最近 main 会话（low#10，原线性扫描 O(subs×threads)）
  const subAssign = new Map<string, LogEntry[]>();
  const ungrouped: LogEntry[] = [];
  for (const { log, t } of withTime) {
    if (log.threadId) continue;
    // 升序 threadStart 中找最大 time <= t：标准右侧二分
    let lo = 0;
    let hi = threadStart.length - 1;
    let idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (threadStart[mid].time <= t) {
        idx = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (idx >= 0) {
      const target = threadStart[idx].threadId;
      if (!subAssign.has(target)) subAssign.set(target, []);
      subAssign.get(target)!.push(log);
    } else {
      ungrouped.push(log);
    }
  }

  const groups: ThreadGroup[] = [];
  for (const [threadId, mainLogs] of byThread) {
    const subs = subAssign.get(threadId) ?? [];
    groups.push({
      threadId,
      title: deriveTitle(mainLogs),
      mainLogs,
      subLogs: subs,
      startTime: mainLogs[0]?.timestamp ?? '',
      endTime: mainLogs[mainLogs.length - 1]?.timestamp ?? '',
    });
  }
  // groups 按 startTime 倒序（最新在前）：用预计算 startMs，避免 comparator 内 new Date()
  groups.sort((a, b) => (startMs.get(b.threadId) ?? 0) - (startMs.get(a.threadId) ?? 0));

  return { groups, ungrouped };
}
