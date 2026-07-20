/**
 * Request Tab：请求 Headers + Body 详情。
 * 从原 DetailPanel.tsx 拆出（#19 巨石拆分），行为零变更。
 */
import type { LogEntry } from '../../../types';
import { CollapsibleSection, HeadersDisplay, JsonBlock, CopyButton, ExpandAllButton } from './shared';

export interface RequestTabProps {
  log: LogEntry;
  expanded: boolean;
  onToggle: () => void;
  headersExpanded: boolean;
  onToggleHeaders: () => void;
  // low#9：onCopy 返回真实复制结果，供 CopyButton 据实反馈
  onCopy: (data: unknown) => boolean | Promise<boolean>;
}

export function RequestTab({ log, expanded, onToggle, headersExpanded, onToggleHeaders, onCopy }: RequestTabProps): JSX.Element {
  return (
    <div className="flex flex-col h-full bg-bg-deep">
      <div className="p-4">
        <CollapsibleSection title="Headers" expanded={headersExpanded} onToggle={onToggleHeaders} testId="request-headers">
          <HeadersDisplay headers={log.request.headers} />
        </CollapsibleSection>
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 flex flex-col bg-bg-deep px-4 pb-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[17px] font-[510] text-text-secondary">Body</span>
          <div className="flex items-center gap-2">
            <ExpandAllButton expanded={expanded} onToggle={onToggle} />
            <CopyButton onCopy={() => onCopy(log.request.body)} />
          </div>
        </div>
        <div className="flex-1 min-h-0" data-testid="request-body">
          <JsonBlock data={log.request.body} expanded={expanded} />
        </div>
      </div>
    </div>
  );
}
