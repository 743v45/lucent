import { useState, useEffect, useRef } from 'react';
import { Modal, Input, Button, message, Empty, Tooltip } from 'antd';
import {
  PlusOutlined,
  CheckCircleOutlined,
  CheckOutlined,
  CopyOutlined,
  EditOutlined,
  DeleteOutlined,
  ExclamationCircleOutlined,
  CloseOutlined,
  ArrowLeftOutlined,
} from '@ant-design/icons';
import {
  listProviders,
  getProviderFull,
  createProvider,
  updateProvider,
  deleteProvider,
  renameProvider,
  testProviderEndpoint,
} from '../../utils/api';
import type { Provider, EndpointType, ProviderPreset } from '../../types';
import { ENDPOINT_TYPES, isValidProviderName } from '../../types';
import { SETTINGS_MODAL_WIDTH, DEFAULT_PROXY_PORT } from '../../constants';
import { PROVIDER_PRESETS, PRESET_NAMES, getPresetByName } from '../../constants/presets';
import { getProtocolColor } from '../../constants/protocol-colors';
import { ProviderIcon } from '../common/ProviderIcon';
import { ProtocolIcon } from '../common/ProtocolIcon';

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
}

const ENDPOINT_LABELS: Record<EndpointType, string> = {
  'openai-chat': 'OpenAI Chat',
  'openai-responses': 'OpenAI Responses',
  'anthropic-messages': 'Anthropic Messages',
};

/** 校验是否为合法 URL（空值也合法，表示未配置） */
function isValidUrl(v: string | null): boolean {
  if (!v) return true;
  try { const u = new URL(v); return u.protocol === 'http:' || u.protocol === 'https:'; }
  catch { return false; }
}

