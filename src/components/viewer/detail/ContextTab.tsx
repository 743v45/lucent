/**
 * Context Tab：上下文左侧列表（对话历史 / 系统提示词 / 工具）+ 右侧卡片详情。
 * 从原 DetailPanel.tsx 拆出（#19 巨石拆分），行为零变更。
 *
 * 关键修复：
 * - #16：ContextDetailCard 包 React.memo；右侧卡片集合 detail 上 useMemo（依赖 selected/data），
 *   card 引用稳定 → 折叠分组等无关重渲染不再触发整片 markdown 重解析。
 *   （MarkdownContent 内部的 components 对象稳定见 shared.tsx。）
 * - #17：ContextListItem 包 React.memo；onClick 改稳定回调 onSelect(kind, index)，
 *   选中项由 selected 派生 → 点选一条不再重渲染整列。
 *
 * 注：原组件在 `if (!data) return` 之后才调 useState（条件 hook）。这里保持原结构——
 * DetailPanel 外壳对 tab 内容子树用 key={log.id}，切日志整体 remount，不会出现 hook 顺序翻转。
 */
import { useState, useMemo, useCallback, memo } from 'react';
import type { LogEntry, ContextMessage, ContentBlock } from '../../../types';
import { ChevronIcon } from '../../common/ChevronIcon';
import { MarkdownContent } from './shared';

export interface ContextTabProps {
  log: LogEntry;
  /** 当前搜索词（正文命中高亮用；空则不高亮） */
  searchTerm?: string;
}

// 选中项类型：左侧每个「逻辑块」一项。system 是一整块（不再按段拆成多项），
// 多段在右侧以多张卡片呈现；message / tool 仍各自一项。
type SelectedItem =
  | { type: 'systemPrompt' }
  | { type: 'tool'; index: number }
  | { type: 'message'; index: number }
  | null;

// 右侧详情卡片：系统提示词的一段、消息的一个 content block、工具描述，都映射成一张卡片。
// 之所以拆成卡片，是因为一段 system / 一个 content block 本就是独立的语义单元——
// 用户要的是「一整块在左、多张卡在右」，而不是把多段 join 成一坨文本。
interface DetailCard {
  /** 卡片头左侧标签：段号 / 类型名（如 段 1、工具调用: Bash） */
  label?: string;
  /** 卡片头右侧小标签（如 工具调用、工具结果） */
  tag?: { text: string; className: string };
  /** 卡片正文（markdown） */
  content: string;
  /** 卡片语义类型，供 e2e 与样式区分（segment / text / tool_use / tool_result / plain） */
  kind: 'segment' | 'text' | 'tool_use' | 'tool_result' | 'plain';
}

// 折叠分组状态
interface CollapsedGroups {
  systemPrompt: boolean;
  tools: boolean;
  messages: boolean;
}

// 左侧列表项的选中类别（#17 稳定回调用：onSelect(kind, index)，避免每项重建箭头）
type SelectKind = 'message' | 'tool' | 'system';

// ==================== 纯函数（模块级，便于 detail useMemo 引用稳定） ====================

// 提取 tool_result.content：可能是 string、ContentBlock[] 或其他
function extractToolResultContent(content: unknown): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (block && typeof block === 'object' && 'type' in block) {
          const b = block as { type: string; text?: string };
          if (b.type === 'text') return b.text ?? '';
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return String(content);
}

// 角色中文标签
function roleLabelOf(msg: ContextMessage): string {
  return msg.role === 'user' ? '用户' : msg.role === 'assistant' ? '助手' : msg.tool_use_id ? '工具' : msg.role;
}

