import { useState, useCallback, useEffect } from 'react';
import type { LogEntry, TabType } from '../../types';
import { COPIED_FEEDBACK_DURATION_MS, TOKEN_FORMAT_THRESHOLD_MILLION, TOKEN_FORMAT_THRESHOLD_KILO, JSON_COLLAPSED_EXPAND_LEVEL } from '../../constants';
import { JsonView, darkStyles } from 'react-json-view-lite';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import 'react-json-view-lite/dist/index.css';
import './DetailPanel.css';

// ==================== Chevron Icon ====================

function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg
      className={`w-3 h-3 text-text-quaternary transition-transform duration-150 ${expanded ? 'rotate-90' : ''}`}
      fill="currentColor"
      viewBox="0 0 20 20"
    >
      <path
        fillRule="evenodd"
        d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z"
        clipRule="evenodd"
      />
    </svg>
  );
}

// ==================== Copy Button ====================

function CopyButton({ onCopy }: { onCopy: () => void }) {
  const [copied, setCopied] = useState(false);

  const handleClick = () => {
    onCopy();
    setCopied(true);
  };

  useEffect(() => {
    if (copied) {
      const timer = setTimeout(() => setCopied(false), COPIED_FEEDBACK_DURATION_MS);
      return () => clearTimeout(timer);
    }
  }, [copied]);

  return (
    <button
      onClick={handleClick}
      className={`px-3 py-0.5 text-[13px] font-[510] rounded-md transition-colors ${
        copied
          ? 'text-success bg-success/20'
          : 'text-text-quaternary hover:text-text-secondary bg-bg-active'
      }`}
    >
      {copied ? '已复制' : '复制'}
    </button>
  );
}

// ==================== Collapse Button ====================

function CollapseButton({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      className="px-3 py-0.5 text-[13px] font-[510] text-text-quaternary hover:text-text-secondary bg-bg-active rounded-md transition-colors"
    >
      {collapsed ? '展开' : '折叠'}
    </button>
  );
}

// ==================== Format Helpers ====================

function formatTokenValue(n: number | undefined): string {
  if (n == null) return '0';
  if (n >= TOKEN_FORMAT_THRESHOLD_MILLION) return `${(n / TOKEN_FORMAT_THRESHOLD_MILLION).toFixed(1)}M`;
  if (n >= TOKEN_FORMAT_THRESHOLD_KILO) return `${(n / TOKEN_FORMAT_THRESHOLD_KILO).toFixed(1)}K`;
  return String(n);
}

// ==================== Token Stats Card ====================

function TokenStatsCard({ log }: { log: LogEntry }) {
  const hasTokenData = log.tokenUsage != null;
  const hasHitRate = log.kvCache?.hitRate != null && log.kvCache.hitRate > 0;

  if (!hasTokenData && !hasHitRate) return null;

  const inputTokens = log.tokenUsage?.input_tokens;
  const outputTokens = log.tokenUsage?.output_tokens;
  const cacheCreate = log.tokenUsage?.cache_creation_tokens;
  const cacheRead = log.tokenUsage?.cache_read_tokens;
  const hitRate = log.kvCache?.hitRate ?? 0;

  return (
    <div className="rounded-lg border border-border-subtle overflow-hidden shrink-0 font-mono">
      <div className="flex h-full">
        {/* 左栏：数据区 */}
        <div className="flex flex-col">
          {/* 第一行：Token */}
          <div className="flex items-center px-3 py-1.5 gap-3 border-b border-border-subtle">
            <span className="text-text-secondary font-[510]">Token</span>
            <span className="text-text-quaternary">
              input: <span className="text-text-primary">{formatTokenValue(inputTokens)}</span>
            </span>
            <span className="text-text-quaternary">
              output: <span className="text-text-primary">{formatTokenValue(outputTokens)}</span>
            </span>
          </div>
          {/* 第二行：Cache */}
          <div className="flex items-center px-3 py-1.5 gap-3">
            <span className="text-text-secondary font-[510]">Cache</span>
            <span className="text-text-quaternary">
              create: <span className="text-text-primary">{formatTokenValue(cacheCreate)}</span>
            </span>
            <span className="text-text-quaternary">
              read: <span className="text-text-primary">{formatTokenValue(cacheRead)}</span>
            </span>
          </div>
        </div>
        {/* 竖分隔线 */}
        <div className="border-l border-border-subtle" />
        {/* 右栏：命中率（竖跨两行） */}
        <div className="flex flex-col items-center justify-center px-4">
          {hasHitRate ? (
            <>
              <span className="text-text-primary font-[510]">{hitRate.toFixed(1)}%</span>
              <span className="text-text-quaternary text-xs">命中率</span>
            </>
          ) : (
            <span className="text-text-quaternary text-xs">—</span>
          )}
        </div>
      </div>
    </div>
  );
}

