import { useState, useEffect, useRef, useMemo } from 'react';
import { Empty, Input, Select, Spin, Switch, Typography } from 'antd';
import { MagnifyingGlassIcon } from '@heroicons/react/24/outline';
import type { LogEntry, AgentType, Provider, EndpointType } from '../../types';
import { ENDPOINT_LABELS, ENDPOINT_TYPES } from '../../types';
import { URL_SEARCH_PREVIEW_LENGTH, URL_FALLBACK_PREVIEW_LENGTH, DATE_HOVER_DELAY_MS, MS_TO_S_THRESHOLD, getStatusColor } from '../../constants';
import { resolveResponseType } from '../../utils/response-type';
import { groupByThread } from '../../utils/group-by-thread';
import { ClientIcon } from '../common/ClientIcon';
import { ProviderIcon } from '../common/ProviderIcon';
import { ProtocolIcon } from '../common/ProtocolIcon';
import { ChevronIcon } from '../common/ChevronIcon';
import { Tooltip } from 'antd';

const { Text } = Typography;

interface LogListPanelProps {
  logs: LogEntry[];
  total?: number;
  selectedId: string | null;
  onSelectLog: (id: string) => void;
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  onLoadMore: () => void;
  width: number;
  providers?: Provider[];
  providerFilter?: string;
  onProviderFilterChange?: (name: string) => void;
  endpointFilter?: string;
  onEndpointFilterChange?: (type: string) => void;
  searchTerm?: string;
  onSearchChange?: (value: string) => void;
  conversationView: 'timeline' | 'session';
  onConversationViewChange: (v: 'timeline' | 'session') => void;
}

/** 截断模型名，保留关键信息 */
const shortenModel = (model: string): string => {
  if (!model || model === 'unknown') return 'unknown';
  // claude-3-5-sonnet-20241022 → claude-3.5-sonnet
  return model
    .replace(/-\d{8}$/, '')           // 去掉末尾日期 20241022
    .replace(/^claude-(\d)-(\d)-/, 'claude-$1.$2-') // claude-3-5 → claude-3.5
    .replace(/^gpt-4-(\d+)/, 'gpt-4$1')             // gpt-4-0125 → gpt-40125
    .replace(/^gpt-3\.5-turbo.*$/, 'gpt-3.5-turbo');
};

/** 来源字符串：`glm · anthropic-messages`；历史日志 fallback `-` */

/** 时间格式化：HH:mm:ss */
function formatTime(timestamp: string): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/** 完整日期：yyyy/MM/dd HH:mm:ss */
function formatFullDate(timestamp: string): string {
  const date = new Date(timestamp);
  return `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')} ${formatTime(timestamp)}`;
}

/** 临时日志到期 tooltip：剩余存活时间或已过期 */
function formatExpiresIn(expiresAt: string): string {
  const ms = Date.parse(expiresAt) - Date.now();
  if (!Number.isFinite(ms)) return '临时日志';
  if (ms <= 0) return '临时日志（已过期，即将清理）';
  const min = Math.ceil(ms / 60000);
  if (min < 60) return `临时日志，约 ${min} 分钟后自动清理`;
  return `临时日志，约 ${Math.floor(min / 60)}h${min % 60}m 后自动清理`;
}

/** 时间 hover 显示完整日期的组件（模块顶层，避免每次渲染重建类型） */
function TimeWithTooltip({ timestamp }: { timestamp: string }) {
  const [showDate, setShowDate] = useState(false);
  const timeoutRef = useRef<number | null>(null);

  const handleMouseEnter = () => {
    timeoutRef.current = window.setTimeout(() => {
      setShowDate(true);
    }, DATE_HOVER_DELAY_MS);
  };

  const handleMouseLeave = () => {
    if (timeoutRef.current) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    setShowDate(false);
  };

  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        window.clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  return (
    <span
      className="shrink-0 text-text-tertiary text-[13px] cursor-default"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      title={formatFullDate(timestamp)}
    >
      {showDate ? formatFullDate(timestamp) : formatTime(timestamp)}
    </span>
  );
}