// 一条消息 → 多张卡片：content 是字符串就一张文本卡；是 ContentBlock[] 就逐块一张卡
// （text / tool_use / tool_result 各自成卡）。content 归一化为空数组时返回空数组，
// 标题仍展示，正文区给「无内容」提示，与历史行为对齐。
function messageToCards(msg: ContextMessage): DetailCard[] {
  if (typeof msg.content === 'string') {
    return [{ content: msg.content, kind: 'text' }];
  }
  const blocks: ContentBlock[] = Array.isArray(msg.content) ? msg.content : [];
  return blocks.map((block) => {
    if (block.type === 'text') {
      return { content: block.text ?? '', kind: 'text' as const };
    }
    if (block.type === 'tool_use') {
      const tb = block as { name?: string; input?: unknown };
      return {
        label: `工具调用: ${tb.name ?? 'unknown'}`,
        tag: { text: '工具调用', className: 'text-brand-accent' },
        content: JSON.stringify(tb.input ?? null, null, 2),
        kind: 'tool_use' as const,
      };
    }
    if (block.type === 'tool_result') {
      const rb = block as { content?: unknown };
      return {
        label: '工具结果',
        tag: { text: '工具结果', className: 'text-tool' },
        content: extractToolResultContent(rb.content),
        kind: 'tool_result' as const,
      };
    }
    // 未知 block 类型：原样 JSON 兜底，不丢内容。
    return { content: JSON.stringify(block, null, 2), kind: 'plain' as const };
  });
}

// ==================== Context Tab ====================

