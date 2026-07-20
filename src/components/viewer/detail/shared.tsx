/**
 * DetailPanel 详情面板的共享展示组件（跨 tab 复用）。
 * 从原 DetailPanel.tsx 拆出（#19 巨石拆分），行为零变更。
 *
 * 汇集：CopyButton / ExpandAllButton / CollapsibleSection / HeadersDisplay /
 * JsonBlock / SSEViewToggle / MarkdownContent。
 *
 * 关键修复：
 * - low#9：CopyButton 按真实复制结果显示「已复制」（copyText 失败不撒谎）。
 * - #18：JsonBlock 删除冗余内联 backgroundColor（.json-view-enhanced 已 !important 覆盖）。
 * - #16：MarkdownContent 的 makeHighlightRe 用 useMemo 缓存；不依赖高亮闭包的节点
 *   （code/table/ul/ol/blockquote）上提到模块级常量，依赖 hl 的节点随 hl memoize，
 *   components 对象引用稳定 → ReactMarkdown 不再每次渲染重解析。
 */
import { useState, useEffect, useMemo, useCallback } from 'react';
import type { Components } from 'react-markdown';
import { JsonView, darkStyles } from 'react-json-view-lite';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
// PrismLight 按需注册：默认 Prism 入口会打包全部 ~270 种语言（主包大头），这里只引实际会用的几种
import { PrismLight as SyntaxHighlighter } from 'react-syntax-highlighter';
import json from 'react-syntax-highlighter/dist/esm/languages/prism/json';
import bash from 'react-syntax-highlighter/dist/esm/languages/prism/bash';
import javascript from 'react-syntax-highlighter/dist/esm/languages/prism/javascript';
import typescript from 'react-syntax-highlighter/dist/esm/languages/prism/typescript';
import jsx from 'react-syntax-highlighter/dist/esm/languages/prism/jsx';
import tsx from 'react-syntax-highlighter/dist/esm/languages/prism/tsx';
import python from 'react-syntax-highlighter/dist/esm/languages/prism/python';
import markdown from 'react-syntax-highlighter/dist/esm/languages/prism/markdown';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';

import { ChevronIcon } from '../../common/ChevronIcon';
import { makeHighlightRe, highlightChildren } from '../../common/Highlight';
import { COPIED_FEEDBACK_DURATION_MS, JSON_COLLAPSED_EXPAND_LEVEL } from '../../../constants';

SyntaxHighlighter.registerLanguage('json', json);
SyntaxHighlighter.registerLanguage('bash', bash);
SyntaxHighlighter.registerLanguage('javascript', javascript);
SyntaxHighlighter.registerLanguage('typescript', typescript);
SyntaxHighlighter.registerLanguage('jsx', jsx);
SyntaxHighlighter.registerLanguage('tsx', tsx);
SyntaxHighlighter.registerLanguage('python', python);
SyntaxHighlighter.registerLanguage('markdown', markdown);

// ==================== Copy Button ====================

