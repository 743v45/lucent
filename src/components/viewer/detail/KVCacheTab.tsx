/**
 * KV-Cache Tab：缓存命中率 / token 分布 / 分组块详情。
 * 从原 DetailPanel.tsx 拆出（#19 巨石拆分），行为零变更。
 *
 * 关键修复：
 * - low#8：命中率配色改用 utils.hitRateColorClass（与 InlineTokenStats 共用，去重）。
 * - low#9：copyAllCache 改走 utils.copyText（带回退、不产生 unhandled rejection）。
 */
import { useState } from 'react';
import type { LogEntry, KVCacheBlock } from '../../../types';
import { ChevronIcon } from '../../common/ChevronIcon';
import { formatTokenValue, hitRateColorClass, copyText } from './utils';

export interface KVCacheTabProps {
  log: LogEntry;
}

export function KVCacheTab({ log }: KVCacheTabProps): JSX.Element {
  const data = log.kvCache;

  // 缓存模式标签
  const cacheModeLabel: Record<string, string> = {
    explicit: '显式缓存',
    auto: '自动缓存',
    none: '未启用',
  };

  // 空状态判定：unsupported / no-data / 无 data 才显示空状态文案
  // first-create / hit / 块空但 status 命中 走正常展示分支
  const hasBlockContent = !!(data?.tools?.length || data?.system?.length || data?.messages?.length);
  const isEmptyState =
    !data ||
    (!hasBlockContent && data.status !== 'hit' && data.status !== 'first-create');

  // 完全无 data
  if (!data) {
    return (
      <div className="flex items-center justify-center h-full">
        <span className="text-text-quaternary text-base">暂无缓存数据</span>
      </div>
    );
  }

  const hitRate = data.hitRate ?? 0;
  const hitRateHasValue = data.hitRate != null && data.hitRate > 0;
  // low#8：复用 utils.hitRateColorClass，与头部 InlineTokenStats 同一套阈值配色
  const hitRateColor = hitRateColorClass(hitRate, hitRateHasValue);

  const readTokens = data.cacheReadTokens ?? 0;
  const createTokens = data.cacheCreateTokens ?? 0;
  const uncachedTokens = data.uncachedInputTokens ?? 0;
  const totalBar = readTokens + createTokens + uncachedTokens;

  // 堆叠条比例（数据驱动的动态宽度，允许 inline width——Tailwind 静态类无法表达任意百分比）
  const readWidthPct = totalBar > 0 ? (readTokens / totalBar) * 100 : 0;
  const createWidthPct = totalBar > 0 ? (createTokens / totalBar) * 100 : 0;
  const uncachedWidthPct = totalBar > 0 ? (uncachedTokens / totalBar) * 100 : 0;

  // 分组列表：tools → system → messages（对应 API 缓存层级）
  const groups: Array<{ key: 'tools' | 'system' | 'messages'; label: string; blocks: KVCacheBlock[] }> = [];
  if (data.tools?.length) groups.push({ key: 'tools', label: '工具', blocks: data.tools });
  if (data.system?.length) groups.push({ key: 'system', label: '系统提示词', blocks: data.system });
  if (data.messages?.length) groups.push({ key: 'messages', label: '消息', blocks: data.messages });

  // 复制全部：拼接各块 text。low#9：走 copyText，失败有回退、不抛 unhandled rejection
  const copyAllCache = async () => {
    const parts: string[] = [];
    groups.forEach((g) => {
      const texts = g.blocks.map(b => b.text).filter(Boolean);
      if (texts.length) parts.push(texts.join('\n\n'));
    });
    return copyText(parts.join('\n\n'));
  };

  const groupSumTokens = (blocks: KVCacheBlock[]): number =>
    blocks.reduce((sum, b) => sum + (b.tokens ?? 0), 0);

  const formatTokens = (n: number): string => formatTokenValue(n);

  return (
    <div className="p-4 h-full overflow-y-auto">
      {/* 概览卡片 */}
      <div className="mb-4 p-4 bg-bg-surface rounded-lg border border-border-subtle">
        <div className="flex items-start justify-between mb-3">
          {/* 大字号命中率 */}
          <div className="flex items-baseline gap-2">
            <span className={`text-3xl font-[510] tabular-nums ${hitRateColor}`}>
              {hitRateHasValue ? `${hitRate.toFixed(1)}%` : '—'}
            </span>
            <span className="text-sm text-text-quaternary">命中率</span>
          </div>
          {/* 右上角：cacheMode + provider */}
          <div className="flex items-center gap-2">
            {data.cacheMode && (
              <span className="px-2 py-0.5 rounded-full text-sm font-[510] border border-border-primary text-text-tertiary">
                {cacheModeLabel[data.cacheMode] ?? data.cacheMode}
              </span>
            )}
            {data.provider && (
              <span className="text-sm text-text-quaternary">{data.provider}</span>
            )}
          </div>
        </div>

        {/* 堆叠条（数据驱动动态宽度） */}
        {totalBar > 0 && (
          <div className="flex h-2 w-full rounded-full overflow-hidden bg-bg-deep mb-3">
            <div className="bg-success/70" style={{ width: `${readWidthPct}%` }} />
            <div className="bg-warning/70" style={{ width: `${createWidthPct}%` }} />
            <div className="bg-text-quaternary/40" style={{ width: `${uncachedWidthPct}%` }} />
          </div>
        )}

        {/* 三行数字：read / create / uncached */}
        <div className="grid grid-cols-3 gap-3 text-sm">
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-success/70" />
            <span className="text-text-quaternary">命中</span>
            <span className="text-success font-[510] tabular-nums">{formatTokens(readTokens)}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-warning/70" />
            <span className="text-text-quaternary">新建</span>
            <span className="text-warning font-[510] tabular-nums">{formatTokens(createTokens)}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-text-quaternary/40" />
            <span className="text-text-quaternary">未缓存</span>
            <span className="text-text-tertiary font-[510] tabular-nums">{formatTokens(uncachedTokens)}</span>
          </div>
        </div>
      </div>

      {/* 空状态 / 块内容 */}
      {isEmptyState ? (
        <div className="flex items-center justify-center py-8">
          <span className="text-text-quaternary text-base">
            {data.status === 'unsupported' || (data.cacheMode === 'none' && totalBar === 0)
              ? '此请求未使用缓存（无 cache_control 标记）'
              : data.status === 'no-data'
                ? '支持缓存但本次未命中'
                : '暂无缓存数据'}
          </span>
        </div>
      ) : hasBlockContent ? (
        <>
          {/* 分组列表 */}
          <div className="flex items-center justify-end mb-2">
            <button
              onClick={copyAllCache}
              className="px-3 py-0.5 text-sm font-[510] text-text-quaternary hover:text-text-secondary bg-bg-active rounded-md transition-colors"
            >
              复制全部
            </button>
          </div>
          <div className="space-y-3">
            {groups.map((group) => (
              <KVCacheGroup key={group.key} label={group.label} blocks={group.blocks} sumTokens={groupSumTokens(group.blocks)} />
            ))}
          </div>
        </>
      ) : (
        // status 是 hit/first-create 但无块内容（如 OpenAI auto）
        <div className="flex items-center justify-center py-6">
          <span className="text-text-quaternary text-base">OpenAI 自动缓存，无块级内容</span>
        </div>
      )}
    </div>
  );
}

