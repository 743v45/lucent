import React from 'react';
import { List, Empty, Spin, Tag, Typography, Space } from 'antd';
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
      return <Tag color="blue">Main</Tag>;
    }
    return <Tag color="default">Sub</Tag>;
  };

  const getProviderTag = (provider: string): JSX.Element | null => {
    const colors: Record<string, string> = {
      openai: 'green',
      claude: 'blue',
    };
    const color = colors[provider] || 'default';
    return <Tag color={color}>{provider}</Tag>;
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
        <Space direction="vertical" size="small" style={{ width: '100%' }}>
          <Text strong>通信记录</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            共 {logs.length} 条
          </Text>
        </Space>
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
                <div className="log-item-top">
                  <Space size="small">
                    {getLogIcon(log)}
                    <Text strong>{log.metadata.model || 'Unknown'}</Text>
                    {getAgentTypeTag(log.agentType)}
                    {log.subAgentType && (
                      <Tag color="purple" style={{ fontSize: 10 }}>
                        {log.subAgentType}
                      </Tag>
                    )}
                    {getProviderTag(log.metadata.provider)}
                  </Space>
                </div>
                <div className="log-item-bottom">
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {formatTime(log.timestamp)}
                  </Text>
                  {log.duration > 0 && (
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      · {formatDuration(log.duration)}
                    </Text>
                  )}
                  {log.tokenUsage && (
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      · {log.tokenUsage.input_tokens + log.tokenUsage.output_tokens} tokens
                    </Text>
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
