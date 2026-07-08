/**
 * 命中高亮工具
 *
 * 搜索打开某条日志后，把详情里命中的词在渲染文本里标黄。
 * - makeHighlightRe：搜索词 → 大小写不敏感、转义元字符的全局正则；空/非法返回 null。
 * - highlightString：单个字符串 → 带 <mark> 的片段数组。
 * - highlightChildren：递归走 React 子节点，对字符串子节点高亮（用于 markdown 渲染）。
 *
 * 刻意只在「文本字符串」上切，不碰代码块 / JSON 视图，避免破坏语法高亮与结构。
 */
import React from 'react';

/** 搜索词 → 高亮正则（global + 大小写不敏感 + 元字符转义）；空或非法返回 null */
export function makeHighlightRe(term: string | undefined): RegExp | null {
  const t = (term ?? '').trim();
  if (!t) return null;
  try {
    return new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  } catch {
    return null;
  }
}

/** 把单个字符串按命中切成 [文本, <mark>, 文本, …]；re 为 null 时原样返回 */
function highlightString(text: string, re: RegExp | null): React.ReactNode[] {
  if (!re || !text) return [text];
  const out: React.ReactNode[] = [];
  let last = 0;
  let key = 0;
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(
      <mark key={`hl-${key++}`} className="search-hit">
        {m[0]}
      </mark>,
    );
    last = m.index + m[0].length;
    if (m[0].length === 0) re.lastIndex++; // 防零宽匹配死循环
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** 递归高亮 React 子节点里的字符串（元素节点 clone 后递归处理其 children） */
export function highlightChildren(children: React.ReactNode, re: RegExp | null): React.ReactNode {
  if (!re) return children;
  return React.Children.map(children, (child) => {
    if (typeof child === 'string') return highlightString(child, re);
    if (typeof child === 'number') return highlightString(String(child), re);
    if (React.isValidElement(child)) {
      return React.cloneElement(child, {} as Record<string, never>, highlightChildren((child.props as { children?: React.ReactNode }).children, re));
    }
    return child;
  });
}

/** 纯文本高亮组件：用于 <pre> 等整块字符串渲染面 */
export function Highlight({ text, term }: { text: string; term: string | undefined }): JSX.Element {
  const re = makeHighlightRe(term);
  return <>{highlightString(text, re)}</>;
}
