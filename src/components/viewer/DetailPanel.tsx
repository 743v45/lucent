import { useState, useCallback, useEffect, useMemo } from 'react';
import type { LogEntry, TabType, SSERawBody, SSERawLine } from '../../types';
import { ENDPOINT_LABELS } from '../../types';
import { COPIED_FEEDBACK_DURATION_MS, TOKEN_FORMAT_THRESHOLD_MILLION, TOKEN_FORMAT_THRESHOLD_KILO, JSON_COLLAPSED_EXPAND_LEVEL, getStatusColor } from '../../constants';
import { JsonView, darkStyles } from 'react-json-view-lite';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { extractFromSSELines, extractedToResponseBody } from '../../utils/sse-extractor';
import 'react-json-view-lite/dist/index.css';
import './DetailPanel.css';
import { ProviderIcon } from '../common/ProviderIcon';
import { ProtocolIcon } from '../common/ProtocolIcon';
import { Tooltip } from 'antd';


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

/**
 * 从日志的响应体中提取 token 使用情况（前端 fallback）
 * 覆盖三种情况：tokenUsage 已有、非流式 JSON 响应、SSE 流式响应
 */
function resolveTokenUsage(log: LogEntry) {
  // 1. 服务端已映射好的 tokenUsage
  if (log.tokenUsage?.input_tokens || log.tokenUsage?.output_tokens) {
    return log.tokenUsage;
  }

  const body = log.response?.body;

  // 2. 非流式 JSON 响应：从 response.body.usage 提取（Anthropic 字段名）
  if (body && typeof body === 'object' && body.type !== 'sse_raw') {
    const usage = (body as any).usage;
    if (usage && typeof usage === 'object') {
      return {
        input_tokens: usage.input_tokens ?? 0,
        output_tokens: usage.output_tokens ?? 0,
        cache_creation_tokens: usage.cache_creation_input_tokens,
        cache_read_tokens: usage.cache_read_input_tokens,
      };
    }
  }

  // 3. SSE 流式响应：从 SSE 原始行提取
  if (body && typeof body === 'object' && (body as SSERawBody).type === 'sse_raw') {
    const lines = (body as SSERawBody).lines;
    if (lines?.length) {
      const extracted = extractFromSSELines(lines);
      if (extracted.usage.input > 0 || extracted.usage.output > 0) {
        return {
          input_tokens: extracted.usage.input,
          output_tokens: extracted.usage.output,
          cache_creation_tokens: extracted.usage.cache_create || undefined,
          cache_read_tokens: extracted.usage.cache_read || undefined,
        };
      }
    }
  }

  return undefined;
}