export function SettingsModal({ open, onClose }: SettingsModalProps) {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [testingMap, setTestingMap] = useState<Record<EndpointType, boolean>>({} as Record<EndpointType, boolean>);
  const [testResults, setTestResults] = useState<Record<string, Record<EndpointType, { ok: boolean; duration: number; message: string } | null>>>({});

  // 编辑状态
  const [editingName, setEditingName] = useState<string | null>(null);
  const [nameInput, setNameInput] = useState('');
  const [formData, setFormData] = useState<Record<string, { endpoints: Record<EndpointType, string | null> }>>({});
  // 已失焦的字段集合，用于失焦后才显示校验红框
  const [blurredFields, setBlurredFields] = useState<Set<string>>(new Set());
  // 预设面板状态
  const [showPresetPanel, setShowPresetPanel] = useState(false);
  const [customNameInput, setCustomNameInput] = useState('');
  const [showCustomInput, setShowCustomInput] = useState(false);

  // ref 始终指向最新 formData，避免 handleAutoSave 闭包读取旧值
  const formDataRef = useRef(formData);
  formDataRef.current = formData;

  const proxyPort = DEFAULT_PROXY_PORT; // TODO: 从 status API 获取动态值

  useEffect(() => {
    if (open) loadProviders();
  }, [open]);

  const loadProviders = async () => {
    setLoading(true);
    try {
      const list = await listProviders();
      setProviders(list);
      // 初始化 formData
      const data: Record<string, { endpoints: Record<EndpointType, string | null> }> = {};
      for (const p of list) {
        const full = await getProviderFull(p.name);
        data[p.name] = { endpoints: full.endpoints };
      }
      setFormData(data);
      setTestResults({});
    } catch {
      message.error('加载供应商列表失败');
    } finally {
      setLoading(false);
    }
  };

  const handleExpand = (name: string) => {
    setExpanded(expanded === name ? null : name);
  };

  const handleClose = () => {
    setExpanded(null);
    onClose();
  };

  const handleCreate = () => {
    setShowPresetPanel(true);
  };

  const handleCreateFromPreset = async (preset: ProviderPreset) => {
    try {
      setLoading(true);
      const created = await createProvider({
        name: preset.name,
        presetName: preset.name,
        endpoints: { ...preset.endpoints },
      });
      setProviders(prev => [...prev, created]);
      setFormData(prev => ({
        ...prev,
        [created.name]: { endpoints: created.endpoints },
      }));
      setExpanded(created.name);
      setShowPresetPanel(false);
      message.success(`已添加 ${preset.label}`);
    } catch (e) {
      message.error((e as Error).message || '创建失败');
    } finally {
      setLoading(false);
    }
  };

  const handleCreateCustom = async () => {
    const name = customNameInput.trim();
    if (!name || !isValidProviderName(name)) {
      message.error('名称格式错误：只允许 [a-zA-Z0-9_-]{1,32}');
      return;
    }
    if (PRESET_NAMES.has(name)) {
      message.error(`"${name}" 是系统保留名，请选择预设或使用其他名称`);
      return;
    }
    if (providers.some(p => p.name === name)) {
      message.error(`名称 "${name}" 已被占用`);
      return;
    }
    try {
      setLoading(true);
      const created = await createProvider({
        name,
        endpoints: {
          'openai-chat': null,
          'openai-responses': null,
          'anthropic-messages': null,
        },
      });
      setProviders(prev => [...prev, created]);
      setFormData(prev => ({
        ...prev,
        [created.name]: { endpoints: created.endpoints },
      }));
      setExpanded(created.name);
      setShowPresetPanel(false);
      setCustomNameInput('');
      message.success(`已创建 ${name}`);
    } catch (e) {
      message.error((e as Error).message || '创建失败');
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (name: string) => {
    if (!window.confirm(`确定要删除供应商「${name}」吗？此操作不可恢复。`)) return;
    try {
      await deleteProvider(name);
      setProviders(providers.filter(p => p.name !== name));
      setFormData(prev => {
        const next = { ...prev };
        delete next[name];
        return next;
      });
      if (expanded === name) setExpanded(null);
      message.success('已删除');
    } catch (e) {
      message.error((e as Error).message || '删除失败');
    }
  };

  const handleRenameStart = (name: string) => {
    setEditingName(name);
    setNameInput(name);
  };

  const handleRenameCommit = async (oldName: string) => {
    const newName = nameInput.trim();
    if (!newName || newName === oldName) {
      setEditingName(null);
      return;
    }
    if (!isValidProviderName(newName)) {
      message.error('名称格式错误：只允许 [a-zA-Z0-9_-]{1,32}');
      return;
    }
    if (PRESET_NAMES.has(newName)) {
      message.error(`"${newName}" 是系统保留名，不可使用`);
      return;
    }
    if (providers.some(p => p.name === newName)) {
      message.error(`名称 "${newName}" 已被占用`);
      return;
    }
    try {
      const renamed = await renameProvider(oldName, newName);
      setProviders(providers.map(p => (p.name === oldName ? renamed : p)));
      setFormData(prev => {
        const data = prev[oldName];
        const next = { ...prev };
        delete next[oldName];
        next[newName] = data;
        return next;
      });
      setTestResults(prev => {
        const results = prev[oldName];
        const next = { ...prev };
        delete next[oldName];
        if (results) next[newName] = results;
        return next;
      });
      if (expanded === oldName) setExpanded(newName);
      setEditingName(null);
      message.success('已重命名');
    } catch (e) {
      message.error((e as Error).message || '重命名失败');
    }
  };

  /** 自动保存（失焦时触发，静默） */
  const handleAutoSave = async (name: string) => {
    const data = formDataRef.current[name];
    if (!data) return;
    // URL 有无效值时不保存，给用户提示
    const invalidEt = ENDPOINT_TYPES.find(et => !isValidUrl(data.endpoints[et]));
    if (invalidEt) {
      message.warning(`${ENDPOINT_LABELS[invalidEt]} URL 格式无效，未保存`);
      return;
    }
    try {
      const updated = await updateProvider(name, { endpoints: data.endpoints });
      setProviders(prev => prev.map(p => (p.name === name ? updated : p)));
    } catch (e) {
      message.error((e as Error).message || '保存失败');
    }
  };

  const handleTest = async (name: string, endpointType: EndpointType) => {
    setTestingMap(prev => ({ ...prev, [endpointType]: true }));
    try {
      const result = await testProviderEndpoint(name, endpointType);
      setTestResults(prev => ({
        ...prev,
        [name]: { ...prev[name], [endpointType]: result },
      }));
      if (result.ok) {
        message.success(`${ENDPOINT_LABELS[endpointType]} 连接正常 (${result.duration}ms)`);
      } else {
        message.warning(result.message);
      }
    } catch (e) {
      setTestResults(prev => ({
        ...prev,
        [name]: { ...prev[name], [endpointType]: { ok: false, duration: 0, message: (e as Error).message } },
      }));
      message.error('测试失败');
    } finally {
      setTestingMap(prev => ({ ...prev, [endpointType]: false }));
    }
  };

  const getAccessUrl = (p: Provider) => {
    const prefix = p.presetName ? '' : 'custom/';
    return `http://127.0.0.1:${proxyPort}/${prefix}${p.name}`;
  };

  const handleCopyAccessUrl = (p: Provider) => {
    navigator.clipboard.writeText(getAccessUrl(p)).then(() => {
      message.success('已复制接入地址');
    }).catch(() => {
      message.error('复制失败');
    });
  };

  const updateFormData = (name: string, field: EndpointType, value: string | null) => {
    setFormData(prev => {
      const current = prev[name] || { endpoints: {} as Record<EndpointType, string | null> };
      return { ...prev, [name]: { ...current, endpoints: { ...current.endpoints, [field]: value } } };
    });
  };

  const providerNames = new Set(providers.map(p => p.name));

  const renderPresetPanel = () => (
    <div className="h-full flex flex-col">
      {/* 标题栏 */}
      <div className="flex items-center gap-2 pb-3">
        <Button
          type="text"
          size="small"
          icon={<ArrowLeftOutlined />}
          onClick={() => { setShowPresetPanel(false); setShowCustomInput(false); setCustomNameInput(''); }}
        />
        <span className="text-[15px] font-[510] text-text-primary">选择供应商</span>
      </div>

      {/* 预设网格 */}
      <div className="flex-1 overflow-y-auto">
        {(['official', 'community'] as const).map(category => {
          const items = PROVIDER_PRESETS.filter(p => p.category === category);
          if (items.length === 0) return null;
          return (
            <div key={category} className="mb-4">
              <div className="text-[11px] font-[510] uppercase tracking-wide text-text-quaternary px-1 mb-2">
                {category === 'official' ? '官方' : '社区'}
              </div>
              <div className="grid grid-cols-3 gap-2">
                {items.map(preset => {
                  const alreadyAdded = providerNames.has(preset.name);
                  return (
                    <div
                      key={preset.name}
                      className={`flex items-center gap-2 px-3 py-2 rounded-md border border-border-subtle transition-colors ${
                        alreadyAdded
                          ? 'opacity-50 cursor-default bg-bg-surface/30'
                          : 'cursor-pointer bg-bg-surface/50 hover:bg-bg-elevated hover:border-brand-accent/40'
                      }`}
                      onClick={alreadyAdded ? undefined : () => handleCreateFromPreset(preset)}
                    >
                      <ProviderIcon providerName={preset.name} size={20} avatar />
                      <span className="text-[13px] text-text-primary truncate">{preset.label}</span>
                      {alreadyAdded && (
                        <CheckOutlined className="text-xs text-success ml-auto" />
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}

        {/* 底部：自定义供应商 */}
        <div className="mt-4 pt-3 border-t border-border-subtle">
          {!showCustomInput ? (
            <Button
              type="dashed"
              block
              onClick={() => setShowCustomInput(true)}
            >
              自定义供应商
            </Button>
          ) : (
            <div className="flex items-center gap-2">
              <Input
                size="small"
                value={customNameInput}
                onChange={e => setCustomNameInput(e.target.value)}
                onPressEnter={handleCreateCustom}
                placeholder="输入自定义名称"
                className="flex-1"
                autoFocus
              />
              <Button
                size="small"
                type="primary"
                onClick={handleCreateCustom}
                loading={loading}
              >
                确认
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );

  const renderProviderCard = (p: Provider) => {
    const isExpanded = expanded === p.name;
    const isEditing = editingName === p.name;
    const data = formData[p.name] || { endpoints: {} as Record<EndpointType, string | null> };
    const preset = getPresetByName(p.name);
    // 已配置的 endpoint 列表（按 ENDPOINT_TYPES 顺序）
    const configuredEndpoints = ENDPOINT_TYPES.filter(et => data.endpoints[et]);

    return (
      <div
        key={p.name}
        className={`relative flex flex-col items-center gap-1.5 p-3 rounded-md border transition-colors cursor-pointer ${
          isExpanded
            ? 'bg-bg-elevated border-brand-accent/50'
            : 'bg-bg-surface/50 border-border-subtle hover:bg-bg-elevated hover:border-brand-accent/40'
        }`}
        onClick={() => handleExpand(p.name)}
      >
        {/* 删除按钮 */}
        <Button
          type="text"
          size="small"
          icon={<DeleteOutlined />}
          danger
          onClick={e => { e.stopPropagation(); handleDelete(p.name); }}
          className="!absolute !top-1 !right-1 !text-error/60 hover:!text-error !p-0 !w-5 !h-5"
        />

        <ProviderIcon providerName={p.name} size={24} avatar />
        {isEditing ? (
          <Input
            size="small"
            value={nameInput}
            onChange={e => setNameInput(e.target.value)}
            onPressEnter={() => handleRenameCommit(p.name)}
            onBlur={() => handleRenameCommit(p.name)}
            className="!w-[100px]"
            autoFocus
            onClick={e => e.stopPropagation()}
          />
        ) : preset ? (
          <span className="text-[12px] font-[510] text-text-primary truncate max-w-full">{preset.label}</span>
        ) : (
          <span
            className="text-[12px] font-[510] text-text-primary truncate max-w-full flex items-center gap-1"
            onClick={e => { e.stopPropagation(); handleRenameStart(p.name); }}
            title="点击重命名"
          >
            {p.name}
            <EditOutlined className="text-[10px] text-text-quaternary" />
          </span>
        )}
        {configuredEndpoints.length > 0 && (
          <div className="flex items-center gap-1.5 mt-0.5">
            {configuredEndpoints.map(et => {
              // 被修改过：preset 存在且当前值 !== 默认值
              const modified = !!preset && preset.endpoints[et] !== null && data.endpoints[et] !== preset.endpoints[et];
              return (
                <span key={et} className="relative inline-flex">
                  <ProtocolIcon type={et} size={12} />
                  {modified && (
                    <span
                      className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-warning ring-1 ring-bg-elevated"
                      title="URL 已被修改过"
                    />
                  )}
                </span>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  const renderExpandedEditor = (p: Provider) => {
    const data = formData[p.name] || { endpoints: {} as Record<EndpointType, string | null> };
    const results = testResults[p.name] || {};
    const preset = getPresetByName(p.name);

    return (
      <div key={`${p.name}-editor`} className="flex flex-col gap-2">
        {/* 下游块 */}
        <div className="p-3">
          <div className="flex items-center gap-2 text-[15px]">
            <span className="text-text-secondary w-[160px] shrink-0">下游接入地址</span>
            <code className="text-text-primary font-mono bg-bg-input px-2 py-1 rounded">
              {getAccessUrl(p)}
            </code>
            <Button
              type="text"
              size="small"
              icon={<CopyOutlined />}
              onClick={() => handleCopyAccessUrl(p)}
              className="!text-text-quaternary hover:!text-text-primary"
            />
          </div>
        </div>

        {/* 上游块：灰底 */}
        <div className="p-3 rounded-md border border-border-subtle bg-bg-surface/30">
          <div className="flex items-center gap-2 text-[15px] mb-2">
            <span className="text-text-secondary">上游接入地址</span>
          </div>

          {/* 三个 Endpoint */}
          <div className="space-y-2">
            {ENDPOINT_TYPES.map(et => {
              const val = data.endpoints[et];
              const result = results[et];
              const isTesting = testingMap[et];
              const defaultUrl = preset?.endpoints[et];
              const showReset = preset && defaultUrl !== null && val !== defaultUrl && val !== null;
              const hasUrlError = blurredFields.has(p.name + '.' + et) && val && !isValidUrl(val);
              return (
                <div key={et}>
                  <div className="flex items-center gap-2">
                  <span className={`inline-flex items-center gap-1.5 text-[13px] font-[510] shrink-0 w-[160px] ${getProtocolColor(et).text}`}>
                    <ProtocolIcon type={et} size={12} noColor />
                    {ENDPOINT_LABELS[et]}
                  </span>
                  <Input
                    value={val ?? ''}
                    onChange={e => updateFormData(p.name, et, e.target.value || null)}
                    onBlur={() => {
                      setBlurredFields(prev => new Set(prev).add(p.name + '.' + et));
                      handleAutoSave(p.name);
                    }}
                    placeholder={val === null ? '不支持（留空）' : '输入上游 URL'}
                    status={hasUrlError ? "error" : undefined}
                    className="flex-1"
                  />
                  {showReset && defaultUrl && (
                    <Tooltip
                      title={
                        <div className="text-[12px]">
                          <div>默认值:</div>
                          <div className="font-mono">{defaultUrl}</div>
                          <div className="mt-1 opacity-70">点击还原</div>
                        </div>
                      }
                    >
                      <span
                        className="text-xs text-warning cursor-pointer hover:text-warning/80 select-none"
                        onClick={() => updateFormData(p.name, et, defaultUrl)}
                      >
                        ●
                      </span>
                    </Tooltip>
                  )}
                  {val && (
                    <Button
                      size="small"
                      loading={isTesting}
                      onClick={() => handleTest(p.name, et)}
                    >
                      测试
                    </Button>
                  )}
                  {result && (
                    <div className={`flex items-center gap-1 text-xs ${
                      result.ok ? 'text-success' : 'text-warning'
                    }`}>
                      {result.ok ? <CheckCircleOutlined /> : <ExclamationCircleOutlined />}
                      <span>{result.ok ? `${result.duration}ms` : result.message.slice(0, 20)}</span>
                      <Button
                        type="text"
                        size="small"
                        icon={<CloseOutlined />}
                        onClick={() => setTestResults(prev => ({
                          ...prev,
                          [p.name]: { ...prev[p.name], [et]: null },
                        }))}
                        className="!text-current hover:!opacity-70"
                      />
                    </div>
                  )}
                  </div>
                  {hasUrlError && (
                    <div className="ml-[168px] text-[12px] text-error mt-0.5">
                      请输入有效的 HTTP(S) URL
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    );
  };

  // 把 providers 按 category 分桶
  const groupedProviders = (() => {
    const official: Provider[] = [];
    const community: Provider[] = [];
    const custom: Provider[] = [];
    for (const p of providers) {
      const preset = getPresetByName(p.name);
      if (!preset) custom.push(p);
      else if (preset.category === 'official') official.push(p);
      else community.push(p);
    }
    return { official, community, custom };
  })();

  const renderGroupedProviderList = () => {
    const groups: { key: 'official' | 'community' | 'custom'; label: string; items: Provider[] }[] = [
      { key: 'official', label: '官方', items: groupedProviders.official },
      { key: 'community', label: '社区', items: groupedProviders.community },
      { key: 'custom', label: '我的', items: groupedProviders.custom },
    ];
    return groups.map((g, idx) => {
      if (g.items.length === 0) return null;
      const expandedInGroup = g.items.find(p => p.name === expanded);
      return (
        <div key={g.key} className={idx === 0 ? '' : 'mt-4 pt-3 border-t border-border-subtle'}>
          <div className="text-[11px] font-[510] uppercase tracking-wide text-text-quaternary px-1 mb-2">
            {g.label}
          </div>
          <div className="grid grid-cols-3 gap-2">
            {g.items.map(p => renderProviderCard(p))}
          </div>
          {expandedInGroup && (
            <div className="mt-2">{renderExpandedEditor(expandedInGroup)}</div>
          )}
        </div>
      );
    });
  };

  return (
    <Modal
      title={<span className="text-text-primary text-[17px] font-[510]">供应商配置</span>}
      open={open}
      onCancel={handleClose}
      width={SETTINGS_MODAL_WIDTH}
      footer={null}
      destroyOnHidden
    >
      <div className="h-[420px] flex flex-col">
        {showPresetPanel ? (
          renderPresetPanel()
        ) : (
          <>
            {/* 列表区 */}
            <div className="flex-1 overflow-y-auto pt-2">
              {loading ? (
                <div className="flex items-center justify-center h-full text-text-secondary">
                  加载中...
                </div>
              ) : providers.length === 0 ? (
                <Empty description="暂无供应商" className="my-10" />
              ) : (
                renderGroupedProviderList()
              )}
            </div>

            {/* 底部新增按钮 */}
            <div className="pt-2 border-t border-border-subtle">
              <Button
                type="dashed"
                icon={<PlusOutlined />}
                block
                onClick={handleCreate}
                loading={loading}
              >
                新增供应商
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
