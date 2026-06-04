import { useState, useEffect, useRef } from 'react';
import { Empty, Spin, Typography } from 'antd';
import type { LogEntry, AgentType } from '../../types';
import { URL_SEARCH_PREVIEW_LENGTH, URL_FALLBACK_PREVIEW_LENGTH, DATE_HOVER_DELAY_MS, MS_TO_S_THRESHOLD, HTTP_ERROR_STATUS_THRESHOLD } from '../../constants';

const { Text } = Typography;

interface LogListPanelProps {
  logs: LogEntry[];
  selectedId: string | null;
  onSelectLog: (id: string) => void;
  loading: boolean;
  width: number;
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

export function LogListPanel({
  logs,
  selectedId,
  onSelectLog,
  loading,
  width,
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

  const formatTime = (timestamp: string): string => {
    const date = new Date(timestamp);
    return date.toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  };

  const formatFullDate = (timestamp: string): string => {
    const date = new Date(timestamp);
    return `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')} ${formatTime(timestamp)}`;
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

  // 时间 hover 显示日期的组件
  const TimeWithTooltip = ({ timestamp }: { timestamp: string }) => {
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
  };

  return (
    <div
      className="h-full flex flex-col border-r border-border-subtle bg-bg-panel shrink-0"
      style={{ width }}
    >
      {/* Header */}
      <div className="px-4 py-3 border-b border-border-subtle flex items-center justify-between">
        <Text className="text-text-primary text-[15px] font-[510]">
          通信记录
        </Text>
        <Text className="text-text-quaternary text-sm">
          {logs.length} 条
        </Text>
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
        <div className="flex-1 overflow-y-auto p-2">
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
                {/* 行1：Agent类型 tag + 模型名 + 时间 */}
                <div className="flex items-center gap-2 text-sm leading-[1.3]">
                  {agentTag}
                  <span
                    className={`truncate flex-1 min-w-0 font-[510] ${agentColor}`}
                    title={log.metadata.model}
                  >
                    {shortenModel(log.metadata.model)}
                  </span>
                  <TimeWithTooltip timestamp={log.timestamp} />
                </div>

                {/* 行2：请求地址 + 耗时 + 状态码 */}
                <div className="flex items-center gap-2 text-[13px] leading-[1.3]">
                  <span
                    className="text-text-quaternary truncate flex-1 min-w-0"
                    title={log.request.url}
                  >
                    {shortenUrl(log.request.url)}
                  </span>
                  <span className="shrink-0 text-text-tertiary w-[50px] text-right">
                    {log.duration > 0 ? formatDuration(log.duration) : '-'}
                  </span>
                  {log.response && (
                    <span
                      className={`font-[510] shrink-0 ${
                        log.response.status < HTTP_ERROR_STATUS_THRESHOLD ? 'text-success' : 'text-error'
                      }`}
                    >
                      {log.response.status}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