function InlineTokenStats({ log }: { log: LogEntry }) {
  const tokenUsage = resolveTokenUsage(log);
  const inputTokens = tokenUsage?.input_tokens;
  const outputTokens = tokenUsage?.output_tokens;
  const cacheCreate = tokenUsage?.cache_creation_tokens;
  const cacheRead = tokenUsage?.cache_read_tokens;
  const hitRate = log.kvCache?.hitRate ?? 0;
  const hasHitRate = log.kvCache?.hitRate != null && log.kvCache.hitRate > 0;

  return (
    <div className="shrink-0 flex items-center gap-4 font-mono text-sm">
      <div className="rounded-lg bg-bg-surface/50 px-3 py-2 space-y-1">
        <div className="flex items-center gap-3">
          <span className="text-text-quaternary">input: <span className="text-text-primary tabular-nums">{formatTokenValue(inputTokens)}</span></span>
          <span className="text-text-quaternary">output: <span className="text-text-primary tabular-nums">{formatTokenValue(outputTokens)}</span></span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-text-quaternary">create: <span className="text-text-primary tabular-nums">{formatTokenValue(cacheCreate)}</span></span>
          <span className="text-text-quaternary">read: <span className="text-text-primary tabular-nums">{formatTokenValue(cacheRead)}</span></span>
        </div>
      </div>
      <span className={`font-[510] text-base ${hasHitRate ? (hitRate > 70 ? 'text-success' : hitRate > 30 ? 'text-warning' : 'text-error') : 'text-text-quaternary'}`}>
        {hasHitRate ? `${hitRate.toFixed(1)}%` : ' '}
      </span>
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
              log.metadata.stream
                ? 'text-brand-accent border-brand-accent/30'
                : 'text-text-quaternary border-border-subtle'
            }`}>
              {log.metadata.stream ? 'SSE' : 'JSON'}
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
        <InlineTokenStats log={log} />
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
  // JsonView 需要 object 或 array 类型，字符串需要包装
  const jsonData = typeof data === 'string' ? { text: data } : data as object;

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

// ==================== SSE View Mode Toggle ====================

type SSEViewMode = 'extracted' | 'raw';

function SSEViewToggle({ mode, onModeChange }: { mode: SSEViewMode; onModeChange: (m: SSEViewMode) => void }) {
  return (
    <div className="flex items-center rounded-md border border-border-subtle overflow-hidden">
      <button
        onClick={() => onModeChange('extracted')}
        className={`px-2.5 py-0.5 text-[13px] font-[510] transition-colors ${
          mode === 'extracted'
            ? 'bg-bg-active text-text-primary'
            : 'text-text-quaternary hover:text-text-secondary bg-bg-deep'
        }`}
      >
        结构化
      </button>
      <button
        onClick={() => onModeChange('raw')}
        className={`px-2.5 py-0.5 text-[13px] font-[510] transition-colors ${
          mode === 'raw'
            ? 'bg-bg-active text-text-primary'
            : 'text-text-quaternary hover:text-text-secondary bg-bg-deep'
        }`}
      >
        原始 SSE
      </button>
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

/**
 * 将原始 SSE lines 重建为实际的 SSE 文本流格式
 * 输出格式：event: xxx\ndata: {...}\n\n
 */
function sseLinesToRawText(lines: SSERawLine[]): string {
  return lines.map(line => {
    const parts: string[] = [];
    if (line.event) {
      parts.push(`event: ${line.event}`);
    }
    parts.push(`data: ${line.data}`);
    return parts.join('\n');
  }).join('\n\n');
}

function ResponseTab({ log, bodyCollapsed, onToggleCollapsed, onCopy }: ResponseTabProps): JSX.Element {
  const response = log.response;
  const [sseViewMode, setSseViewMode] = useState<SSEViewMode>('extracted');

  // 判断是否为 SSE 原始数据
  const isSSE = response.body != null
    && typeof response.body === 'object'
    && (response.body as SSERawBody).type === 'sse_raw';

  const sseBody = isSSE ? response.body as SSERawBody : null;

  // 计算结构化展示内容（非 raw 模式使用）
  const extractedBody = useMemo(() => {
    const body = response.body;
    if (!isSSE) return body;

    // SSE 错误
    if (sseBody?.error) {
      return { type: 'sse_raw', error: sseBody.error, linesCount: sseBody.lines?.length || 0 };
    }

    // 结构化模式：提取后展示
    const extracted = extractFromSSELines(sseBody!.lines);
    return extractedToResponseBody(extracted);
  }, [response.body, isSSE, sseBody]);

  // 原始 SSE 文本（raw 模式使用）
  const rawSSEText = useMemo(() => {
    if (!isSSE || !sseBody?.lines?.length) return '';
    return sseLinesToRawText(sseBody.lines);
  }, [isSSE, sseBody]);

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
          <span className="text-[17px] font-[510] text-text-secondary">
            Body
            {isSSE && sseBody && (
              <span className="ml-2 text-sm font-normal text-text-quaternary">
                ({sseBody.lines?.length ?? 0} events)
              </span>
            )}
          </span>
          <div className="flex items-center gap-2">
            {isSSE && (
              <SSEViewToggle mode={sseViewMode} onModeChange={setSseViewMode} />
            )}
            <CollapseButton collapsed={bodyCollapsed} onToggle={onToggleCollapsed} />
            <CopyButton onCopy={() => onCopy(sseViewMode === 'raw' ? rawSSEText : extractedBody)} />
          </div>
        </div>
        <div className="flex-1 min-h-0">
          {sseViewMode === 'raw' && isSSE ? (
            <pre className="h-full text-lg leading-relaxed bg-bg-deep p-3 rounded-lg font-mono text-text-secondary overflow-auto whitespace-pre-wrap break-words" style={{ backgroundColor: '#08090a' }}>
              {rawSSEText}
            </pre>
          ) : (
            <JsonBlock data={extractedBody} collapsed={bodyCollapsed} />
          )}
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
          <MetaRow
            label="Agent 类型"
            value={log.agentType === 'main' ? 'MainAgent' : 'SubAgent'}
            description="请求的发起方类型。MainAgent 为主代理（用户直接交互），SubAgent 为子代理（由主代理调度）"
          />
          {log.subAgentType && (
            <MetaRow
              label="子类型"
              value={log.subAgentType}
              description="SubAgent 的功能分类，如 plan（规划）、search（搜索）、bash（命令执行）、workflow（工作流）"
            />
          )}
          <MetaRow
            label="模型"
            value={log.metadata.model || 'Unknown'}
            description="处理此请求的 AI 模型标识符，如 claude-sonnet-4-5、gpt-4o 等"
          />
          <MetaRow
            label="提供商"
            value={log.metadata.provider || 'Unknown'}
            description="API 服务提供商，决定请求转发的目标端点"
          />
          <MetaRow
            label="供应商"
            value={log.providerName || '-'}
            valuePrefix={log.providerName ? <ProviderIcon providerName={log.providerName} size={14} /> : undefined}
            description="请求实际经过的供应商名称（来自配置中的 provider.name），可追踪请求路径"
          />
          <MetaRow
            label="端点协议"
            value={log.endpointType || '-'}
            description="请求使用的端点协议：openai-chat、openai-responses 或 anthropic-messages"
          />
          <MetaRow
            label="耗时"
            value={`${log.duration}ms`}
            description="从请求发出到收到完整响应的总耗时（含网络传输）"
          />
          <MetaRow
            label="流式"
            value={log.metadata.stream ? '是' : '否'}
            description="是否使用 SSE 流式传输。开启后响应会逐步返回，适合长文本生成"
          />
          {log.tokenUsage && (
            <>
              <MetaRow
                label="Input Tokens"
                value={log.tokenUsage.input_tokens?.toLocaleString() ?? '0'}
                description="请求中包含的输入 token 数量（含系统提示词和用户消息）"
              />
              <MetaRow
                label="Output Tokens"
                value={log.tokenUsage.output_tokens?.toLocaleString() ?? '0'}
                description="模型生成的输出 token 数量"
              />
              {log.tokenUsage.cache_read_tokens != null && (
                <MetaRow
                  label="Cache Read"
                  value={log.tokenUsage.cache_read_tokens.toLocaleString()}
                  valueClassName="text-success"
                  description="从缓存读取的 token 数量，命中缓存可降低延迟和费用"
                />
              )}
              {log.tokenUsage.cache_creation_tokens != null && (
                <MetaRow
                  label="Cache Creation"
                  value={log.tokenUsage.cache_creation_tokens.toLocaleString()}
                  valueClassName="text-brand-accent"
                  description="写入缓存的 token 数量，首次请求时创建"
                />
              )}
            </>
          )}
          <MetaRow
            label="请求时间"
            value={new Date(log.timestamp).toLocaleString('zh-CN')}
            description="请求发起的时间戳"
          />
          <MetaRow
            label="请求 ID"
            value={log.id}
            mono
            description="请求的唯一标识符，用于追踪和调试"
          />
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
  valuePrefix,
  description,
}: {
  label: string;
  value: string;
  mono?: boolean;
  valueClassName?: string;
  valuePrefix?: React.ReactNode;
  description?: string;
}) {
  return (
    <div className="flex justify-between items-center">
      <span className="text-text-secondary flex items-center gap-1.5">
        {label}
        {description && (
          <span className="group relative inline-flex items-center">
            <svg
              className="w-3.5 h-3.5 text-text-quaternary cursor-help"
              fill="none"
              viewBox="0 0 16 16"
              stroke="currentColor"
              strokeWidth={1.5}
            >
              <circle cx="8" cy="8" r="6.5" />
              <path strokeLinecap="round" d="M8 7v4M8 5.5v0" />
            </svg>
            <span className="invisible group-hover:visible opacity-0 group-hover:opacity-100 transition-opacity duration-150 absolute left-0 top-full mt-2 px-3 py-2 bg-bg-surface rounded-lg border border-border-subtle shadow-lg text-[13px] text-text-secondary leading-relaxed w-max max-w-[420px] z-50 pointer-events-none whitespace-normal">
              {description}
            </span>
          </span>
        )}
      </span>
      <span
        className={`text-text-primary flex items-center gap-1 ${mono ? 'font-mono text-sm' : ''} ${valueClassName}`}
      >
        {valuePrefix}
        {value}
      </span>
    </div>
  );
}
