import { useState, useCallback } from 'react';
import { Tabs, Empty, Card, Typography, Button, Space, Tag, message, Collapse } from 'antd';
import {
  FileTextOutlined,
  CodeOutlined,
  CopyOutlined,
  CaretRightOutlined,
  DatabaseOutlined,
  MessageOutlined,
  InfoCircleOutlined,
} from '@ant-design/icons';
import type { LogEntry, TabType } from '../../types';

const { Text, Paragraph } = Typography;
const { Panel } = Collapse;

interface DetailPanelProps {
  log: LogEntry | null;
  activeTab: TabType;
  onTabChange: (tab: TabType) => void;
}

interface BodyViewMode {
  request: 'json' | 'text';
  response: 'json' | 'text';
}

export function DetailPanel({ log, activeTab, onTabChange }: DetailPanelProps): JSX.Element {
  const [bodyViewMode, setBodyViewMode] = useState<BodyViewMode>({
    request: 'json',
    response: 'json',
  });

  const toggleBodyViewMode = useCallback((type: 'request' | 'response') => {
    setBodyViewMode(prev => ({
      ...prev,
      [type]: prev[type] === 'json' ? 'text' : 'json',
    }));
  }, []);

  const copyBody = useCallback((data: unknown) => {
    if (data == null) return;
    const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    navigator.clipboard.writeText(text).then(() => {
      message.success('复制成功');
    });
  }, []);

  if (!log) {
    return (
      <div className="flex items-center justify-center h-full bg-white">
        <Empty description="选择一条记录查看详情" image={Empty.PRESENTED_IMAGE_SIMPLE} />
      </div>
    );
  }

  const tabItems = [
    {
      key: 'request' as TabType,
      label: (
        <span className="flex items-center gap-1">
          <FileTextOutlined /> Request
        </span>
      ),
      children: (
        <RequestTab
          log={log}
          bodyViewMode={bodyViewMode.request}
          onToggleViewMode={() => toggleBodyViewMode('request')}
          onCopy={copyBody}
        />
      ),
    },
    {
      key: 'response' as TabType,
      label: (
        <span className="flex items-center gap-1">
          <FileTextOutlined /> Response
        </span>
      ),
      children: (
        <ResponseTab
          log={log}
          bodyViewMode={bodyViewMode.response}
          onToggleViewMode={() => toggleBodyViewMode('response')}
          onCopy={copyBody}
        />
      ),
    },
    {
      key: 'kvcache' as TabType,
      label: (
        <span className="flex items-center gap-1">
          <DatabaseOutlined /> KV-Cache
        </span>
      ),
      children: <KVCacheTab log={log} />,
    },
    {
      key: 'context' as TabType,
      label: (
        <span className="flex items-center gap-1">
          <MessageOutlined /> Context
        </span>
      ),
      children: <ContextTab log={log} />,
    },
    {
      key: 'meta' as TabType,
      label: (
        <span className="flex items-center gap-1">
          <InfoCircleOutlined /> Meta
        </span>
      ),
      children: <MetaTab log={log} />,
    },
  ];

  return (
    <div className="h-full flex flex-col bg-white">
      {/* 头部信息 */}
      <div className="px-4 py-3 border-b border-gray-200">
        <Paragraph
          className="mb-1 text-sm"
          ellipsis={{ rows: 2, expandable: true, symbol: '展开' }}
        >
          <Text type="secondary" className="text-xs">
            {new Date(log.timestamp).toLocaleString('zh-CN')}
          </Text>
          {' · '}
          <Tag color={log.request.method === 'POST' ? 'blue' : 'green'} className="text-xs">
            {log.request.method}
          </Tag>
        </Paragraph>
        <Text
          className="text-xs text-gray-600"
          ellipsis={{ tooltip: log.request.url }}
        >
          {log.request.url}
        </Text>
      </div>

      {/* Tabs */}
      <div className="flex-1 overflow-hidden">
        <Tabs
          activeKey={activeTab}
          onChange={(key) => onTabChange(key as TabType)}
          items={tabItems}
          className="h-full"
          tabBarStyle={{ marginBottom: 0, padding: '0 8px' }}
        />
      </div>
    </div>
  );
}

// ==================== Request Tab ====================

