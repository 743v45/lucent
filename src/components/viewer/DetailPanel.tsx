import { useState, useCallback, useEffect, useMemo, memo } from 'react';
import type { LogEntry, TabType } from '../../types';
import { ENDPOINT_LABELS } from '../../types';
import { STORAGE_KEY_DETAIL_BODY_EXPANDED, STORAGE_KEY_DETAIL_HEADERS_EXPANDED, getStatusColor } from '../../constants';
import { resolveResponseType } from '../../utils/response-type';
import { ProviderIcon } from '../common/ProviderIcon';
import { ProtocolIcon } from '../common/ProtocolIcon';
import { Tooltip } from 'antd';
import 'react-json-view-lite/dist/index.css';
import './DetailPanel.css';
// #19：详情面板拆分为 detail/* 多文件。本文件只留外壳 + tab 路由 + 顶层 useMemo。
import { readExpandedPair, resolveTokenUsage, formatTokenValue, hitRateColorClass, copyText } from './detail/utils';
import { RequestTab } from './detail/RequestTab';
import { ResponseTab } from './detail/ResponseTab';
import { KVCacheTab } from './detail/KVCacheTab';
import { ContextTab } from './detail/ContextTab';
import { MetaTab } from './detail/MetaTab';


// ==================== Token Stats Card ====================

// 头部常驻组件（位于 key={log.id} 重建边界之外），父级每次重渲染都会波及它。
// 1) tokenUsage 由父级 useMemo 解析后传入——避免每次重渲染都 O(n) 重解析整条 SSE 流；
// 2) 包 memo：tokenUsage / kvCache 引用稳定（同一份 log）时跳过重渲染。
const InlineTokenStats = memo(function InlineTokenStats({
  tokenUsage,
  kvCache,
}: {
  tokenUsage: ReturnType<typeof resolveTokenUsage>;
  kvCache: LogEntry['kvCache'];
}) {
  const inputTokens = tokenUsage?.input_tokens;
  const outputTokens = tokenUsage?.output_tokens;
  const cacheCreate = tokenUsage?.cache_creation_tokens;
  const cacheRead = tokenUsage?.cache_read_tokens;
  const hitRate = kvCache?.hitRate ?? 0;
  const hasHitRate = kvCache?.hitRate != null && kvCache.hitRate > 0;
  // low#8：复用 utils.hitRateColorClass，与 KVCacheTab 同一套阈值配色（去重）
  const hitRateClass = hitRateColorClass(hitRate, hasHitRate);

  return (
    <div className="shrink-0 flex items-stretch rounded-lg border border-border-subtle bg-bg-surface/50 overflow-hidden">
      {/* 左侧主数据区:2x4 网格, 4 个核心指标定宽对齐 */}
      <div className="flex-1 min-w-0 grid grid-cols-2 grid-rows-2 gap-x-6 gap-y-2 p-4">
        <div className="flex flex-col gap-0.5 min-w-[88px]">
          <span className="text-sm text-text-quaternary">input</span>
          <span className="text-base font-[510] text-text-primary tabular-nums">{formatTokenValue(inputTokens)}</span>
        </div>
        <div className="flex flex-col gap-0.5 min-w-[88px]">
          <span className="text-sm text-text-quaternary">output</span>
          <span className="text-base font-[510] text-text-primary tabular-nums">{formatTokenValue(outputTokens)}</span>
        </div>
        <div className="flex flex-col gap-0.5 min-w-[88px]">
          <span className="text-sm text-text-quaternary">create</span>
          <span className="text-base font-[510] text-text-primary tabular-nums">{formatTokenValue(cacheCreate)}</span>
        </div>
        <div className="flex flex-col gap-0.5 min-w-[88px]">
          <span className="text-sm text-text-quaternary">read</span>
          <span className="text-base font-[510] text-text-primary tabular-nums">{formatTokenValue(cacheRead)}</span>
        </div>
      </div>

      {/* 细分隔线 */}
      <div className="w-px bg-border-subtle self-stretch" />

      {/* 右侧关键指标区:命中率大字突出 */}
      <div className="flex flex-col items-center justify-center px-6 shrink-0">
        <span className={`text-2xl font-[510] tabular-nums ${hitRateClass}`}>
          {hasHitRate ? `${hitRate.toFixed(1)}%` : '—'}
        </span>
        <span className="text-sm text-text-quaternary mt-1">命中率</span>
      </div>
    </div>
  );
});