// ==================== DetailPanel ====================

interface DetailPanelProps {
  log: LogEntry | null;
  activeTab: TabType;
  onTabChange: (tab: TabType) => void;
}

interface BodyCollapsedState {
  request: boolean;
  response: boolean;
}

const TAB_CONFIG: { key: TabType; label: string }[] = [
  { key: 'request', label: 'Request' },
  { key: 'response', label: 'Response' },
  { key: 'kvcache', label: 'KV-Cache' },
  { key: 'context', label: 'Context' },
  { key: 'meta', label: 'Meta' },
];

export function DetailPanel({ log, activeTab, onTabChange }: DetailPanelProps): JSX.Element {
  const [bodyCollapsed, setBodyCollapsed] = useState<BodyCollapsedState>({
    request: false, // 默认展开
    response: false,
  });

  const toggleBodyCollapsed = useCallback((type: 'request' | 'response') => {
    setBodyCollapsed(prev => ({
      ...prev,
      [type]: !prev[type],
    }));
  }, []);

  const copyBody = useCallback((data: unknown) => {
    if (data == null) return;
    const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    navigator.clipboard.writeText(text);
  }, []);

  if (!log) {
    return (
      <div className="flex-1 min-w-0 flex items-center justify-center h-full bg-bg-panel">
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
            bodyCollapsed={bodyCollapsed.request}
            onToggleCollapsed={() => toggleBodyCollapsed('request')}
            onCopy={copyBody}
          />
        );
      case 'response':
        return (
          <ResponseTab
            log={log}
            bodyCollapsed={bodyCollapsed.response}
            onToggleCollapsed={() => toggleBodyCollapsed('response')}
            onCopy={copyBody}
          />
        );
      case 'kvcache':
        return <KVCacheTab log={log} />;
      case 'context':
        return <ContextTab log={log} />;
      case 'meta':
        return <MetaTab log={log} />;
    }
  };

  return (
    <div className="flex-1 min-w-0 h-full flex flex-col bg-bg-panel p-3 gap-3">
      {/* 头部信息区 */}
      <div className="flex gap-3">
      {/* 左侧：请求基本信息 */}
      <div className="flex-1 min-w-0 border border-border-subtle rounded-lg px-5 py-4">
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
                className={`px-2 py-0.5 rounded-full text-sm font-[510] border border-border-primary ${
                  log.response.status >= 400 ? 'text-error' : 'text-success'
                }`}
                title={log.response.statusText}
              >
                {log.response.status}
              </span>
            </>
          )}
        </div>
        <div className="text-sm text-text-tertiary truncate" title={log.request.url}>
          {log.request.url}
        </div>
      </div>
      {/* 右侧：Token/Cache 统计 */}
      <TokenStatsCard log={log} />
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
        <div className="flex-1 min-h-0 bg-bg-deep">
          {renderTabContent()}
        </div>
      </div>
    </div>
  );
}

// ==================== Collapsible Section ====================

