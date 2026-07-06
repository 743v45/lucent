import { useState, useEffect, type ReactNode } from 'react';
import { Modal, Input, Button, Switch, message, Spin, Empty } from 'antd';
import { PlusOutlined, DeleteOutlined } from '@ant-design/icons';
import {
  listBodyRewrites,
  createBodyRewrite,
  updateBodyRewrite,
  deleteBodyRewrite,
} from '../../utils/api';
import type { BodyRewriteRule } from '../../types';

const { TextArea } = Input;

interface BodyRewriteModalProps {
  open: boolean;
  onClose: () => void;
}

/** 试跑计算结果 */
type TryRunResult =
  | { kind: 'empty' }
  | { kind: 'error'; message: string }
  | { kind: 'ok'; result: string };

/**
 * 纯前端试跑：复刻后端语义 value.replace(new RegExp(pattern, flags ?? 'g'), replacement)。
 * 返回 {kind} 联合，便于渲染层分流处理。
 */
function computeTryRun(
  pattern: string,
  flags: string | undefined,
  replacement: string,
  sample: string,
): TryRunResult {
  if (!pattern || !sample) return { kind: 'empty' };
  try {
    const regex = new RegExp(pattern, flags || 'g');
    return { kind: 'ok', result: sample.replace(regex, replacement) };
  } catch (e) {
    return { kind: 'error', message: (e as Error).message };
  }
}

/** 小型带 label 字段容器，复用于规则卡片的四个输入框 */
function LabeledField({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={className}>
      <div className="text-[11px] text-text-tertiary mb-0.5">{label}</div>
      {children}
    </div>
  );
}

