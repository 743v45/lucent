import { useState, useEffect, useRef } from 'react';
import { Empty, Select, Spin, Typography } from 'antd';
import type { LogEntry, AgentType, Provider, EndpointType } from '../../types';
import { ENDPOINT_LABELS, ENDPOINT_TYPES } from '../../types';
import { URL_SEARCH_PREVIEW_LENGTH, URL_FALLBACK_PREVIEW_LENGTH, DATE_HOVER_DELAY_MS, MS_TO_S_THRESHOLD, getStatusColor } from '../../constants';
import { resolveResponseType } from '../../utils/response-type';
import { ClientIcon } from '../common/ClientIcon';
import { ProviderIcon } from '../common/ProviderIcon';
import { ProtocolIcon } from '../common/ProtocolIcon';
import { Tooltip } from 'antd';

const { Text } = Typography;

interface LogListPanelProps {
  logs: LogEntry[];
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

export function LogListPanel({
  logs,
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

  return (
    <div
      className="h-full flex flex-col border-r border-border-subtle bg-bg-panel shrink-0"
      style={{ width }}
    >
      {/* Header */}
      <div className="px-4 py-3 border-b border-border-subtle flex items-center gap-2 min-w-0">
        <Text className="text-text-primary text-[15px] font-[510] shrink-0">
          通信记录
        </Text>
        <div className="ml-auto flex items-center gap-2 min-w-0 shrink">
          {providers && onProviderFilterChange && (
            <Select
              size="small"
              className="shrink min-w-0"
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
          <Text className="text-text-quaternary text-sm shrink-0">
            {logs.length} 条
          </Text>
        </div>
      </div>

      {loading ? (
        <div className="flex-1 flex items-center justify-center min-h-[200px]">
          <Spin tip="加载中..." />
        </div>
      ) : logs.length === 0 ? (
        <div className="flex-1 flex items-center justify-center min-h-[200px]">
          <Empty
            description="暂无通信记录"
            image={Empty.PRESENTED_IMAGE_SIMPLE}
          />
        </div>
      ) : (
        <div
          className="flex-1 overflow-y-auto p-2"
          onScroll={(e) => {
            const el = e.currentTarget;
            if (el.scrollHeight - el.scrollTop - el.clientHeight < 100 && hasMore && !loadingMore) {
              onLoadMore();
            }
          }}
        >
          {logs.map((log) => {
            const isSelected = selectedId === log.id;
            const { tag: agentTag, color: agentColor } = getAgentTypeTag(log.agentType);
            return (
              <div
                key={log.id}
                onClick={() => onSelectLog(log.id)}
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
                      className={`font-[510] shrink-0 ${getStatusColor(log.response.status)}`}
                    >
                      {log.response.status}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
          {loadingMore && (
            <div className="flex justify-center py-3">
              <Spin size="small" />
            </div>
          )}
        </div>
      )}
    </div>
  );
}