// ==================== KV-Cache Group ====================

function KVCacheGroup({
  label,
  blocks,
  sumTokens,
}: {
  label: string;
  blocks: KVCacheBlock[];
  sumTokens: number;
}) {
  // 折叠状态：长文本块默认折叠
  const [collapsedMap, setCollapsedMap] = useState<Record<number, boolean>>(() => {
    const initial: Record<number, boolean> = {};
    blocks.forEach((b, i) => {
      // 默认折叠长文本（超过 200 字符）
      initial[i] = (b.text?.length ?? 0) > 200;
    });
    return initial;
  });

  const toggleCollapse = (index: number) => {
    setCollapsedMap(prev => ({ ...prev, [index]: !prev[index] }));
  };

  return (
    <div className="bg-bg-surface/50 rounded-lg border border-border-subtle">
      {/* 分组标题 */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border-subtle">
        <span className="text-[15px] font-[510] text-text-secondary">
          {label} <span className="text-text-quaternary font-normal">({blocks.length})</span>
        </span>
        {sumTokens > 0 && (
          <span className="text-sm text-text-quaternary tabular-nums">~{formatTokenValue(sumTokens)} tok</span>
        )}
      </div>
      {/* 各块 */}
      <div className="divide-y divide-border-subtle">
        {blocks.map((block, i) => {
          const isCollapsed = collapsedMap[i];
          return (
            <div key={i}>
              <button
                onClick={() => toggleCollapse(i)}
                className="flex items-center gap-2 w-full text-left px-3 py-2 text-sm text-text-tertiary hover:bg-bg-hover transition-colors"
              >
                <ChevronIcon expanded={!isCollapsed} />
                <span className="text-text-quaternary">#{i + 1}</span>
                {block.tokens != null && (
                  <span className="text-text-quaternary">约 {block.tokens} tok</span>
                )}
                {block.kind && (
                  <span className={`text-xs px-1.5 py-0.5 rounded ${
                    block.kind === 'hit' ? 'text-success' : 'text-warning'
                  }`}>
                    {block.kind === 'hit' ? '命中' : '新建'}
                  </span>
                )}
                {!isCollapsed && (
                  <span className="ml-auto truncate text-text-quaternary text-xs">
                    {block.text.slice(0, 60)}{block.text.length > 60 ? '…' : ''}
                  </span>
                )}
              </button>
              {!isCollapsed && (
                <div className="px-3 pb-3">
                  <pre className="text-lg leading-relaxed bg-bg-deep/50 p-3 rounded-md overflow-auto max-h-60 font-mono text-text-secondary whitespace-pre-wrap break-words">
                    {block.text}
                  </pre>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