export function BodyRewriteModal({ open, onClose }: BodyRewriteModalProps) {
  const [rules, setRules] = useState<BodyRewriteRule[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  // 每条规则的试跑样例文本，相互独立
  const [tryRunText, setTryRunText] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const loadRules = async () => {
      setLoading(true);
      try {
        const list = await listBodyRewrites();
        if (cancelled) return;
        setRules(list);
      } catch {
        if (!cancelled) message.error('加载规则列表失败');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    loadRules();
    return () => {
      cancelled = true;
    };
  }, [open]);

  /** 本地受控更新（输入即响应），不落库 */
  const updateRuleLocal = (id: string, patch: Partial<BodyRewriteRule>) => {
    setRules(prev => prev.map(r => (r.id === id ? { ...r, ...patch } : r)));
  };

  /** 失焦落库某字段，成功用后端返回值回填以保持一致 */
  const saveField = async (id: string, patch: Partial<BodyRewriteRule>) => {
    try {
      const updated = await updateBodyRewrite(id, patch);
      setRules(prev => prev.map(r => (r.id === id ? updated : r)));
    } catch (e) {
      message.error((e as Error).message || '保存失败');
    }
  };

  const handleToggleEnabled = async (id: string, enabled: boolean) => {
    updateRuleLocal(id, { enabled }); // 乐观更新
    try {
      const updated = await updateBodyRewrite(id, { enabled });
      setRules(prev => prev.map(r => (r.id === id ? updated : r)));
    } catch (e) {
      updateRuleLocal(id, { enabled: !enabled }); // 回滚
      message.error((e as Error).message || '切换失败');
    }
  };

  const handleCreate = async () => {
    setCreating(true);
    try {
      const created = await createBodyRewrite({
        fieldPath: 'system[0].text',
        pattern: 'pattern',
        replacement: '',
        enabled: true,
      });
      setRules(prev => [...prev, created]);
      message.success('已新增规则');
    } catch (e) {
      message.error((e as Error).message || '新增失败');
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm('确定要删除该规则吗？此操作不可恢复。')) return;
    try {
      await deleteBodyRewrite(id);
      setRules(prev => prev.filter(r => r.id !== id));
      setTryRunText(prev => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      message.success('已删除');
    } catch (e) {
      message.error((e as Error).message || '删除失败');
    }
  };

  const renderRuleCard = (rule: BodyRewriteRule) => {
    const sample = tryRunText[rule.id] ?? '';
    const tryResult = computeTryRun(rule.pattern, rule.flags, rule.replacement, sample);

    return (
      <div
        key={rule.id}
        className="bg-bg-surface/50 border border-border-subtle rounded-md p-3"
      >
        {/* 头部：开关 + 名称（inline 可编辑） + 删除 */}
        <div className="flex items-center gap-2 mb-2">
          <Switch
            size="small"
            checked={rule.enabled !== false}
            onChange={checked => handleToggleEnabled(rule.id, checked)}
          />
          <Input
            size="small"
            value={rule.name ?? ''}
            placeholder="规则名称（可选）"
            onChange={e => updateRuleLocal(rule.id, { name: e.target.value })}
            onBlur={e => saveField(rule.id, { name: e.target.value })}
            className="flex-1"
          />
          <Button
            type="text"
            size="small"
            icon={<DeleteOutlined />}
            danger
            onClick={() => handleDelete(rule.id)}
            className="!text-error/60 hover:!text-error shrink-0"
          />
        </div>

        {/* 字段网格 */}
        <div className="flex flex-col gap-1.5">
          <LabeledField label="字段路径">
            <Input
              size="small"
              value={rule.fieldPath}
              placeholder="system[0].text"
              onChange={e => updateRuleLocal(rule.id, { fieldPath: e.target.value })}
              onBlur={e => saveField(rule.id, { fieldPath: e.target.value })}
            />
          </LabeledField>
          <div className="flex gap-2">
            <LabeledField label="正则" className="flex-1 min-w-0">
              <Input
                size="small"
                value={rule.pattern}
                placeholder="x-anthropic-billing-header:[^;]*;"
                onChange={e => updateRuleLocal(rule.id, { pattern: e.target.value })}
                onBlur={e => saveField(rule.id, { pattern: e.target.value })}
              />
            </LabeledField>
            <LabeledField label="flags" className="w-[80px] shrink-0">
              <Input
                size="small"
                value={rule.flags ?? ''}
                placeholder="g"
                onChange={e => updateRuleLocal(rule.id, { flags: e.target.value })}
                onBlur={e => saveField(rule.id, { flags: e.target.value })}
              />
            </LabeledField>
          </div>
          <LabeledField label="替换值">
            <Input
              size="small"
              value={rule.replacement}
              placeholder="空=删除匹配子串"
              onChange={e => updateRuleLocal(rule.id, { replacement: e.target.value })}
              onBlur={e => saveField(rule.id, { replacement: e.target.value })}
            />
          </LabeledField>
        </div>

        {/* 试跑预览（纯前端） */}
        <div className="mt-2 pt-2 border-t border-border-subtle">
          <div className="text-[11px] text-text-tertiary mb-1">试跑预览</div>
          <TextArea
            rows={2}
            value={sample}
            onChange={e => setTryRunText(prev => ({ ...prev, [rule.id]: e.target.value }))}
            placeholder="粘贴样例文本试跑（如 billing header 原文）"
          />
          <div className="mt-1.5">
            {tryResult.kind === 'empty' && (
              <div className="text-[12px] text-text-quaternary">
                输入正则与样例后显示替换结果
              </div>
            )}
            {tryResult.kind === 'error' && (
              <div className="text-[12px] text-error break-all">
                正则非法: {tryResult.message}
              </div>
            )}
            {tryResult.kind === 'ok' && (
              <pre className="bg-bg-deep rounded p-2 text-[12px] font-mono text-text-secondary break-all whitespace-pre-wrap overflow-auto max-h-[140px]">
                {tryResult.result}
              </pre>
            )}
          </div>
        </div>
      </div>
    );
  };

  return (
    <Modal
      title={<span className="text-text-primary text-[17px] font-[510]">Body 重写规则</span>}
      open={open}
      onCancel={onClose}
      width={780}
      footer={null}
      destroyOnHidden
    >
      <div className="h-[520px] flex flex-col">
        {/* 说明文案 */}
        <div className="text-[12px] text-text-quaternary">
          对请求 body 指定字段的字符串值做正则子串替换；规则按顺序应用，仅启用规则生效
        </div>

        {/* 规则列表 */}
        <div className="flex-1 overflow-y-auto mt-2 flex flex-col gap-2">
          {loading ? (
            <div className="flex items-center justify-center h-full">
              <Spin size="small" />
            </div>
          ) : rules.length === 0 ? (
            <Empty description="暂无规则" className="my-10" />
          ) : (
            rules.map(renderRuleCard)
          )}
        </div>

        {/* 底部新增按钮 */}
        <div className="pt-2 border-t border-border-subtle">
          <Button
            type="dashed"
            icon={<PlusOutlined />}
            block
            onClick={handleCreate}
            loading={creating}
          >
            新增规则
          </Button>
        </div>
      </div>
    </Modal>
  );
}