interface RequestTabProps {
  log: LogEntry;
  bodyViewMode: 'json' | 'text';
  onToggleViewMode: () => void;
  onCopy: (data: unknown) => void;
}

function RequestTab({ log, bodyViewMode, onToggleViewMode, onCopy }: RequestTabProps): JSX.Element {
  const [headersExpanded, setHeadersExpanded] = useState(false);

  const renderHeaders = () => {
    const headers = log.request.headers;
    if (!headers || Object.keys(headers).length === 0) {
      return <Text type="secondary">无 Headers</Text>;
    }
    return (
      <div className="space-y-1">
        {Object.entries(headers).map(([key, value]) => (
          <div key={key} className="flex gap-2 text-xs">
            <Text code className="shrink-0">{key}</Text>
            <Text type="secondary" className="break-all">
              {String(value)}
            </Text>
          </div>
        ))}
      </div>
    );
  };

  const renderBody = () => {
    const body = log.request.body;
    if (bodyViewMode === 'json') {
      return (
        <pre className="text-xs bg-gray-50 p-4 rounded overflow-auto max-h-96">
          {JSON.stringify(body, null, 2)}
        </pre>
      );
    }
    return (
      <pre className="text-xs bg-gray-50 p-4 rounded overflow-auto max-h-96">
        {JSON.stringify(body, null, 2)}
      </pre>
    );
  };

  return (
    <div className="p-4 h-full overflow-auto">
      {/* Headers 折叠面板 */}
      <Collapse
        ghost
        activeKey={headersExpanded ? ['headers'] : []}
        onChange={(keys) => setHeadersExpanded(keys.length > 0)}
        className="mb-4"
        expandIcon={({ isActive }) => (
          <CaretRightOutlined rotate={isActive ? 90 : 0} className="text-xs" />
        )}
      >
        <Panel
          header={<span className="text-sm font-medium">Headers</span>}
          key="headers"
          className="text-sm"
        >
          <div className="px-2">{renderHeaders()}</div>
        </Panel>
      </Collapse>

      {/* Body */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <Text strong className="text-sm">Body</Text>
          <Space size="small">
            <Button
              size="small"
              icon={bodyViewMode === 'json' ? <FileTextOutlined /> : <CodeOutlined />}
              onClick={onToggleViewMode}
            >
              {bodyViewMode === 'json' ? 'Text' : 'JSON'}
            </Button>
            <Button
              size="small"
              icon={<CopyOutlined />}
              onClick={() => onCopy(log.request.body)}
            >
              复制
            </Button>
          </Space>
        </div>
        {renderBody()}
      </div>
    </div>
  );
}

// ==================== Response Tab ====================

interface ResponseTabProps {
  log: LogEntry;
  bodyViewMode: 'json' | 'text';
  onToggleViewMode: () => void;
  onCopy: (data: unknown) => void;
}

function ResponseTab({ log, bodyViewMode, onToggleViewMode, onCopy }: ResponseTabProps): JSX.Element {
  const [headersExpanded, setHeadersExpanded] = useState(false);
  const response = log.response;

  const renderHeaders = () => {
    const headers = response.headers;
    if (!headers || Object.keys(headers).length === 0) {
      return <Text type="secondary">无 Headers</Text>;
    }
    return (
      <div className="space-y-1">
        {Object.entries(headers).map(([key, value]) => (
          <div key={key} className="flex gap-2 text-xs">
            <Text code className="shrink-0">{key}</Text>
            <Text type="secondary" className="break-all">
              {String(value)}
            </Text>
          </div>
        ))}
      </div>
    );
  };

  const renderBody = () => {
    const body = response.body;
    if (bodyViewMode === 'json') {
      return (
        <pre className="text-xs bg-gray-50 p-4 rounded overflow-auto max-h-96">
          {JSON.stringify(body, null, 2)}
        </pre>
      );
    }
    return (
      <pre className="text-xs bg-gray-50 p-4 rounded overflow-auto max-h-96">
        {JSON.stringify(body, null, 2)}
      </pre>
    );
  };

  return (
    <div className="p-4 h-full overflow-auto">
      {/* 状态信息 */}
      <div className="mb-4 flex gap-2">
        <Tag color={response.status < 400 ? 'success' : 'error'}>
          HTTP {response.status}
        </Tag>
        <Text type="secondary" className="text-xs">
          {response.statusText}
        </Text>
      </div>

      {/* Headers 折叠面板 */}
      <Collapse
        ghost
        activeKey={headersExpanded ? ['headers'] : []}
        onChange={(keys) => setHeadersExpanded(keys.length > 0)}
        className="mb-4"
        expandIcon={({ isActive }) => (
          <CaretRightOutlined rotate={isActive ? 90 : 0} className="text-xs" />
        )}
      >
        <Panel
          header={<span className="text-sm font-medium">Headers</span>}
          key="headers"
          className="text-sm"
        >
          <div className="px-2">{renderHeaders()}</div>
        </Panel>
      </Collapse>

      {/* Body */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <Text strong className="text-sm">Body</Text>
          <Space size="small">
            <Button
              size="small"
              icon={bodyViewMode === 'json' ? <FileTextOutlined /> : <CodeOutlined />}
              onClick={onToggleViewMode}
            >
              {bodyViewMode === 'json' ? 'Text' : 'JSON'}
            </Button>
            <Button
              size="small"
              icon={<CopyOutlined />}
              onClick={() => onCopy(response.body)}
            >
              复制
            </Button>
          </Space>
        </div>
        {renderBody()}
      </div>
    </div>
  );
}

// ==================== KV-Cache Tab ====================

interface KVCacheTabProps {
  log: LogEntry;
}

function KVCacheTab({ log }: KVCacheTabProps): JSX.Element {
  const [collapsed, setCollapsed] = useState({
    tools: false,
    system: false,
    messages: false,
  });

  const data = log.kvCache;
  if (!data || (!data.system?.length && !data.messages?.length && !data.tools?.length)) {
    return (
      <div className="flex items-center justify-center h-full">
        <Empty description="暂无缓存数据" image={Empty.PRESENTED_IMAGE_SIMPLE} />
      </div>
    );
  }

  const toggleCollapse = (key: keyof typeof collapsed) => {
    setCollapsed(prev => ({ ...prev, [key]: !prev[key] }));
  };

  const copyAllCache = () => {
    const parts: string[] = [];
    if (data.tools && data.tools.length > 0) {
      const indented = data.tools
        .map(xml => xml.split('\n').map(l => (l ? '  ' + l : l)).join('\n'))
        .join('\n');
      parts.push(`<tools>\n${indented}\n</tools>`);
    }
    if (data.system && data.system.length > 0) {
      parts.push(`<system-reminder>\n${data.system.join('\n\n')}\n</system-reminder>`);
    }
    if (data.messages && data.messages.length > 0) {
      data.messages.forEach(t => parts.push(t));
    }
    navigator.clipboard.writeText(parts.join('\n\n')).then(() => {
      message.success('复制成功');
    });
  };

  const hitRate = data.hitRate ?? 0;
  const hitRateColor = hitRate > 70 ? 'text-green-500' : hitRate > 30 ? 'text-yellow-500' : 'text-red-500';

  return (
    <div className="p-4 h-full overflow-auto">
      {/* Token 统计条 */}
      <div className="mb-4 p-3 bg-gray-50 rounded flex items-center justify-between">
        <div className="flex gap-4 text-xs">
          <span>
            Tokens:{' '}
            <span className="text-blue-500">
              write {data.cacheCreateTokens?.toLocaleString() ?? 0}
            </span>
            {' / '}
            <span className="text-green-500">
              read {data.cacheReadTokens?.toLocaleString() ?? 0}
            </span>
          </span>
          {hitRate > 0 && (
            <span className={hitRateColor}>
              命中率: {hitRate.toFixed(1)}%
            </span>
          )}
        </div>
        <Button
          size="small"
          icon={<CopyOutlined />}
          onClick={copyAllCache}
          className="text-xs"
        >
          复制全部
        </Button>
      </div>

      {/* Tools 区块 */}
      {data.tools && data.tools.length > 0 && (
        <Card
          size="small"
          className="mb-2"
          title={
            <div
              className="flex items-center gap-1 cursor-pointer"
              onClick={() => toggleCollapse('tools')}
            >
              <CaretRightOutlined
                rotate={collapsed.tools ? 0 : 90}
                className="text-xs"
              />
              <span className="text-sm">工具定义 ({data.tools.length})</span>
            </div>
          }
        >
          {!collapsed.tools && (
            <div className="space-y-2">
              {data.tools.map((text, i) => (
                <pre
                  key={i}
                  className="text-xs bg-gray-50 p-2 rounded overflow-auto max-h-40"
                >
                  {text}
                </pre>
              ))}
            </div>
          )}
        </Card>
      )}

      {/* System 区块 */}
      {data.system && data.system.length > 0 && (
        <Card
          size="small"
          className="mb-2"
          title={
            <div
              className="flex items-center gap-1 cursor-pointer"
              onClick={() => toggleCollapse('system')}
            >
              <CaretRightOutlined
                rotate={collapsed.system ? 0 : 90}
                className="text-xs"
              />
              <span className="text-sm">系统提示词 ({data.system.length})</span>
            </div>
          }
        >
          {!collapsed.system && (
            <div className="space-y-2">
              {data.system.map((text, i) => (
                <pre
                  key={i}
                  className="text-xs bg-gray-50 p-2 rounded overflow-auto max-h-40"
                >
                  {text}
                </pre>
              ))}
            </div>
          )}
        </Card>
      )}

      {/* Messages 区块 */}
      {data.messages && data.messages.length > 0 && (
        <Card
          size="small"
          title={
            <div
              className="flex items-center gap-1 cursor-pointer"
              onClick={() => toggleCollapse('messages')}
            >
              <CaretRightOutlined
                rotate={collapsed.messages ? 0 : 90}
                className="text-xs"
              />
              <span className="text-sm">缓存消息 ({data.messages.length})</span>
            </div>
          }
        >
          {!collapsed.messages && (
            <div className="space-y-2">
              {data.messages.map((text, i) => (
                <pre
                  key={i}
                  className="text-xs bg-gray-50 p-2 rounded overflow-auto max-h-40"
                >
                  {text}
                </pre>
              ))}
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

// ==================== Context Tab ====================

interface ContextTabProps {
  log: LogEntry;
}

function ContextTab({ log }: ContextTabProps): JSX.Element {
  const data = log.context;
  if (!data || (!data.messages?.length && !data.summary)) {
    return (
      <div className="flex items-center justify-center h-full">
        <Empty description="暂无上下文数据" image={Empty.PRESENTED_IMAGE_SIMPLE} />
      </div>
    );
  }

  const summary = data.summary;

  return (
    <div className="p-4 h-full overflow-auto">
      {/* 统计信息 */}
      {summary && (
        <div className="mb-4 grid grid-cols-4 gap-2">
          <Card size="small" className="text-center">
            <div className="text-lg font-semibold">{summary.totalMessages}</div>
            <div className="text-xs text-gray-500">总消息</div>
          </Card>
          <Card size="small" className="text-center">
            <div className="text-lg font-semibold text-blue-500">{summary.userMessages}</div>
            <div className="text-xs text-gray-500">用户</div>
          </Card>
          <Card size="small" className="text-center">
            <div className="text-lg font-semibold text-green-500">{summary.assistantMessages}</div>
            <div className="text-xs text-gray-500">助手</div>
          </Card>
          <Card size="small" className="text-center">
            <div className="text-lg font-semibold text-yellow-500">{summary.toolMessages}</div>
            <div className="text-xs text-gray-500">工具</div>
          </Card>
        </div>
      )}

      {/* 系统提示词 */}
      {data.systemPrompt && (
        <Card size="small" className="mb-2" title="系统提示词">
          <Paragraph
            ellipsis={{ rows: 3, expandable: true, symbol: '展开' }}
            className="text-xs mb-0"
          >
            <pre className="whitespace-pre-wrap">{data.systemPrompt}</pre>
          </Paragraph>
        </Card>
      )}

      {/* 可用工具 */}
      {data.tools && data.tools.length > 0 && (
        <Card size="small" className="mb-2" title={`可用工具 (${data.tools.length})`}>
          <div className="space-y-1">
            {data.tools.map((tool, i) => (
              <div key={i} className="flex gap-2 items-center text-xs">
                <Tag color="blue" className="text-xs">
                  {tool.name}
                </Tag>
                {tool.description && (
                  <Text type="secondary" className="text-xs">
                    {tool.description}
                  </Text>
                )}
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* 对话历史 */}
      {data.messages && data.messages.length > 0 && (
        <Card size="small" title={`对话历史 (${data.messages.length})`}>
          <div className="space-y-2">
            {data.messages.map((msg, i) => {
              const roleColor =
                msg.role === 'user'
                  ? 'blue'
                  : msg.tool_use_id
                    ? 'orange'
                    : 'green';

              const contentText =
                typeof msg.content === 'string'
                  ? msg.content
                  : msg.content
                      .map((block) => {
                        if (block.type === 'text' && block.text) {
                          return block.text;
                        } else if (block.type === 'tool_use') {
                          return `[工具: ${block.name}]`;
                        }
                        return '';
                      })
                      .join('\n');

              return (
                <div key={i} className="text-xs">
                  <div className="flex gap-2 items-center mb-1">
                    <Tag color={roleColor} className="text-xs">
                      {msg.role}
                    </Tag>
                    <Text type="secondary" className="text-xs">
                      {new Date(msg.timestamp).toLocaleTimeString('zh-CN')}
                    </Text>
                    {msg.name && (
                      <Tag color="purple" className="text-xs">
                        {msg.name}
                      </Tag>
                    )}
                  </div>
                  <Paragraph
                    ellipsis={{ rows: 2, expandable: true, symbol: '展开' }}
                    className="text-xs mb-0"
                  >
                    <pre className="whitespace-pre-wrap">{contentText}</pre>
                  </Paragraph>
                </div>
              );
            })}
          </div>
        </Card>
      )}
    </div>
  );
}

// ==================== Meta Tab ====================

interface MetaTabProps {
  log: LogEntry;
}

function MetaTab({ log }: MetaTabProps): JSX.Element {
  return (
    <div className="p-4 h-full overflow-auto">
      <div className="space-y-2">
        <Card size="small">
          <div className="space-y-2 text-xs">
            <div className="flex justify-between">
              <Text type="secondary">Agent 类型</Text>
              <Text strong>
                {log.agentType === 'main' ? '主 Agent' : '辅 Agent'}
              </Text>
            </div>
            {log.subAgentType && (
              <div className="flex justify-between">
                <Text type="secondary">子类型</Text>
                <Text>{log.subAgentType}</Text>
              </div>
            )}
            <div className="flex justify-between">
              <Text type="secondary">模型</Text>
              <Text>{log.metadata.model || 'Unknown'}</Text>
            </div>
            <div className="flex justify-between">
              <Text type="secondary">提供商</Text>
              <Text>{log.metadata.provider || 'Unknown'}</Text>
            </div>
            <div className="flex justify-between">
              <Text type="secondary">耗时</Text>
              <Text>{log.duration}ms</Text>
            </div>
            <div className="flex justify-between">
              <Text type="secondary">流式</Text>
              <Text>{log.metadata.stream ? '是' : '否'}</Text>
            </div>
            {log.tokenUsage && (
              <>
                <div className="flex justify-between">
                  <Text type="secondary">Input Tokens</Text>
                  <Text>{log.tokenUsage.input_tokens?.toLocaleString() ?? 0}</Text>
                </div>
                <div className="flex justify-between">
                  <Text type="secondary">Output Tokens</Text>
                  <Text>{log.tokenUsage.output_tokens?.toLocaleString() ?? 0}</Text>
                </div>
                {log.tokenUsage.cache_read_tokens && (
                  <div className="flex justify-between">
                    <Text type="secondary">Cache Read</Text>
                    <Text className="text-green-500">
                      {log.tokenUsage.cache_read_tokens.toLocaleString()}
                    </Text>
                  </div>
                )}
                {log.tokenUsage.cache_creation_tokens && (
                  <div className="flex justify-between">
                    <Text type="secondary">Cache Creation</Text>
                    <Text className="text-blue-500">
                      {log.tokenUsage.cache_creation_tokens.toLocaleString()}
                    </Text>
                  </div>
                )}
              </>
            )}
            <div className="flex justify-between">
              <Text type="secondary">请求时间</Text>
              <Text>{new Date(log.timestamp).toLocaleString('zh-CN')}</Text>
            </div>
            <div className="flex justify-between">
              <Text type="secondary">请求 ID</Text>
              <Text className="text-xs font-mono">{log.id}</Text>
            </div>
            {log.error && (
              <div className="mt-2 pt-2 border-t border-red-200">
                <Text type="danger" strong>
                  错误: {log.error}
                </Text>
              </div>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
