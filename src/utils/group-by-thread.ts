import type { LogEntry } from '../types';

export interface ThreadGroup {
  threadId: string;
  title: string;
  mainLogs: LogEntry[];
  subLogs: LogEntry[];
  totalTokens: number;
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
  // 统一升序，便于组内展示与 sub 附属判定
  const ascending = [...logs].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );

  const byThread = new Map<string, LogEntry[]>();
  // 各 thread 首条 main 的时间，用于 sub 邻近附属判定
  const threadStart: { threadId: string; time: number }[] = [];
  for (const log of ascending) {
    if (!log.threadId) continue;
    if (!byThread.has(log.threadId)) {
      byThread.set(log.threadId, []);
      threadStart.push({ threadId: log.threadId, time: new Date(log.timestamp).getTime() });
    }
    byThread.get(log.threadId)!.push(log);
  }
  threadStart.sort((a, b) => a.time - b.time);

  // 无 threadId 的 sub：归属时间不晚于它的最近 main 会话
  const subAssign = new Map<string, LogEntry[]>();
  const ungrouped: LogEntry[] = [];
  for (const log of ascending) {
    if (log.threadId) continue;
    const t = new Date(log.timestamp).getTime();
    let target: string | undefined;
    for (const ts of threadStart) {
      if (ts.time <= t) target = ts.threadId;
      else break;
    }
    if (target) {
      if (!subAssign.has(target)) subAssign.set(target, []);
      subAssign.get(target)!.push(log);
    } else {
      ungrouped.push(log);
    }
  }

  const groups: ThreadGroup[] = [];
  for (const [threadId, mainLogs] of byThread) {
    const subs = subAssign.get(threadId) ?? [];
    const totalTokens = [...mainLogs, ...subs].reduce((sum, l) => sum + tokenSum(l), 0);
    groups.push({
      threadId,
      title: deriveTitle(mainLogs),
      mainLogs,
      subLogs: subs,
      totalTokens,
      startTime: mainLogs[0]?.timestamp ?? '',
      endTime: mainLogs[mainLogs.length - 1]?.timestamp ?? '',
    });
  }
  groups.sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime());

  return { groups, ungrouped };
}