export function ContextTab({ log, searchTerm }: ContextTabProps): JSX.Element {
  const data = log.context;
  if (!data || (!data.messages?.length && !data.summary && data.systemPrompt === undefined && data.tools === undefined)) {
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

  // 选中项（默认选系统提示词整块；无则留空，提示用户点左侧）
  const [selected, setSelected] = useState<SelectedItem>(
    data.systemPrompt?.length ? { type: 'systemPrompt' } : null
  );

  // #17：稳定选中回调——setSelected 来自 useState 永不变化，整个组件生命周期同一引用。
  // 左侧列表项传 (kind, index) 而非每项自己的箭头，配合 memo 跳过未变项的重渲染。
  const handleSelect = useCallback((kind: SelectKind, index: number) => {
    if (kind === 'system') setSelected({ type: 'systemPrompt' });
    else if (kind === 'message') setSelected({ type: 'message', index });
    else setSelected({ type: 'tool', index });
  }, []);

  const toggleGroup = (group: keyof CollapsedGroups) => {
    setCollapsed(prev => ({ ...prev, [group]: !prev[group] }));
  };

  const summary = data.summary;

  // #16：选中项 → 标题 + 卡片集合上 useMemo（依赖 selected/data）。
  // card 引用稳定 → 折叠分组等无关重渲染不再重建卡片、不再触发 markdown 重解析。
  const detail = useMemo<{ title: string; cards: DetailCard[] } | null>(() => {
    if (!selected) return null;
    switch (selected.type) {
      case 'systemPrompt': {
        const segments = data.systemPrompt ?? [];
        if (!segments.length) return null;
        const multi = segments.length > 1;
        return {
          title: '系统提示词',
          cards: segments.map((seg, i) => ({
            label: multi ? `#${i + 1}` : undefined,
            content: seg,
            kind: 'segment' as const,
          })),
        };
      }
      case 'tool': {
        const tool = data.tools?.[selected.index];
        if (!tool) return null;
        return {
          title: `工具: ${tool.name}`,
          cards: [{ content: tool.description || '无描述', kind: 'plain' as const }],
        };
      }
      case 'message': {
        const msg = data.messages?.[selected.index];
        if (!msg) return null;
        return {
          // 标题只留角色：timestamp 是整个请求的统一时间（见 log-reader ctxMsgs），
          // 逐条展示会误导成「每条消息各自的时间」，去掉。
          title: roleLabelOf(msg),
          cards: messageToCards(msg),
        };
      }
    }
  }, [selected, data]);

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
                  role={roleLabel}
                  // 只显角色：每条消息的 timestamp 都是同一个请求时间（无分化），展示会误导。
                  label={roleLabel}
                  // #17：isSelected 由 selected 派生；onSelect 稳定回调
                  isSelected={selected?.type === 'message' && selected?.index === i}
                  onSelect={handleSelect}
                  selectKind="message"
                  selectIndex={i}
                  color={roleColor}
                />
              );
            })}
          </ContextCollapsibleGroup>
        )}

        {/* 系统提示词分组：左侧一整块（一 system 一项），多段在右侧以多卡片呈现。
            count 标段数，回应原始 bug「只显示 1、应显示 N」。 */}
        {data.systemPrompt !== undefined && data.systemPrompt.length > 0 && (
          <ContextCollapsibleGroup
            title="系统提示词"
            count={data.systemPrompt.length}
            collapsed={collapsed.systemPrompt}
            onToggle={() => toggleGroup('systemPrompt')}
          >
            <ContextListItem
              role="system"
              label="System"
              isSelected={selected?.type === 'systemPrompt'}
              onSelect={handleSelect}
              selectKind="system"
              selectIndex={0}
              color="text-warning"
            />
          </ContextCollapsibleGroup>
        )}

        {/* 工具分组 */}
        {data.tools !== undefined && (
          <ContextCollapsibleGroup
            title="可用工具"
            count={data.tools.length}
            collapsed={collapsed.tools}
            onToggle={() => toggleGroup('tools')}
          >
            {data.tools.map((tool, i) => (
              <ContextListItem
                key={i}
                role="tool"
                label={tool.name}
                isSelected={selected?.type === 'tool' && selected?.index === i}
                onSelect={handleSelect}
                selectKind="tool"
                selectIndex={i}
                color="text-brand-accent"
              />
            ))}
          </ContextCollapsibleGroup>
        )}
      </div>

      {/* 右侧详情：选中项拆成多张卡片（system 每段一张、message 每个 content block 一张） */}
      <div className="flex-1 min-w-0 overflow-auto bg-bg-deep">
        {detail ? (
          <div className="p-4">
            {/* 标题 */}
            <div className="mb-3 pb-3 border-b border-border-subtle">
              <h3 className="text-[17px] font-[510] text-text-primary" data-testid="detail-title">{detail.title}</h3>
            </div>
            {/* 卡片堆 */}
            {detail.cards.length > 0 ? (
              <div className="space-y-3">
                {detail.cards.map((card, i) => (
                  <ContextDetailCard key={i} card={card} highlight={searchTerm} />
                ))}
              </div>
            ) : (
              <span className="text-text-quaternary text-sm">（无内容）</span>
            )}
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

// ==================== Context List Item（#17 memo + 稳定回调） ====================

// #17：包 memo。props 全部稳定——onSelect 来自父级 useCallback、selectKind/selectIndex 是
// 基本类型字面量、isSelected/color/label/role 是值相等的基本类型 → 点选一条时只有新旧两个
// 选中项的 isSelected 翻转触发重渲染，其余项跳过。
const ContextListItem = memo(function ContextListItem({
  label,
  role,
  isSelected,
  color,
  selectKind,
  selectIndex,
  onSelect,
}: {
  label: string;
  role?: string;
  isSelected: boolean;
  color: string;
  selectKind: SelectKind;
  selectIndex: number;
  onSelect: (kind: SelectKind, index: number) => void;
}) {
  return (
    <button
      data-testid="context-item"
      data-role={role}
      onClick={() => onSelect(selectKind, selectIndex)}
      className={`w-full px-3 py-1.5 pl-6 text-left text-sm transition-colors ${
        isSelected
          ? 'bg-bg-active text-text-primary'
          : 'text-text-tertiary hover:bg-bg-hover hover:text-text-secondary'
      }`}
    >
      <span className={`${isSelected ? '' : color} font-[510]`}>{label}</span>
    </button>
  );
});

// ==================== Context Detail Card（#16 memo + 卡片引用稳定） ====================

// 右侧详情的一张卡片：可选头部（标签 + 角标）+ markdown 正文。
// system 的每一段、message 的每个 content block 都是独立卡片，不再合并成一坨文本。
// #16：包 memo——配合父级 detail 的 useMemo，card 引用稳定时跳过重渲染（不重解析 markdown）。
const ContextDetailCard = memo(function ContextDetailCard({ card, highlight }: { card: DetailCard; highlight?: string }): JSX.Element {
  return (
    <div
      data-testid="context-card"
      data-kind={card.kind}
      className="rounded-lg border border-border-subtle bg-bg-surface/50 overflow-hidden"
    >
      {(card.label || card.tag) && (
        <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-border-subtle bg-bg-surface/30">
          {card.label && <span className="text-sm font-[510] text-text-secondary">{card.label}</span>}
          {card.tag && (
            <span className={`text-xs px-1.5 py-0.5 rounded ${card.tag.className}`}>{card.tag.text}</span>
          )}
        </div>
      )}
      <div className="p-3">
        {card.content
          ? <MarkdownContent content={card.content} highlight={highlight} />
          : <span className="text-text-quaternary text-sm">（空）</span>}
      </div>
    </div>
  );
});