/** 通用日志行（时间线 / 会话视图复用） */
function LogRow({
  log, isSelected, onSelect, getAgentTypeTag, shortenModel, shortenUrl, formatDuration,
}: {
  log: LogEntry;
  isSelected: boolean;
  onSelect: (id: string) => void;
  getAgentTypeTag: (a: AgentType) => { tag: JSX.Element; color: string };
  shortenModel: (m: string) => string;
  shortenUrl: (u: string) => string;
  formatDuration: (ms: number) => string;
}) {
  const { tag: agentTag, color: agentColor } = getAgentTypeTag(log.agentType);
  return (
    <div
      data-testid="log-row"
      data-logid={log.id}
      onClick={() => onSelect(log.id)}
      className={`
        mb-2 p-2 rounded-lg flex flex-col gap-1.5 cursor-pointer
        transition-colors duration-150 border
        ${isSelected
          ? 'bg-bg-elevated border-brand-accent'
          : 'bg-bg-surface border-border-subtle hover:border-border-primary'
        }
      `}
    >
      {/* 行1：Agent类型 tag + 模型名 + SSE/JSON + 时间 + 测试标记 */}
      <div className="flex items-center gap-1.5 text-sm leading-[1.3] min-w-0">
        {agentTag}
        {log.isTest && (
          <Tooltip title="测试请求">
            <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-600 font-[510]">
              hi
            </span>
          </Tooltip>
        )}
        {log.expiresAt && (
          <Tooltip title={formatExpiresIn(log.expiresAt)}>
            <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-600 font-[510]">
              临时
            </span>
          </Tooltip>
        )}
        <span
          className={`truncate flex-1 min-w-0 font-[510] ${agentColor}`}
          title={log.metadata.model}
        >
          {shortenModel(log.metadata.model)}
        </span>
        <span className={`shrink-0 text-xs px-1 rounded border ${
          resolveResponseType(log.response?.headers['content-type'], log.metadata.stream) === 'sse'
            ? 'text-brand-accent border-brand-accent/30'
            : 'text-text-quaternary border-border-subtle'
        }`}>
          {resolveResponseType(log.response?.headers['content-type'], log.metadata.stream) === 'sse' ? 'SSE' : 'JSON'}
        </span>
        <TimeWithTooltip timestamp={log.timestamp} />
      </div>

      {/* 行2：供应商 + 协议 + 客户端图标 + 请求地址 + 耗时 + 状态码 */}
      <div className="flex items-center gap-1 text-[13px] leading-[1.3] min-w-0">
        <Tooltip title={log.providerName ? `供应商: ${log.providerName}` : '未知供应商'}>
          <span className="shrink-0"><ProviderIcon providerName={log.providerName || ''} size={14} /></span>
        </Tooltip>
        {log.endpointType && (
          <Tooltip title={`协议: ${ENDPOINT_LABELS[log.endpointType] ?? log.endpointType}`}>
            <span className="shrink-0"><ProtocolIcon type={log.endpointType} size={14} /></span>
          </Tooltip>
        )}
        <span className="shrink-0"><ClientIcon clientType={log.clientType} /></span>
        <span
          className="text-text-quaternary truncate flex-1 min-w-0"
          title={log.request.url}
        >
          {shortenUrl(log.request.url)}
        </span>
        <span className="shrink-0 text-text-tertiary text-right">
          {log.duration > 0 ? formatDuration(log.duration) : '-'}
        </span>
        {log.response && (
          <span
            data-testid="log-status"
            className={`font-[510] shrink-0 ${getStatusColor(log.response.status)}`}
          >
            {log.response.status}
          </span>
        )}
      </div>
    </div>
  );
}