// ==================== DetailPanel ====================

interface DetailPanelProps {
  log: LogEntry | null;
  activeTab: TabType;
  onTabChange: (tab: TabType) => void;
  /** 当前搜索词（详情正文命中高亮用；空则不高亮） */
  searchTerm?: string;
}

const TAB_CONFIG: { key: TabType; label: string }[] = [
  { key: 'request', label: 'Request' },
  { key: 'response', label: 'Response' },
  { key: 'kvcache', label: 'KV-Cache' },
  { key: 'context', label: 'Context' },
  { key: 'meta', label: 'Meta' },
];

export function DetailPanel({ log, activeTab, onTabChange, searchTerm }: DetailPanelProps): JSX.Element {
  // body 展开态（单一真相源，记忆）：false=折叠到 JSON_COLLAPSED_EXPAND_LEVEL，true=全展开。
  // 初始值读 localStorage，切日志不再重置——用户点开的「全展开」跨日志保留。
  // 历史上 bodyCollapsed + expandAll 双 boolean 会 desync（两个按钮写出互相矛盾的状态），
  // 早合成单个 boolean；这次又把重复的 CollapseButton 按钮删了，UI 只剩一个 ExpandAllButton。
  const [bodyExpanded, setBodyExpanded] = useState<{ request: boolean; response: boolean }>(
    () => readExpandedPair(STORAGE_KEY_DETAIL_BODY_EXPANDED)
  );

  // headers 折叠态（记忆）：与 body 同套路，初始读 localStorage，切日志不重置。
  const [headersExpanded, setHeadersExpanded] = useState<{ request: boolean; response: boolean }>(
    () => readExpandedPair(STORAGE_KEY_DETAIL_HEADERS_EXPANDED)
  );

  // 变化即落盘（mount 时也会写一次默认值，无副作用）
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY_DETAIL_BODY_EXPANDED, JSON.stringify(bodyExpanded)); } catch { /* ignore */ }
  }, [bodyExpanded]);
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY_DETAIL_HEADERS_EXPANDED, JSON.stringify(headersExpanded)); } catch { /* ignore */ }
  }, [headersExpanded]);

  const toggleBodyExpanded = useCallback((type: 'request' | 'response') => {
    setBodyExpanded(prev => ({
      ...prev,
      [type]: !prev[type],
    }));
  }, []);

  const toggleHeadersExpanded = useCallback((type: 'request' | 'response') => {
    setHeadersExpanded(prev => ({
      ...prev,
      [type]: !prev[type],
    }));
  }, []);

  // low#9：走 copyText（带回退、不产生 unhandled rejection），返回真实结果供 CopyButton 据实反馈。
  const copyBody = useCallback((data: unknown): boolean | Promise<boolean> => {
    if (data == null) return false;
    const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    return copyText(text);
  }, []);

  // SSE token 解析昂贵（resolveTokenUsage 对每条 SSE line 做 JSON.parse，O(n)）。
  // 顶层 useMemo：同一份 log 只解析一次，头部 InlineTokenStats 与 MetaTab 共用同一结果，
  // 切 tab / 展开收起 / 防抖落地 / 自动刷新等无关重渲染不再触发重复 parse。
  // log 为 null 时返回 undefined（下方 if (!log) 会提前 return，不会用到）。
  const tokenUsage = useMemo(() => (log ? resolveTokenUsage(log) : undefined), [log]);

  if (!log) {
    return (
      <div className="flex-1 min-w-0 flex items-center justify-center h-full bg-bg-panel" data-testid="detail-empty">
        <span className="text-text-quaternary text-base">选择一条记录查看详情</span>
      </div>
    );
  }

  const renderTabContent = () => {
    switch (activeTab) {
      case 'request':
        return (
          <RequestTab
            log={log}
            expanded={bodyExpanded.request}
            onToggle={() => toggleBodyExpanded('request')}
            headersExpanded={headersExpanded.request}
            onToggleHeaders={() => toggleHeadersExpanded('request')}
            onCopy={copyBody}
          />
        );
      case 'response':
        return (
          <ResponseTab
            log={log}
            expanded={bodyExpanded.response}
            onToggle={() => toggleBodyExpanded('response')}
            headersExpanded={headersExpanded.response}
            onToggleHeaders={() => toggleHeadersExpanded('response')}
            onCopy={copyBody}
            searchTerm={searchTerm}
          />
        );
      case 'kvcache':
        return <KVCacheTab log={log} />;
      case 'context':
        return <ContextTab log={log} searchTerm={searchTerm} />;
      case 'meta':
        return <MetaTab log={log} tokenUsage={tokenUsage} />;
    }
  };

  return (
    <div className="flex-1 min-w-0 h-full flex flex-col bg-bg-panel p-3 gap-3" data-testid="detail-panel">
      {/* 头部信息区 */}
      <div className="border border-border-subtle rounded-lg px-5 py-4 flex items-center gap-6">
        {/* 左侧：请求基本信息 */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-text-quaternary text-sm">
              {new Date(log.timestamp).toLocaleString('zh-CN')}
            </span>
            <span
              className={`px-2 py-0.5 rounded-full text-sm font-[510] border border-border-primary ${
                log.request.method === 'POST'
                  ? 'text-brand-accent'
                  : 'text-success'
              }`}
            >
              {log.request.method}
            </span>
            {log.response && (
              <>
                <span
                  className={`px-2 py-0.5 rounded-full text-sm font-[510] border border-border-primary ${getStatusColor(log.response.status)}`}
                  title={log.response.statusText}
                >
                  {log.response.status}
                </span>
              </>
            )}
            <span className={`text-xs px-1.5 py-0.5 rounded border ${
              resolveResponseType(log.response?.headers['content-type'], log.metadata.stream) === 'sse'
                ? 'text-brand-accent border-brand-accent/30'
                : 'text-text-quaternary border-border-subtle'
            }`}>
              {resolveResponseType(log.response?.headers['content-type'], log.metadata.stream) === 'sse' ? 'SSE' : 'JSON'}
            </span>
          </div>
          <div className="flex items-center gap-2 text-sm text-text-tertiary truncate" title={log.request.url}>
            <Tooltip title={log.providerName ? `供应商: ${log.providerName}` : '未知供应商'}>
              <span><ProviderIcon providerName={log.providerName || ''} size={14} /></span>
            </Tooltip>
            {log.endpointType && (
              <Tooltip title={`协议: ${ENDPOINT_LABELS[log.endpointType] ?? log.endpointType}`}>
                <span><ProtocolIcon type={log.endpointType} size={14} /></span>
              </Tooltip>
            )}
            <span className="truncate">{log.request.url}</span>
          </div>
        </div>
        {/* 右侧：Token/Cache 内嵌卡片 */}
        <InlineTokenStats tokenUsage={tokenUsage} kvCache={log.kvCache} />
      </div>

      {/* Tab 卡片 - 包含导航栏 + 内容 */}
      <div className="flex-1 min-w-0 flex flex-col border border-border-subtle rounded-lg overflow-hidden">
        {/* Tab 导航栏 */}
        <div className="flex items-center gap-3 px-4 py-2 border-b border-border-subtle bg-bg-surface/30">
          {TAB_CONFIG.map((tab) => {
            const isActive = activeTab === tab.key;
            return (
              <button
                key={tab.key}
                data-testid={`tab-${tab.key}`}
                onClick={() => onTabChange(tab.key)}
                className={`px-4 py-1.5 text-[15px] font-[510] rounded-md transition-all ${
                  isActive
                    ? 'bg-bg-active text-text-primary border border-border-standard shadow-sm'
                    : 'text-text-tertiary hover:text-text-secondary border border-transparent hover:bg-bg-hover'
                }`}
              >
                {tab.label}
              </button>
            );
          })}
        </div>

        {/* Tab Content */}
        {/* key={log.id}：切日志时强制重建内容子树，重置 ResponseTab 的 sseViewMode、
            KVCacheTab 的块折叠、ContextTab 的分组折叠/选中项等内部 state。
            Body 全展开 / Headers 折叠已上提到 DetailPanel 并记忆，不在这里重置。 */}
        <div className="flex-1 min-h-0 bg-bg-deep" key={log.id}>
          {renderTabContent()}
        </div>
      </div>
    </div>
  );
}
