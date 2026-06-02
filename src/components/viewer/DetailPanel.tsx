import React from 'react';
import { Tabs, Empty, Card, Typography } from 'antd';
import {
  FileTextOutlined,
  CheckCircleOutlined,
  DatabaseOutlined,
  MessageOutlined,
  InfoCircleOutlined,
} from '@ant-design/icons';
import ReactJson from 'react-json-view-lite';
import 'react-json-view-lite/dist/index.css';
import type { LogEntry, TabType } from '../../types';
import './DetailPanel.css';

const { Text } = Typography;

interface DetailPanelProps {
  log: LogEntry | null;
  activeTab: TabType;
  onTabChange: (tab: TabType) => void;
}

const TAB_ITEMS = [
  { key: 'request' as TabType, label: 'Request', icon: <FileTextOutlined /> },
  { key: 'response' as TabType, label: 'Response', icon: <CheckCircleOutlined /> },
  { key: 'kvcache' as TabType, label: 'KV-Cache', icon: <DatabaseOutlined /> },
  { key: 'context' as TabType, label: 'Context', icon: <MessageOutlined /> },
  { key: 'meta' as TabType, label: 'Meta', icon: <InfoCircleOutlined /> },
];

export function DetailPanel({ log, activeTab, onTabChange }: DetailPanelProps): JSX.Element {
  if (!log) {
    return (
      <div className="detail-panel">
        <div className="panel-empty">
          <Empty
            description="选择一条记录查看详情"
            image={Empty.PRESENTED_IMAGE_SIMPLE}
          />
        </div>
      </div>
    );
  }

  const tabItems = TAB_ITEMS.map(item => ({
    key: item.key,
    label: (
      <span>
        {item.icon} {item.label}
      </span>
    ),
    children: <TabContent tabKey={item.key} log={log} />,
  }));

  return (
    <div className="detail-panel">
      <div className="panel-header">
        <div className="header-info">
          <Text className="header-time" type="secondary">
            {new Date(log.timestamp).toLocaleString('zh-CN')}
          </Text>
          <Text className="header-url" ellipsis={{ tooltip: log.request.url }}>
            {log.request.url}
          </Text>
        </div>
      </div>
      <Tabs
        activeKey={activeTab}
        onChange={(key) => onTabChange(key as TabType)}
        items={tabItems}
        className="detail-tabs"
      />
    </div>
  );
}

interface TabContentProps {
  tabKey: TabType;
  log: LogEntry;
}

function TabContent({ tabKey, log }: TabContentProps): JSX.Element {
  const content = getTabContent(tabKey, log);

  if (!content) {
    return (
      <div className="tab-empty">
        <Empty description="暂无数据" />
      </div>
    );
  }

  if (content.type === 'json') {
    return (
      <div className="tab-json">
        <ReactJson src={content.data} theme="vscode" collapsed={2} />
      </div>
    );
  }

  if (content.type === 'cards') {
    return (
      <div className="tab-cards">
        {content.data.map((card, index) => (
          <Card key={index} title={card.title} size="small" style={{ marginBottom: 8 }}>
            {card.content}
          </Card>
        ))}
      </div>
    );
  }

  return <Empty description="暂无数据" />;
}

interface TabContentData {
  type: 'json' | 'cards';
  data: unknown;
}

function getTabContent(tabKey: TabType, log: LogEntry): TabContentData | null {
  switch (tabKey) {
    case 'request':
      return {
        type: 'json',
        data: {
          method: log.request.method,
          url: log.request.url,
          headers: log.request.headers,
          body: log.request.body,
        },
      };

    case 'response':
      return {
        type: 'json',
        data: {
          status: log.response.status,
          statusText: log.response.statusText,
          headers: log.response.headers,
          body: log.response.body,
        },
      };

    case 'kvcache':
      if (!log.kvCache) return null;
      return {
        type: 'cards',
        data: [
          { title: '缓存命中', content: log.kvCache.hitRate || 'N/A' },
          { title: '读取字节', content: log.kvCache.readBytes || 0 },
          { title: '写入字节', content: log.kvCache.writeBytes || 0 },
          { title: '缓存内容', content: log.kvCache.content || '无' },
        ],
      };

    case 'context':
      if (!log.context) return null;
      return {
        type: 'json',
        data: log.context,
      };

    case 'meta':
      return {
        type: 'cards',
        data: [
          { title: 'Agent 类型', content: log.agentType === 'main' ? '主 Agent' : '辅 Agent' },
          { title: '子类型', content: log.subAgentType || '无' },
          { title: '模型', content: log.metadata.model || 'Unknown' },
          { title: '提供商', content: log.metadata.provider || 'Unknown' },
          { title: '耗时', content: `${log.duration}ms` },
          { title: '流式', content: log.metadata.stream ? '是' : '否' },
          {
            title: 'Token 使用',
            content: log.tokenUsage
              ? `${log.tokenUsage.input_tokens} + ${log.tokenUsage.output_tokens}`
              : 'N/A',
          },
        ],
      };

    default:
      return null;
  }
}
