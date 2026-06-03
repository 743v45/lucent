import { Empty, Spin, Typography } from 'antd';
import {
  CheckCircleOutlined,
  LoadingOutlined,
  CloseCircleOutlined,
} from '@ant-design/icons';
import type { LogEntry, AgentType } from '../../types';

const { Text } = Typography;

interface LogListPanelProps {
  logs: LogEntry[];
  selectedId: string | null;
  onSelectLog: (id: string) => void;
  loading: boolean;
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
}: LogListPanelProps): JSX.Element {
  const getLogIcon = (log: LogEntry): JSX.Element => {
    if (log.error) {
      return <CloseCircleOutlined className="text-sm text-error" />;
    }
    if (log.duration === 0) {
      return <LoadingOutlined className="text-sm text-warning animate-spin" />;
    }
    return <CheckCircleOutlined className="text-sm text-success" />;
  };

  const getAgentTypeTag = (agentType: AgentType): JSX.Element => {
    if (agentType === 'main') {
      return (
        <span className="px-2 py-0.5 rounded-full text-sm font-[510] border border-border-primary text-brand-accent">
          M
        </span>
      );
    }
    return (
      <span className="px-2 py-0.5 rounded-full text-sm font-[510] border border-border-primary text-text-tertiary">
        S
      </span>
    );
  };

  const formatDuration = (ms: number): string => {
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  };

  const formatTime = (timestamp: string): string => {
    const date = new Date(timestamp);
    return date.toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  };

  return (
    <div className="w-[300px] h-full flex flex-col border-r border-border-subtle bg-bg-panel">
      {/* Header */}
      <div className="px-4 py-3 border-b border-border-subtle flex items-baseline gap-2">
        <Text className="text-text-primary text-[15px] font-[510]">
          通信记录
        </Text>
        <Text className="text-text-tertiary text-sm">
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
        <div className="flex-1 overflow-y-auto">
          {logs.map((log) => {
            const isSelected = selectedId === log.id;
            return (
              <div
                key={log.id}
                onClick={() => onSelectLog(log.id)}
                className={`
                  h-[56px] px-3 py-1.5 flex flex-col justify-center gap-1 cursor-pointer
                  transition-colors duration-150
                  ${isSelected
                    ? 'bg-bg-elevated border-l-2 border-l-brand-accent'
                    : 'hover:bg-bg-surface border-l-2 border-l-transparent'
                  }
                `}
              >
                {/* 行1：模型名 + 标签 + 状态码 */}
                <div className="flex items-center gap-2 text-sm leading-[1.3]">
                  {getLogIcon(log)}
                  <span
                    className="text-text-primary truncate flex-1 min-w-0 font-[510]"
                    title={log.metadata.model}
                  >
                    {shortenModel(log.metadata.model)}
                  </span>
                  {getAgentTypeTag(log.agentType)}
                  {log.subAgentType && (
                    <span className="px-2 py-0.5 rounded-full text-sm font-[510] border border-border-primary text-text-tertiary">
                      {log.subAgentType}
                    </span>
                  )}
                  {log.response && (
                    <span
                      className={`text-xs font-[510] shrink-0 ${
                        log.response.status < 400 ? 'text-success' : 'text-error'
                      }`}
                    >
                      {log.response.status}
                    </span>
                  )}
                </div>

                {/* 行2：时间 + 耗时 + token */}
                <div className="flex items-center gap-2 text-[13px] leading-[1.3] text-text-tertiary">
                  <span className="shrink-0">
                    {formatTime(log.timestamp)}
                  </span>
                  {log.duration > 0 && (
                    <span className="shrink-0">
                      {formatDuration(log.duration)}
                    </span>
                  )}
                  {log.tokenUsage && (
                    <span className="text-text-quaternary text-xs ml-auto shrink-0">
                      {log.tokenUsage.input_tokens + log.tokenUsage.output_tokens}t
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
