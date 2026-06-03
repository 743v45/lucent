import { List, Empty, Spin, Tag, Typography } from 'antd';
import {
  CheckCircleOutlined,
  LoadingOutlined,
  CloseCircleOutlined,
} from '@ant-design/icons';
import type { LogEntry, AgentType } from '../../types';
import './LogListPanel.css';

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
      return <CloseCircleOutlined className="log-icon error" />;
    }
    if (log.duration === 0) {
      return <LoadingOutlined className="log-icon in-progress" />;
    }
    return <CheckCircleOutlined className="log-icon success" />;
  };

  const getAgentTypeTag = (agentType: AgentType): JSX.Element => {
    if (agentType === 'main') {
      return <Tag color="blue" className="log-tag">M</Tag>;
    }
    return <Tag color="default" className="log-tag">S</Tag>;
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
    <div className="log-list-panel">
      <div className="panel-header">
        <Text strong>通信记录</Text>
        <Text type="secondary" className="panel-count">{logs.length} 条</Text>
      </div>

      {loading ? (
        <div className="panel-loading">
          <Spin tip="加载中..." />
        </div>
      ) : logs.length === 0 ? (
        <div className="panel-empty">
          <Empty
            description="暂无通信记录"
            image={Empty.PRESENTED_IMAGE_SIMPLE}
          />
        </div>
      ) : (
        <List
          className="log-list"
          dataSource={logs}
          renderItem={(log) => (
            <List.Item
              key={log.id}
              className={`log-item ${selectedId === log.id ? 'selected' : ''}`}
              onClick={() => onSelectLog(log.id)}
            >
              <div className="log-item-content">
                {/* 第一行：状态 + 时间 + 耗时 + tags */}
                <div className="log-row-primary">
                  {getLogIcon(log)}
                  <span className="log-time">{formatTime(log.timestamp)}</span>
                  {log.duration > 0 && (
                    <span className="log-duration">{formatDuration(log.duration)}</span>
                  )}
                  <span className="log-tags">
                    {getAgentTypeTag(log.agentType)}
                    {log.subAgentType && (
                      <Tag color="purple" className="log-tag">{log.subAgentType}</Tag>
                    )}
                  </span>
                </div>
                {/* 第二行：模型名 + 状态码 */}
                <div className="log-row-secondary">
                  <span className="log-model" title={log.metadata.model}>
                    {shortenModel(log.metadata.model)}
                  </span>
                  {log.response && (
                    <span className={`log-status ${log.response.status < 400 ? 'ok' : 'err'}`}>
                      {log.response.status}
                    </span>
                  )}
                  {log.tokenUsage && (
                    <span className="log-tokens">
                      {log.tokenUsage.input_tokens + log.tokenUsage.output_tokens}t
                    </span>
                  )}
                </div>
              </div>
            </List.Item>
          )}
        />
      )}
    </div>
  );
}
