/**
 * Meta Tab：请求元信息（agent / client / model / provider / 耗时 / TTFT / token 等）。
 * 从原 DetailPanel.tsx 拆出（#19 巨石拆分），行为零变更。
 *
 * 注：tokenUsage 由父级 DetailPanel 用 useMemo 统一解析（SSE 流只 parse 一次）后传入，
 * 与头部 InlineTokenStats 共用，此处不再重复 resolveTokenUsage。
 */
import type { LogEntry } from '../../../types';
import { ProviderIcon } from '../../common/ProviderIcon';
import type { TokenUsage } from './utils';

export interface MetaTabProps {
  log: LogEntry;
  tokenUsage: TokenUsage;
}

export function MetaTab({ log, tokenUsage }: MetaTabProps): JSX.Element {
  return (
    <div className="p-4">
      <div className="bg-bg-surface/50 rounded-lg border border-border-subtle p-3">
        <div className="space-y-3 text-lg">
          <MetaRow
            label="Agent 类型"
            value={log.agentType === 'main' ? 'MainAgent' : 'SubAgent'}
            description="请求的发起方类型。MainAgent 为主代理（用户直接交互），SubAgent 为子代理（由主代理调度）"
          />
          <MetaRow
            label="客户端类型"
            value={log.clientType || 'unknown'}
            description="发起请求的客户端，如 claude-code、codex、opencode 等"
          />
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
            label="首 token 时延"
            value={log.ttftFirstTokenMs != null ? `${log.ttftFirstTokenMs}ms` : 'n/a'}
            testId="ttft-first-token"
            description="TTFT：客户端请求到达代理 → 首个生成 token（思考/回答先到者）的时延。反映 prefill 等待，是 reasoning 模型的大头延迟。流式专属，非流式显示 n/a"
          />
          {log.ttftThinkingMs != null && (
            <MetaRow
              label="思考首 token"
              value={`${log.ttftThinkingMs}ms`}
              testId="ttft-thinking"
              description="首个思考（reasoning）token 的时延；无思考流则不显示"
            />
          )}
          {log.ttftAnswerMs != null && (
            <MetaRow
              label="回答首 token"
              value={`${log.ttftAnswerMs}ms`}
              testId="ttft-answer"
              description="首个回答文本 token 的时延"
            />
          )}
          <MetaRow
            label="生成速度"
            value={log.tokensPerSecond != null ? `${log.tokensPerSecond} tok/s` : 'n/a'}
            testId="tokens-per-second"
            description="decode 阶段吞吐：首 token 之后的 output tokens 生成速度（tokens/秒）。流式专属"
          />
          <MetaRow
            label="流式"
            value={log.metadata.stream ? '是' : '否'}
            description="是否使用 SSE 流式传输。开启后响应会逐步返回，适合长文本生成"
          />
          {tokenUsage && (
            <>
              <MetaRow
                label="Input Tokens"
                value={tokenUsage.input_tokens?.toLocaleString() ?? '0'}
                description="请求中包含的输入 token 数量（含系统提示词和用户消息），与头部统计一致（含 SSE 实时提取）"
              />
              <MetaRow
                label="Output Tokens"
                value={tokenUsage.output_tokens?.toLocaleString() ?? '0'}
                description="模型生成的输出 token 数量"
              />
              {tokenUsage.cache_read_tokens != null && (
                <MetaRow
                  label="Cache Read"
                  value={tokenUsage.cache_read_tokens.toLocaleString()}
                  valueClassName="text-success"
                  description="从缓存读取的 token 数量，命中缓存可降低延迟和费用"
                />
              )}
              {tokenUsage.cache_creation_tokens != null && (
                <MetaRow
                  label="Cache Creation"
                  value={tokenUsage.cache_creation_tokens.toLocaleString()}
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
  testId,
}: {
  label: string;
  value: string;
  mono?: boolean;
  valueClassName?: string;
  valuePrefix?: React.ReactNode;
  description?: string;
  testId?: string;
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
        data-testid={testId}
      >
        {valuePrefix}
        {value}
      </span>
    </div>
  );
}
