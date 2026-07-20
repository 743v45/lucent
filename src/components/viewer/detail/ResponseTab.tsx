/**
 * Response Tab：响应 Headers + Body（JSON / SSE 原始 / 结构化）详情。
 * 从原 DetailPanel.tsx 拆出（#19 巨石拆分），行为零变更。
 */
import { useState, useMemo } from 'react';
import type { LogEntry, SSERawBody } from '../../../types';
import { extractFromSSELines, extractedToResponseBody } from '../../../utils/sse-extractor';
import { Highlight } from '../../common/Highlight';
import { CollapsibleSection, HeadersDisplay, JsonBlock, CopyButton, ExpandAllButton, SSEViewToggle, type SSEViewMode } from './shared';
import { sseLinesToRawText } from './utils';

export interface ResponseTabProps {
  log: LogEntry;
  expanded: boolean;
  onToggle: () => void;
  headersExpanded: boolean;
  onToggleHeaders: () => void;
  // low#9：onCopy 返回真实复制结果，供 CopyButton 据实反馈
  onCopy: (data: unknown) => boolean | Promise<boolean>;
  /** 当前搜索词（正文命中高亮用；空则不高亮） */
  searchTerm?: string;
}

export function ResponseTab({ log, expanded, onToggle, headersExpanded, onToggleHeaders, onCopy, searchTerm }: ResponseTabProps): JSX.Element {
  const response = log.response;
  // 默认 raw：原始 SSE 文本完整可见(含 ping/error 等元事件)，结构化视图丢失这些事件
  const [sseViewMode, setSseViewMode] = useState<SSEViewMode>('raw');

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
        <CollapsibleSection title="Headers" expanded={headersExpanded} onToggle={onToggleHeaders} testId="response-headers">
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
            <ExpandAllButton expanded={expanded} onToggle={onToggle} />
            <CopyButton onCopy={() => onCopy(sseViewMode === 'raw' ? rawSSEText : extractedBody)} />
          </div>
        </div>
        <div className="flex-1 min-h-0" data-testid="response-body">
          {sseViewMode === 'raw' && isSSE ? (
            // #18：删除冗余内联 backgroundColor——bg-bg-deep token 即 #08090a，无需 style 叠加
            <pre className="h-full text-lg leading-relaxed bg-bg-deep p-3 rounded-lg font-mono text-text-secondary overflow-auto whitespace-pre-wrap break-words">
              <Highlight text={rawSSEText} term={searchTerm} />
            </pre>
          ) : extractedBody == null ? (
            <div className="flex items-center justify-center h-full">
              <span className="text-text-quaternary text-base">无响应体</span>
            </div>
          ) : (
            <JsonBlock data={extractedBody} expanded={expanded} />
          )}
        </div>
      </div>
    </div>
  );
}
