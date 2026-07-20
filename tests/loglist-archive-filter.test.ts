/**
 * LogListPanel archiveOnly 过滤 / 空态单测（vitest node 环境）
 *
 * Bug #20：archiveOnly 开启且当前页全为临时日志时，空态判定误用未过滤的 logs.length
 * （logs 即 visibleLogs），但渲染走 displayLogs（archiveOnly 时 logs.filter(!expiresAt)）。
 * 于是 logs.length>0 不进 Empty、而 displayLogs 为空 → 列表区空白；且自动补拉 effect 用
 * 未过滤 hasMore + scrollRef 真实高度判断，archiveOnly 撑不出滚动条 → 反复 onLoadMore 一页页拉。
 *
 * 修复：空态判定改用 displayLogs.length===0；自动补拉 effect 在 archiveOnly 时跳过。
 * 组件整体在 node 难直接渲染（依赖 antd + 复杂 props），抽出 filterArchiveLogs 纯函数，
 * 覆盖「全临时页 → displayLogs 为空」这一空态触发条件（修复后走 Empty 而非空白）。
 */
import { describe, it, expect } from 'vitest';
import { filterArchiveLogs } from '../src/components/dashboard/LogListPanel.js';
import type { LogEntry } from '../src/types';

/** 构造最小 LogEntry：filterArchiveLogs 只读 id + expiresAt，其余字段用断言跳过。 */
function makeLog(id: string, expiresAt?: string): LogEntry {
  return { id, expiresAt } as unknown as LogEntry;
}

describe('filterArchiveLogs — archiveOnly 过滤（Bug #20 空态 / 补拉风暴）', () => {
  it('archiveOnly=false 原样返回、同引用（不过滤、不复制）', () => {
    const logs = [makeLog('1', '2026-01-01T00:30:00.000Z'), makeLog('2')];
    expect(filterArchiveLogs(logs, false)).toBe(logs);
  });

  it('archiveOnly=true 过滤掉临时行（expiresAt 非空），仅留存档', () => {
    const logs = [
      makeLog('1', '2026-01-01T00:30:00.000Z'),
      makeLog('2'),
      makeLog('3', '2026-01-01T00:30:00.000Z'),
    ];
    expect(filterArchiveLogs(logs, true).map((l) => l.id)).toEqual(['2']);
  });

  it('Bug #20 回归：archiveOnly 且当前页全为临时日志 → displayLogs 为空（触发 Empty，非空白）', () => {
    const allTemporary = [
      makeLog('1', '2026-01-01T00:30:00.000Z'),
      makeLog('2', '2026-01-01T00:30:00.000Z'),
    ];
    const displayLogs = filterArchiveLogs(allTemporary, true);
    // 修复后空态判定为 displayLogs.length === 0 → 渲染 Empty；bug 下 logs.length>0 → 空白
    expect(displayLogs.length).toBe(0);
  });

  it('archiveOnly=true 但全部为存档行 → 不过滤、全部保留', () => {
    const logs = [makeLog('1'), makeLog('2')];
    expect(filterArchiveLogs(logs, true).map((l) => l.id)).toEqual(['1', '2']);
  });

  it('空数组两种模式都返回空', () => {
    expect(filterArchiveLogs([], false)).toEqual([]);
    expect(filterArchiveLogs([], true)).toEqual([]);
  });
});