function CollapsibleSection({
  title,
  defaultExpanded = false,
  children,
}: {
  title: string;
  defaultExpanded?: boolean;
  children: React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  const handleToggle = () => {
    setExpanded(!expanded);
  };

  return (
    <div className="mb-3">
      <button
        onClick={handleToggle}
        className="flex items-center gap-2 w-full text-left py-1 text-[17px] font-[510] text-text-secondary hover:text-text-primary transition-colors"
      >
        <ChevronIcon expanded={expanded} />
        {title}
      </button>
      {expanded && <div className="mt-2 ml-4">{children}</div>}
    </div>
  );
}

// ==================== Headers Display ====================

function HeadersDisplay({ headers }: { headers: Record<string, string> | undefined }) {
  if (!headers || Object.keys(headers).length === 0) {
    return <span className="text-text-quaternary text-sm">无 Headers</span>;
  }
  return (
    <div className="space-y-1">
      {Object.entries(headers).map(([key, value]) => (
        <div key={key} className="flex gap-2 text-sm">
          <code className="text-text-tertiary shrink-0 font-mono bg-bg-elevated/50 px-2 py-0.5 rounded-sm text-sm">
            {key}
          </code>
          <span className="text-text-secondary break-all">{String(value)}</span>
        </div>
      ))}
    </div>
  );
}

// ==================== JSON Block ====================

function JsonBlock({
  data,
  collapsed = false,
}: {
  data: unknown;
  collapsed?: boolean;
}) {
  const jsonData = typeof data === 'string' ? data : data;

  return (
    <div
      className="h-full text-lg leading-relaxed bg-bg-deep p-3 rounded-lg font-mono text-text-secondary overflow-auto json-view-enhanced"
      style={{ backgroundColor: '#08090a' }}
    >
      <JsonView
        data={jsonData}
        shouldExpandNode={(level) => collapsed ? level < JSON_COLLAPSED_EXPAND_LEVEL : true}
        {...darkStyles}
      />
    </div>
  );
}

// ==================== Request Tab ====================

interface RequestTabProps {
  log: LogEntry;
  bodyCollapsed: boolean;
  onToggleCollapsed: () => void;
  onCopy: (data: unknown) => void;
}

function RequestTab({ log, bodyCollapsed, onToggleCollapsed, onCopy }: RequestTabProps): JSX.Element {
  return (
    <div className="flex flex-col h-full bg-bg-deep">
      <div className="p-4">
        <CollapsibleSection title="Headers">
          <HeadersDisplay headers={log.request.headers} />
        </CollapsibleSection>
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 flex flex-col bg-bg-deep px-4 pb-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[17px] font-[510] text-text-secondary">Body</span>
          <div className="flex items-center gap-2">
            <CollapseButton collapsed={bodyCollapsed} onToggle={onToggleCollapsed} />
            <CopyButton onCopy={() => onCopy(log.request.body)} />
          </div>
        </div>
        <div className="flex-1 min-h-0">
          <JsonBlock data={log.request.body} collapsed={bodyCollapsed} />
        </div>
      </div>
    </div>
  );
}

// ==================== Response Tab ====================

interface ResponseTabProps {
  log: LogEntry;
  bodyCollapsed: boolean;
  onToggleCollapsed: () => void;
  onCopy: (data: unknown) => void;
}

function ResponseTab({ log, bodyCollapsed, onToggleCollapsed, onCopy }: ResponseTabProps): JSX.Element {
  const response = log.response;

  return (
    <div className="flex flex-col h-full bg-bg-deep">
      <div className="p-4">
        <CollapsibleSection title="Headers">
          <HeadersDisplay headers={response.headers} />
        </CollapsibleSection>
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 flex flex-col bg-bg-deep px-4 pb-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[17px] font-[510] text-text-secondary">Body</span>
          <div className="flex items-center gap-2">
            <CollapseButton collapsed={bodyCollapsed} onToggle={onToggleCollapsed} />
            <CopyButton onCopy={() => onCopy(response.body)} />
          </div>
        </div>
        <div className="flex-1 min-h-0">
          <JsonBlock data={response.body} collapsed={bodyCollapsed} />
        </div>
      </div>
    </div>
  );
}

// ==================== KV-Cache Tab ====================

interface KVCacheTabProps {
  log: LogEntry;
}

function KVCacheTab({ log }: KVCacheTabProps): JSX.Element {
  const data = log.kvCache;
  if (!data || (!data.system?.length && !data.messages?.length && !data.tools?.length)) {
    return (
      <div className="flex items-center justify-center h-full">
        <span className="text-text-quaternary text-base">暂无缓存数据</span>
      </div>
    );
  }

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
    navigator.clipboard.writeText(parts.join('\n\n'));
  };

  const hitRate = data.hitRate ?? 0;
  const hitRateColor =
    hitRate > 70
      ? 'text-success'
      : hitRate > 30
        ? 'text-warning'
        : 'text-error';

  // 生成所有缓存条目：工具 -> 系统提示词 -> 消息
  const allItems: Array<{ type: 'tool' | 'system' | 'message'; text: string; index: number }> = [];

  if (data.tools && data.tools.length > 0) {
    data.tools.forEach((text, i) => {
      allItems.push({ type: 'tool', text, index: i });
    });
  }
  if (data.system && data.system.length > 0) {
    data.system.forEach((text, i) => {
      allItems.push({ type: 'system', text, index: i });
    });
  }
  if (data.messages && data.messages.length > 0) {
    data.messages.forEach((text, i) => {
      allItems.push({ type: 'message', text, index: i });
    });
  }

  // 折叠状态：每个条目独立控制
  const [collapsedMap, setCollapsedMap] = useState<Record<string, boolean>>(() => {
    const initial: Record<string, boolean> = {};
    allItems.forEach(item => {
      initial[`${item.type}-${item.index}`] = false; // 默认全部展开
    });
    return initial;
  });

  const toggleCollapse = (key: string) => {
    setCollapsedMap(prev => ({ ...prev, [key]: !prev[key] }));
  };

  const getLabel = (item: { type: 'tool' | 'system' | 'message'; text: string; index: number }) => {
    switch (item.type) {
      case 'tool':
        return '工具';
      case 'system':
        return '系统提示词';
      case 'message':
        return '消息';
    }
  };

  const getLabelColor = (type: 'tool' | 'system' | 'message') => {
    switch (type) {
      case 'tool':
        return 'text-tool';
      case 'system':
        return 'text-warning';
      case 'message':
        return 'text-brand-accent';
    }
  };

  return (
    <div className="p-4">
      {/* Token 统计条 */}
      <div className="mb-4 p-3 bg-bg-surface rounded-lg flex items-center justify-between border border-border-subtle">
        <div className="flex gap-4 text-sm text-text-tertiary">
          <span>
            Tokens:{' '}
            <span className="text-brand-accent">
              write {data.cacheCreateTokens?.toLocaleString() ?? 0}
            </span>
            {' / '}
            <span className="text-success">
              read {data.cacheReadTokens?.toLocaleString() ?? 0}
            </span>
          </span>
          {hitRate > 0 && (
            <span className={hitRateColor}>
              命中率: {hitRate.toFixed(1)}%
            </span>
          )}
        </div>
        <button
          onClick={copyAllCache}
          className="px-3 py-0.5 text-sm font-[510] text-text-quaternary hover:text-text-secondary bg-bg-active rounded-md transition-colors"
        >
          复制全部
        </button>
      </div>

      {/* 每个条目独立框 */}
      <div className="space-y-3">
        {allItems.map((item) => {
          const key = `${item.type}-${item.index}`;
          const isCollapsed = collapsedMap[key];

          return (
            <div key={key} className="bg-bg-surface/50 rounded-lg border border-border-subtle">
              <button
                onClick={() => toggleCollapse(key)}
                className="flex items-center gap-2 w-full text-left px-3 py-2 text-[15px] font-[510] text-text-secondary hover:text-text-primary transition-colors"
              >
                <ChevronIcon expanded={!isCollapsed} />
                <span className={getLabelColor(item.type)}>{getLabel(item)}</span>
                <span className="text-text-quaternary">#{item.index + 1}</span>
              </button>
              {!isCollapsed && (
                <div className="px-3 pb-3">
                  <pre className="text-lg leading-relaxed bg-bg-deep/50 p-3 rounded-md overflow-auto max-h-40 font-mono text-text-secondary whitespace-pre-wrap break-words">
                    {item.text}
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

// ==================== Context Tab ====================

interface ContextTabProps {
  log: LogEntry;
}

// 选中项类型
type SelectedItem =
  | { type: 'systemPrompt' }
  | { type: 'tool'; index: number }
  | { type: 'message'; index: number }
  | null;

// 折叠分组状态
interface CollapsedGroups {
  systemPrompt: boolean;
  tools: boolean;
  messages: boolean;
}

function ContextTab({ log }: ContextTabProps): JSX.Element {
  const data = log.context;
  if (!data || (!data.messages?.length && !data.summary)) {
    return (
      <div className="flex items-center justify-center h-full">
        <span className="text-text-quaternary text-base">暂无上下文数据</span>
      </div>
    );
  }

  // 折叠状态
  const [collapsed, setCollapsed] = useState<CollapsedGroups>({
    systemPrompt: false,
    tools: false,
    messages: false,
  });

  // 选中项
  const [selected, setSelected] = useState<SelectedItem>(
    data.systemPrompt ? { type: 'systemPrompt' } : null
  );

  const toggleGroup = (group: keyof CollapsedGroups) => {
    setCollapsed(prev => ({ ...prev, [group]: !prev[group] }));
  };

  const summary = data.summary;

  // 获取选中项的内容
  const getSelectedContent = (): { title: string; content: string; contentType?: 'json' } | null => {
    if (!selected) return null;

    switch (selected.type) {
      case 'systemPrompt':
        return {
          title: '系统提示词',
          content: data.systemPrompt || '',
        };
      case 'tool':
        const tool = data.tools?.[selected.index];
        if (!tool) return null;
        return {
          title: `工具: ${tool.name}`,
          content: tool.description || '无描述',
          contentType: 'text',
        };
      case 'message':
        const msg = data.messages?.[selected.index];
        if (!msg) return null;
        const contentText =
          typeof msg.content === 'string'
            ? msg.content
            : msg.content
                .map((block) => {
                  if (block.type === 'text' && block.text) {
                    return block.text;
                  } else if (block.type === 'tool_use') {
                    const toolBlock = block as { name?: string; input?: unknown };
                    return `[工具调用: ${toolBlock.name ?? 'unknown'}]\n${JSON.stringify(toolBlock.input, null, 2)}`;
                  } else if (block.type === 'tool_result') {
                    const resultBlock = block as { content?: string };
                    return `[工具结果]\n${resultBlock.content || ''}`;
                  }
                  return '';
                })
                .join('\n\n');
        return {
          title: `${msg.role === 'user' ? '用户' : msg.role === 'assistant' ? '助手' : '工具'} - ${new Date(msg.timestamp).toLocaleTimeString('zh-CN')}`,
          content: contentText,
        };
    }
  };

  const selectedContent = getSelectedContent();

  return (
    <div className="flex h-full">
      {/* 左侧列表 */}
      <div className="w-[280px] shrink-0 overflow-auto border-r border-border-subtle bg-bg-surface/30">
        {/* 统计卡片 */}
        {summary && (
          <div className="p-3 grid grid-cols-2 gap-2">
            <div className="bg-bg-surface/50 rounded-lg border border-border-subtle p-2 text-center">
              <div className="text-[17px] font-[510] text-text-primary">{summary.totalMessages}</div>
              <div className="text-sm text-text-quaternary">总消息</div>
            </div>
            <div className="bg-bg-surface/50 rounded-lg border border-border-subtle p-2 text-center">
              <div className="text-[17px] font-[510] text-brand-accent">{summary.userMessages}</div>
              <div className="text-sm text-text-quaternary">用户</div>
            </div>
            <div className="bg-bg-surface/50 rounded-lg border border-border-subtle p-2 text-center">
              <div className="text-[17px] font-[510] text-success">{summary.assistantMessages}</div>
              <div className="text-sm text-text-quaternary">助手</div>
            </div>
            <div className="bg-bg-surface/50 rounded-lg border border-border-subtle p-2 text-center">
              <div className="text-[17px] font-[510] text-warning">{summary.toolMessages}</div>
              <div className="text-sm text-text-quaternary">工具</div>
            </div>
          </div>
        )}

        {/* 系统提示词分组 */}
        {data.systemPrompt && (
          <ContextCollapsibleGroup
            title="系统提示词"
            count={1}
            collapsed={collapsed.systemPrompt}
            onToggle={() => toggleGroup('systemPrompt')}
          >
            <ContextListItem
              label="System"
              isSelected={selected?.type === 'systemPrompt'}
              onClick={() => setSelected({ type: 'systemPrompt' })}
              color="text-warning"
            />
          </ContextCollapsibleGroup>
        )}

        {/* 工具分组 */}
        {data.tools && data.tools.length > 0 && (
          <ContextCollapsibleGroup
            title="可用工具"
            count={data.tools.length}
            collapsed={collapsed.tools}
            onToggle={() => toggleGroup('tools')}
          >
            {data.tools.map((tool, i) => (
              <ContextListItem
                key={i}
                label={tool.name}
                isSelected={selected?.type === 'tool' && selected?.index === i}
                onClick={() => setSelected({ type: 'tool', index: i })}
                color="text-brand-accent"
              />
            ))}
          </ContextCollapsibleGroup>
        )}

        {/* 消息分组 */}
        {data.messages && data.messages.length > 0 && (
          <ContextCollapsibleGroup
            title="对话历史"
            count={data.messages.length}
            collapsed={collapsed.messages}
            onToggle={() => toggleGroup('messages')}
          >
            {data.messages.map((msg, i) => {
              const roleColor =
                msg.role === 'user'
                  ? 'text-brand-accent'
                  : msg.tool_use_id
                    ? 'text-tool'
                    : 'text-success';
              const roleLabel =
                msg.role === 'user'
                  ? 'user'
                  : msg.tool_use_id
                    ? 'tool'
                    : msg.role;
              return (
                <ContextListItem
                  key={i}
                  label={`${roleLabel} - ${new Date(msg.timestamp).toLocaleTimeString('zh-CN')}`}
                  isSelected={selected?.type === 'message' && selected?.index === i}
                  onClick={() => setSelected({ type: 'message', index: i })}
                  color={roleColor}
                />
              );
            })}
          </ContextCollapsibleGroup>
        )}
      </div>

      {/* 右侧详情 */}
      <div className="flex-1 min-w-0 overflow-auto bg-bg-deep">
        {selectedContent ? (
          <div className="p-4">
            {/* 标题 */}
            <div className="mb-3 pb-3 border-b border-border-subtle">
              <h3 className="text-[17px] font-[510] text-text-primary">{selectedContent.title}</h3>
            </div>
            {/* 内容 */}
            <MarkdownContent content={selectedContent.content} />
          </div>
        ) : (
          <div className="flex items-center justify-center h-full">
            <span className="text-text-quaternary text-base">选择左侧项查看详情</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ==================== Context Collapsible Group ====================

function ContextCollapsibleGroup({
  title,
  count,
  collapsed,
  onToggle,
  children,
}: {
  title: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="border-b border-border-subtle">
      <button
        onClick={onToggle}
        className="flex items-center gap-2 w-full px-3 py-2 text-left hover:bg-bg-hover transition-colors"
      >
        <ChevronIcon expanded={!collapsed} />
        <span className="text-[15px] font-[510] text-text-secondary">{title}</span>
        <span className="text-sm text-text-quaternary">({count})</span>
      </button>
      {!collapsed && <div className="pb-1">{children}</div>}
    </div>
  );
}

// ==================== Context List Item ====================

function ContextListItem({
  label,
  isSelected,
  onClick,
  color,
}: {
  label: string;
  isSelected: boolean;
  onClick: () => void;
  color: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full px-3 py-1.5 pl-6 text-left text-sm transition-colors ${
        isSelected
          ? 'bg-bg-active text-text-primary'
          : 'text-text-tertiary hover:bg-bg-hover hover:text-text-secondary'
      }`}
    >
      <span className={`${isSelected ? '' : color} font-[510]`}>{label}</span>
    </button>
  );
}

// ==================== Markdown Content ====================

function MarkdownContent({ content }: { content: string }) {
  return (
    <div className="markdown-content">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code({ className, children, ...props }) {
            const match = /language-(\w+)/.exec(className || '');
            const codeString = String(children).replace(/\n$/, '');

            // 有语言标记的是代码块
            if (match) {
              return (
                <SyntaxHighlighter
                  style={oneDark as Record<string, React.CSSProperties>}
                  language={match[1]}
                  PreTag="div"
                  customStyle={{
                    margin: 0,
                    borderRadius: '8px',
                    fontSize: '14px',
                  }}
                >
                  {codeString}
                </SyntaxHighlighter>
              );
            }

            // 内联代码
            return (
              <code
                className="px-1.5 py-0.5 rounded bg-bg-surface/50 text-brand-accent font-mono text-sm"
                {...props}
              >
                {children}
              </code>
            );
          },
          // 表格样式
          table({ children }) {
            return (
              <div className="overflow-auto my-2">
                <table className="min-w-full border-collapse border border-border-subtle rounded-lg">
                  {children}
                </table>
              </div>
            );
          },
          th({ children }) {
            return (
              <th className="px-3 py-2 text-left text-sm font-[510] text-text-primary bg-bg-surface/50 border border-border-subtle">
                {children}
              </th>
            );
          },
          td({ children }) {
            return (
              <td className="px-3 py-2 text-sm text-text-secondary border border-border-subtle">
                {children}
              </td>
            );
          },
          // 链接
          a({ href, children }) {
            return (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-brand-accent hover:text-brand-hover underline"
              >
                {children}
              </a>
            );
          },
          // 标题
          h1({ children }) {
            return <h1 className="text-[20px] font-[510] text-text-primary mb-3 mt-4">{children}</h1>;
          },
          h2({ children }) {
            return <h2 className="text-[17px] font-[510] text-text-primary mb-2 mt-3">{children}</h2>;
          },
          h3({ children }) {
            return <h3 className="text-[15px] font-[510] text-text-primary mb-2 mt-2">{children}</h3>;
          },
          // 段落
          p({ children }) {
            return <p className="text-[15px] leading-relaxed text-text-secondary mb-2">{children}</p>;
          },
          // 列表
          ul({ children }) {
            return <ul className="list-disc list-inside mb-2 text-[15px] text-text-secondary">{children}</ul>;
          },
          ol({ children }) {
            return <ol className="list-decimal list-inside mb-2 text-[15px] text-text-secondary">{children}</ol>;
          },
          li({ children }) {
            return <li className="mb-1">{children}</li>;
          },
          // 引用
          blockquote({ children }) {
            return (
              <blockquote className="pl-3 py-2 border-l-2 border-border-subtle bg-bg-surface/30 rounded-r my-2 text-text-tertiary">
                {children}
              </blockquote>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

// ==================== Meta Tab ====================

interface MetaTabProps {
  log: LogEntry;
}

function MetaTab({ log }: MetaTabProps): JSX.Element {
  return (
    <div className="p-4">
      <div className="bg-bg-surface/50 rounded-lg border border-border-subtle p-3">
        <div className="space-y-3 text-lg">
          <MetaRow label="Agent 类型" value={log.agentType === 'main' ? 'MainAgent' : 'SubAgent'} />
          {log.subAgentType && <MetaRow label="子类型" value={log.subAgentType} />}
          <MetaRow label="模型" value={log.metadata.model || 'Unknown'} />
          <MetaRow label="提供商" value={log.metadata.provider || 'Unknown'} />
          <MetaRow label="耗时" value={`${log.duration}ms`} />
          <MetaRow label="流式" value={log.metadata.stream ? '是' : '否'} />
          {log.tokenUsage && (
            <>
              <MetaRow
                label="Input Tokens"
                value={log.tokenUsage.input_tokens?.toLocaleString() ?? '0'}
              />
              <MetaRow
                label="Output Tokens"
                value={log.tokenUsage.output_tokens?.toLocaleString() ?? '0'}
              />
              {log.tokenUsage.cache_read_tokens != null && (
                <MetaRow
                  label="Cache Read"
                  value={log.tokenUsage.cache_read_tokens.toLocaleString()}
                  valueClassName="text-success"
                />
              )}
              {log.tokenUsage.cache_creation_tokens != null && (
                <MetaRow
                  label="Cache Creation"
                  value={log.tokenUsage.cache_creation_tokens.toLocaleString()}
                  valueClassName="text-brand-accent"
                />
              )}
            </>
          )}
          <MetaRow
            label="请求时间"
            value={new Date(log.timestamp).toLocaleString('zh-CN')}
          />
          <MetaRow label="请求 ID" value={log.id} mono />
          {log.error && (
            <div className="mt-2 pt-2 border-t border-error/20">
              <span className="text-error text-[15px] font-[510]">错误: {log.error}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ==================== Meta Row ====================

function MetaRow({
  label,
  value,
  mono = false,
  valueClassName = '',
}: {
  label: string;
  value: string;
  mono?: boolean;
  valueClassName?: string;
}) {
  return (
    <div className="flex justify-between items-center">
      <span className="text-text-secondary">{label}</span>
      <span
        className={`text-text-primary ${mono ? 'font-mono text-sm' : ''} ${valueClassName}`}
      >
        {value}
      </span>
    </div>
  );
}