/** 会话视图：按 threadId 分组，可折叠展开 */
function SessionListView({ logs, selectedId, onSelectLog, getAgentTypeTag, shortenModel, shortenUrl, formatDuration }: {
  logs: LogEntry[];
  selectedId: string | null;
  onSelectLog: (id: string) => void;
  getAgentTypeTag: (a: AgentType) => { tag: JSX.Element; color: string };
  shortenModel: (m: string) => string;
  shortenUrl: (u: string) => string;
  formatDuration: (ms: number) => string;
}) {
  const { groups, ungrouped } = useMemo(() => groupByThread(logs), [logs]);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const toggle = (id: string) => setCollapsed(p => ({ ...p, [id]: !p[id] }));

  return (
    <>
      {groups.map((g) => (
        <div key={g.threadId} className="mb-2">
          <button onClick={() => toggle(g.threadId)}
            data-testid="session-group"
            data-threadid={g.threadId}
            data-count={g.mainLogs.length + g.subLogs.length}
            className="w-full flex items-center gap-2 p-2 rounded-lg bg-bg-surface border border-border-subtle hover:border-border-primary text-left">
            <ChevronIcon expanded={!collapsed[g.threadId]} />
            <span className="truncate flex-1 min-w-0 text-[13px] font-[510] text-text-secondary">{g.title}</span>
            <span className="shrink-0 text-xs text-text-quaternary">{g.mainLogs.length + g.subLogs.length} 请求</span>
            <span className="shrink-0 text-xs text-text-quaternary tabular-nums">{g.totalTokens} tok</span>
          </button>
          {!collapsed[g.threadId] && (
            <div className="mt-1">
              {[...g.mainLogs, ...g.subLogs]
                .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
                .map((log) => (
                  <LogRow key={log.id} log={log} isSelected={selectedId === log.id} onSelect={onSelectLog}
                    getAgentTypeTag={getAgentTypeTag} shortenModel={shortenModel}
                    shortenUrl={shortenUrl} formatDuration={formatDuration} />
                ))}
            </div>
          )}
        </div>
      ))}
      {ungrouped.length > 0 && (
        <div className="mt-2">
          <button onClick={() => toggle('__ungrouped')}
            className="w-full flex items-center gap-2 p-2 rounded-lg bg-bg-surface border border-border-subtle text-left">
            <ChevronIcon expanded={!collapsed['__ungrouped']} />
            <span className="text-[13px] font-[510] text-text-quaternary">未归类 ({ungrouped.length})</span>
          </button>
          {!collapsed['__ungrouped'] && ungrouped.map((log) => (
            <LogRow key={log.id} log={log} isSelected={selectedId === log.id} onSelect={onSelectLog}
              getAgentTypeTag={getAgentTypeTag} shortenModel={shortenModel}
              shortenUrl={shortenUrl} formatDuration={formatDuration} />
          ))}
        </div>
      )}
    </>
  );
}