// low#9：onCopy 返回真实复制结果（boolean | Promise<boolean>），仅在成功时显示「已复制」——
// 非安全上下文 / 权限拒绝时 copyText 回退 execCommand，失败不再无条件撒谎。
export function CopyButton({ onCopy }: { onCopy: () => boolean | Promise<boolean> }) {
  const [copied, setCopied] = useState(false);

  const handleClick = async () => {
    const ok = await onCopy();
    // 仅真正写入剪贴板才给反馈
    if (ok) setCopied(true);
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

// ==================== Expand Button ====================

export function ExpandAllButton({ expanded, onToggle }: { expanded: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      data-testid={expanded ? 'collapse-all' : 'expand-all'}
      className="px-3 py-0.5 text-[13px] font-[510] text-text-quaternary hover:text-text-secondary bg-bg-active rounded-md transition-colors"
    >
      {expanded ? '收起全部' : '展开全部'}
    </button>
  );
}

// ==================== Collapsible Section ====================

export function CollapsibleSection({
  title,
  expanded,
  onToggle,
  testId,
  children,
}: {
  title: string;
  expanded: boolean;
  onToggle: () => void;
  testId?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-3">
      <button
        onClick={onToggle}
        data-testid={testId}
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

export function HeadersDisplay({ headers }: { headers: Record<string, string> | undefined }) {
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

// #18：删除冗余内联 backgroundColor——.json-view-enhanced 已用 background:#08090a !important 覆盖
// （见 DetailPanel.css），bg-bg-deep token 同为 #08090a，无需再叠加内联 style。
export function JsonBlock({
  data,
  expanded = false,
}: {
  data: unknown;
  expanded?: boolean;
}) {
  // JsonView 需要 object 或 array 类型，字符串需要包装
  const jsonData = typeof data === 'string' ? { text: data } : data as object;

  return (
    <div className="h-full text-lg leading-relaxed bg-bg-deep p-3 rounded-lg font-mono text-text-secondary overflow-auto json-view-enhanced">
      <JsonView
        data={jsonData}
        shouldExpandNode={expanded ? () => true : (level) => level < JSON_COLLAPSED_EXPAND_LEVEL}
        {...darkStyles}
      />
    </div>
  );
}

// ==================== SSE View Mode Toggle ====================

export type SSEViewMode = 'extracted' | 'raw';

export function SSEViewToggle({ mode, onModeChange }: { mode: SSEViewMode; onModeChange: (m: SSEViewMode) => void }) {
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

// ==================== Markdown Content ====================

// #16：不依赖高亮闭包（hl）的 markdown 节点上提到模块级常量——引用永久稳定，
// ReactMarkdown 不再因 components 新引用而重解析映射。
// 含：code（SyntaxHighlighter 重挂载的大头）/ table / ul / ol / blockquote。
const STATIC_MARKDOWN_COMPONENTS: Components = {
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
  ul({ children }) {
    return <ul className="list-disc list-inside mb-2 text-[15px] text-text-secondary">{children}</ul>;
  },
  ol({ children }) {
    return <ol className="list-decimal list-inside mb-2 text-[15px] text-text-secondary">{children}</ol>;
  },
  // 引用
  blockquote({ children }) {
    return (
      <blockquote className="pl-3 py-2 border-l-2 border-border-subtle bg-bg-surface/30 rounded-r my-2 text-text-tertiary">
        {children}
      </blockquote>
    );
  },
};

export function MarkdownContent({ content, highlight }: { content: string; highlight?: string }): JSX.Element {
  // #16：搜索命中高亮正则用 useMemo 缓存——searchTerm 不变时复用同一份 RegExp，
  // 不再每次渲染重建（makeHighlightRe 内部 new RegExp）。
  const re = useMemo(() => makeHighlightRe(highlight), [highlight]);

  // hl 随 re 变化（即随 searchTerm 变化）；其余渲染期保持稳定引用。
  // 对叶子文本容器的字符串子节点标 <mark>（见 Highlight.tsx）。
  const hl = useCallback((c: React.ReactNode): React.ReactNode => (re ? highlightChildren(c, re) : c), [re]);

  // #16：依赖 hl 的节点（th/td/a/h1-3/p/li）随 hl 一起 memoize，静态节点复用模块级常量。
  // 整个 components 对象引用在 searchTerm 不变时保持稳定，ReactMarkdown 不再重解析。
  const components = useMemo<Components>(() => ({
    ...STATIC_MARKDOWN_COMPONENTS,
    th({ children }) {
      return (
        <th className="px-3 py-2 text-left text-sm font-[510] text-text-primary bg-bg-surface/50 border border-border-subtle">
          {hl(children)}
        </th>
      );
    },
    td({ children }) {
      return <td className="px-3 py-2 text-sm text-text-secondary border border-border-subtle">{hl(children)}</td>;
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
          {hl(children)}
        </a>
      );
    },
    // 标题
    h1({ children }) {
      return <h1 className="text-[20px] font-[510] text-text-primary mb-3 mt-4">{hl(children)}</h1>;
    },
    h2({ children }) {
      return <h2 className="text-[17px] font-[510] text-text-primary mb-2 mt-3">{hl(children)}</h2>;
    },
    h3({ children }) {
      return <h3 className="text-[15px] font-[510] text-text-primary mb-2 mt-2">{hl(children)}</h3>;
    },
    // 段落
    p({ children }) {
      return <p className="text-[15px] leading-relaxed text-text-secondary mb-2">{hl(children)}</p>;
    },
    // 列表项
    li({ children }) {
      return <li className="mb-1">{hl(children)}</li>;
    },
  }), [hl]);

  return (
    <div className="markdown-content">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={components}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