export function LogListPanel({
  logs,
  total,
  selectedId,
  onSelectLog,
  loading,
  loadingMore,
  hasMore,
  onLoadMore,
  width,
  providers,
  providerFilter,
  onProviderFilterChange,
  endpointFilter,
  onEndpointFilterChange,
  searchTerm,
  onSearchChange,
  conversationView,
  onConversationViewChange,
}: LogListPanelProps): JSX.Element {
  // MainAgent: 金色加灰 #C9A227, SubAgent: 橙色加灰 #B87A4A
  const getAgentTypeTag = (agentType: AgentType): { tag: JSX.Element; color: string } => {
    if (agentType === 'main') {
      return {
        tag: (
          <span className="px-2 py-0.5 rounded text-sm font-[510] bg-[#C9A227]/20 text-[#C9A227]">
            MainAgent
          </span>
        ),
        color: 'text-[#C9A227]',
      };
    }
    return {
      tag: (
        <span className="px-2 py-0.5 rounded text-sm font-[510] bg-[#B87A4A]/20 text-[#B87A4A]">
          SubAgent
        </span>
      ),
      color: 'text-[#B87A4A]',
    };
  };

  const formatDuration = (ms: number): string => {
    if (ms < MS_TO_S_THRESHOLD) return `${ms}ms`;
    return `${(ms / MS_TO_S_THRESHOLD).toFixed(1)}s`;
  };

  // 截断 URL，去掉协议，显示完整地址
  const shortenUrl = (url: string): string => {
    try {
      const u = new URL(url);
      // 去掉协议，显示域名+路径
      return u.host + u.pathname + (u.search ? u.search.slice(0, URL_SEARCH_PREVIEW_LENGTH) : '');
    } catch {
      return url.replace(/^https?:\/\//, '').slice(0, URL_FALLBACK_PREVIEW_LENGTH);
    }
  };

  // 滚动容器引用：用于检测「内容不足以产生纵向滚动条」
  const scrollRef = useRef<HTMLDivElement>(null);

  // 「仅存档」过滤：隐藏临时行（expiresAt 非空）。仅当列表含临时数据时才显示开关。
  const [archiveOnly, setArchiveOnly] = useState(false);
  const displayLogs = useMemo(
    () => (archiveOnly ? logs.filter((l) => !l.expiresAt) : logs),
    [logs, archiveOnly],
  );
  const hasTemporary = logs.some((l) => l.expiresAt);

  // 方案 A（无感兜底）：筛选后匹配行太少、首屏撑不出滚动条时，onScroll 永不触发，
  // 更早的匹配日志就翻不出来。这里在每次渲染后检测——若不可滚动且仍有更多数据，
  // 自动补拉下一页，直到出现滚动条或数据耗尽。loadMore 自身有 loadingMore/hasMore 双守卫，不会重复加载。
  useEffect(() => {
    if (loading || loadingMore || !hasMore) return;
    const el = scrollRef.current;
    if (!el || el.scrollHeight > el.clientHeight) return; // 已能滚动，交给 onScroll
    onLoadMore();
  }, [logs, hasMore, loadingMore, loading, onLoadMore]);

  return (
    <div
      data-testid="log-list-panel"
      className="h-full flex flex-col border-r border-border-subtle bg-bg-panel shrink-0"
      style={{ width }}
    >
      {/* Header */}
      <div className="px-4 py-3 border-b border-border-subtle flex items-center gap-2 min-w-0">
        <Text className="text-text-primary text-[15px] font-[510] shrink-0">
          通信记录
        </Text>
        <div className="ml-auto flex items-center gap-2 min-w-0 shrink">
          <div className="flex items-center rounded-md border border-border-subtle overflow-hidden shrink-0">
            <button
              data-testid="view-timeline"
              onClick={() => onConversationViewChange('timeline')}
              className={`px-2.5 py-0.5 text-[13px] font-[510] transition-colors ${
                conversationView === 'timeline' ? 'bg-bg-active text-text-primary' : 'text-text-quaternary hover:text-text-secondary bg-bg-deep'
              }`}
            >时间线</button>
            <button
              data-testid="view-session"
              onClick={() => onConversationViewChange('session')}
              className={`px-2.5 py-0.5 text-[13px] font-[510] transition-colors ${
                conversationView === 'session' ? 'bg-bg-active text-text-primary' : 'text-text-quaternary hover:text-text-secondary bg-bg-deep'
              }`}
            >会话</button>
          </div>
          {providers && onProviderFilterChange && (
            <Select
              size="small"
              className="shrink min-w-0"
              data-testid="provider-filter"
              value={providerFilter ?? 'all'}
              onChange={(v) => onProviderFilterChange(v)}
              options={[
                { value: 'all', label: '全部供应商' },
                ...providers.map((p) => ({
                  value: p.name,
                  label: (
                    <span className="flex items-center gap-1.5">
                      <ProviderIcon providerName={p.name} size={14} />
                      {p.name}
                    </span>
                  ),
                })),
              ]}
            />
          )}
          {onEndpointFilterChange && (
            <Select
              size="small"
              className="shrink min-w-0"
              data-testid="endpoint-filter"
              value={endpointFilter ?? 'all'}
              onChange={(v) => onEndpointFilterChange(v)}
              labelRender={(option) => {
                if (option.value === 'all') return '全部协议';
                const et = option.value as EndpointType;
                return <ProtocolIcon type={et} size={14} />;
              }}
              options={[
                { value: 'all', label: '全部协议' },
                ...ENDPOINT_TYPES.map((et) => ({
                  value: et,
                  label: (
                    <span className="flex items-center gap-1.5">
                      <ProtocolIcon type={et} size={14} />
                      {ENDPOINT_LABELS[et]}
                    </span>
                  ),
                })),
              ]}
            />
          )}
          {hasTemporary && (
            <div className="flex items-center gap-1 shrink-0">
              <Switch
                data-testid="archive-only-switch"
                size="small"
                checked={archiveOnly}
                onChange={setArchiveOnly}
              />
              <span className="text-text-quaternary text-[13px]">仅存档</span>
            </div>
          )}
          <Text data-testid="log-count" className="text-text-quaternary text-sm shrink-0">
            {total ?? logs.length} 条
          </Text>
        </div>
      </div>

      {/* 搜索框（防抖在 App：searchInput → 300ms → searchTerm 触发服务端 FTS 检索） */}
      {onSearchChange && (
        <div className="px-3 py-2 border-b border-border-subtle">
          <Input
            data-testid="log-search-input"
            allowClear
            size="small"
            placeholder="搜索消息正文 / 模型 / 错误…"
            prefix={<MagnifyingGlassIcon className="w-4 h-4 text-text-quaternary" />}
            value={searchTerm ?? ''}
            onChange={(e) => onSearchChange(e.target.value)}
          />
        </div>
      )}

      {loading ? (
        <div data-testid="log-loading" className="flex-1 flex items-center justify-center min-h-[200px]">
          <Spin tip="加载中..." />
        </div>
      ) : logs.length === 0 ? (
        <div data-testid="log-empty" className="flex-1 flex items-center justify-center min-h-[200px]">
          <Empty
            description="暂无通信记录"
            image={Empty.PRESENTED_IMAGE_SIMPLE}
          />
        </div>
      ) : (
        <div
          ref={scrollRef}
          className="flex-1 overflow-y-auto p-2"
          onScroll={(e) => {
            const el = e.currentTarget;
            if (el.scrollHeight - el.scrollTop - el.clientHeight < 100 && hasMore && !loadingMore) {
              onLoadMore();
            }
          }}
        >
          {conversationView === 'timeline' ? (
            displayLogs.map((log) => (
              <LogRow key={log.id} log={log} isSelected={selectedId === log.id} onSelect={onSelectLog}
                getAgentTypeTag={getAgentTypeTag} shortenModel={shortenModel}
                shortenUrl={shortenUrl} formatDuration={formatDuration} />
            ))
          ) : (
            <SessionListView logs={displayLogs} selectedId={selectedId} onSelectLog={onSelectLog}
              getAgentTypeTag={getAgentTypeTag} shortenModel={shortenModel}
              shortenUrl={shortenUrl} formatDuration={formatDuration} />
          )}
          {loadingMore && (
            <div className="flex justify-center py-3">
              <Spin size="small" />
            </div>
          )}
          {/* 方案 B（可控兜底）：手动「加载更多」按钮，hasMore 时显示。
              即便自动补拉（方案 A）未覆盖到的场景，也给用户一个明确的「往下翻」出口。 */}
          {hasMore && !loadingMore && (
            <div className="flex justify-center pb-2">
              <button
                data-testid="load-more-btn"
                onClick={onLoadMore}
                className="px-3 py-1.5 rounded-md text-[13px] text-text-secondary border border-border-subtle hover:border-border-primary hover:text-text-primary transition-colors"
              >
                加载更多
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}