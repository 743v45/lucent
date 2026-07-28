import { useState, useEffect, useRef, type ChangeEvent } from 'react';
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
  DownloadOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import {
  listProviders,
  getProviderFull,
  createProvider,
  updateProvider,
  deleteProvider,
  renameProvider,
  testProviderEndpoint,
  getProxyStatus,
  exportConfigSql,
  importConfig,
} from '../../utils/api';
import { buildAccessUrl } from '../../utils/access-url';
import type { Provider, EndpointType, ProviderPreset } from '../../types';
import { ENDPOINT_TYPES, ENDPOINT_LABELS, isValidProviderName } from '../../types';
import { SETTINGS_MODAL_WIDTH, DEFAULT_PROXY_PORT } from '../../constants';
import { PROVIDER_PRESETS, PRESET_NAMES, getPresetByName } from '../../constants/presets';
import { getProtocolColor } from '../../constants/protocol-colors';
import { ProviderIcon } from '../common/ProviderIcon';
import { ProtocolIcon } from '../common/ProtocolIcon';

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
}

/** 校验是否为合法 URL（空值也合法，表示未配置） */
function isValidUrl(v: string | null): boolean {
  if (!v) return true;
  try { const u = new URL(v); return u.protocol === 'http:' || u.protocol === 'https:'; }
  catch { return false; }
}

/** 自动保存防抖间隔：每个 provider 独立计时，连续编辑合并为最后一次 blur 之后的一次 PUT */
const AUTOSAVE_DEBOUNCE_MS = 400;

export interface ProviderAutoSaverOptions {
  /** 防抖延迟（ms），默认 AUTOSAVE_DEBOUNCE_MS */
  delay?: number;
  /** 读取某个 provider 当前的 endpoints 快照（PUT 触发时才调用，天然拿到最新值） */
  getData: (name: string) => { endpoints: Record<EndpointType, string | null> } | undefined;
  /** PUT 成功回调（用返回的 Provider 更新本地 providers 列表） */
  onSaved: (name: string, updated: Provider) => void;
  /** PUT 失败回调 */
  onError: (name: string, err: unknown) => void;
  /** 即时 URL 校验失败回调（不调度 PUT） */
  onInvalid: (name: string, endpointType: EndpointType) => void;
}

export interface ProviderAutoSaver {
  /** 失焦时触发：先做即时 URL 校验，再按 provider 防抖调度 PUT */
  schedule: (name: string) => void;
  /** 清空所有 provider 的 pending 定时器（组件卸载时调用，避免泄漏 / 卸载后 setState） */
  cancelAll: () => void;
}

/**
 * 创建按 provider 防抖的自动保存器（修复 Bug #8 last-write-wins 静默回滚）。
 *
 * handleAutoSave 在 onBlur 时把整份 endpoints 快照整体 PUT；用户连续编辑同一 provider
 * 的多个 endpoint 会触发多次 blur → 多次并发 PUT，服务端整体替换 endpoints，后发的新值
 * 可能被先发的旧值覆盖，导致上游 URL 被静默回滚。
 *
 * 本保存器把同一 provider 在 delay（默认 400ms）内的多次 blur 合并为最后一次之后的一次 PUT，
 * 且 getData 在 PUT 触发时才读取，拿到的是最新值——从根上消除并发覆盖。
 */
export function createProviderAutoSaver(opts: ProviderAutoSaverOptions): ProviderAutoSaver {
  const delay = opts.delay ?? AUTOSAVE_DEBOUNCE_MS;
  // 每个 provider 一个 pending timer
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const doSave = async (name: string) => {
    const data = opts.getData(name);
    if (!data) return;
    try {
      const updated = await updateProvider(name, { endpoints: data.endpoints });
      opts.onSaved(name, updated);
    } catch (e) {
      opts.onError(name, e);
    }
  };

  return {
    schedule(name: string) {
      // 即时 URL 校验（不参与防抖，失焦立刻反馈）
      const data = opts.getData(name);
      if (!data) return;
      const invalidEt = ENDPOINT_TYPES.find(et => !isValidUrl(data.endpoints[et]));
      if (invalidEt) {
        opts.onInvalid(name, invalidEt);
        return;
      }
      // 按 provider 防抖：清掉该 provider 之前的 pending，重新计时
      clearTimeout(timers.get(name));
      timers.set(name, setTimeout(() => {
        timers.delete(name);
        void doSave(name);
      }, delay));
    },
    cancelAll() {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    },
  };
}

export function SettingsModal({ open, onClose }: SettingsModalProps) {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [testingMap, setTestingMap] = useState<Record<string, boolean>>({});
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
  // 导入后自增以触发 provider 列表重新加载（配置被整体替换）
  const [reloadNonce, setReloadNonce] = useState(0);

  // ref 始终指向最新 formData，避免 handleAutoSave 闭包读取旧值
  const formDataRef = useRef(formData);
  formDataRef.current = formData;
  // 导入文件选择隐藏 input
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 按 provider 防抖的自动保存器（修复连续编辑时并发 PUT 整体覆盖 endpoints 的回滚 bug）。
  // 用 useState 惰性初始化保证整个组件生命周期只创建一次，内部 timers Map 随之常驻。
  // getData/onSaved 都是按 ref 或 setState 函数式更新读取最新值，无闭包陈旧问题。
  const [autoSaver] = useState(() => createProviderAutoSaver({
    getData: (name) => formDataRef.current[name],
    onSaved: (name, updated) => setProviders(prev => prev.map(p => (p.name === name ? updated : p))),
    onError: (_name, err) => message.error((err as Error).message || '保存失败'),
    onInvalid: (_name, et) => message.warning(`${ENDPOINT_LABELS[et]} URL 格式无效，未保存`),
  }));
  // 组件卸载时清掉所有 pending 定时器，避免泄漏 / 卸载后 setState
  useEffect(() => () => autoSaver.cancelAll(), [autoSaver]);

  // 真实代理 host/port（修复 Bug #30：原硬编码 DEFAULT_PROXY_PORT，非默认端口时复制出的接入地址连不上）
  const [proxyHost, setProxyHost] = useState('127.0.0.1');
  const [proxyPort, setProxyPort] = useState(DEFAULT_PROXY_PORT);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const loadProviders = async () => {
      setLoading(true);
      try {
        // 并发拉取 provider 列表 + 代理状态（真实 host/port）；
        // 状态拉取失败不阻塞列表加载，端口/host 回退到默认值
        const [list, status] = await Promise.all([
          listProviders(),
          getProxyStatus().catch(() => null),
        ]);
        if (cancelled) return;
        setProviders(list);
        if (status) {
          setProxyPort(status.proxyPort || DEFAULT_PROXY_PORT);
          setProxyHost(status.host || '127.0.0.1');
        }
        // 并发拉取每个 provider 的完整配置（替代串行 N+1）
        const fulls = await Promise.all(list.map(p => getProviderFull(p.name)));
        if (cancelled) return;
        // 初始化 formData
        const data: Record<string, { endpoints: Record<EndpointType, string | null> }> = {};
        list.forEach((p, i) => {
          data[p.name] = { endpoints: fulls[i].endpoints };
        });
        setFormData(data);
        setTestResults({});
      } catch {
        if (!cancelled) message.error('加载供应商列表失败');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    loadProviders();
    return () => {
      cancelled = true;
    };
  }, [open, reloadNonce]);

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
      // 函数式更新，避免 await 后基于旧 providers 快照抹掉并发变更（修复 Bug #31 陈旧闭包）
      setProviders(prev => prev.filter(p => p.name !== name));
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
      // 函数式更新，避免 await 后基于旧 providers 快照抹掉并发变更（修复 Bug #31 陈旧闭包）
      setProviders(prev => prev.map(p => (p.name === oldName ? renamed : p)));
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

  /** 自动保存（失焦时触发，按 provider 防抖，静默） */
  const handleAutoSave = (name: string) => {
    autoSaver.schedule(name);
  };

  const handleTest = async (name: string, endpointType: EndpointType) => {
    const testKey = `${name}:${endpointType}`;
    setTestingMap(prev => ({ ...prev, [testKey]: true }));
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
      // 失败 toast 带具体错误信息（修复 Bug #14：原只弹通用"测试失败"，排障困难）
      message.error((e as Error).message || '测试失败');
    } finally {
      setTestingMap(prev => ({ ...prev, [testKey]: false }));
    }
  };

  const getAccessUrl = (p: Provider) => buildAccessUrl({
    name: p.name,
    presetName: p.presetName,
    host: proxyHost,
    port: proxyPort,
  });

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

  /** 导出当前配置为 SQL 脚本并触发浏览器下载（lucent-config.sql） */
  const handleExportConfig = async () => {
    try {
      const sql = await exportConfigSql();
      const blob = new Blob([sql], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'lucent-config.sql';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      message.success('配置已导出');
    } catch (e) {
      message.error((e as Error).message || '导出失败');
    }
  };

  /** 导入配置（.sql 或 .json）：读取文件文本 → POST → 成功后刷新 provider 列表 */
  const handleImportFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      await importConfig(text);
      message.success('配置已导入，正在刷新');
      setReloadNonce(n => n + 1); // 触发 effect 重新加载（配置已被整体替换）
    } catch (err) {
      message.error((err as Error).message || '导入失败');
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = ''; // 允许重复选同一文件
    }
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
                      data-testid="preset-item"
                      data-name={preset.name}
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
              data-testid="show-custom-input-btn"
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
                data-testid="custom-name-input"
                autoFocus
              />
              <Button
                size="small"
                type="primary"
                onClick={handleCreateCustom}
                loading={loading}
                data-testid="custom-confirm-btn"
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
        data-testid="provider-row"
        data-name={p.name}
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
          data-testid="delete-provider-btn"
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
              const isTesting = testingMap[`${p.name}:${et}`];
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
                    data-testid="endpoint-input"
                    data-protocol={et}
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
                      data-testid="test-connection-btn"
                      data-protocol={et}
                    >
                      测试
                    </Button>
                  )}
                  {result && (
                    <Tooltip title={result.ok ? undefined : result.message}>
                      <div
                        data-testid="test-result"
                        data-protocol={et}
                        data-ok={result.ok ? 'true' : 'false'}
                        className={`flex items-center gap-1 text-xs ${
                        result.ok ? 'text-success' : 'text-warning'
                        }`}>
                        {result.ok ? <CheckCircleOutlined /> : <ExclamationCircleOutlined />}
                        <span className={result.ok ? undefined : 'inline-block max-w-[200px] truncate'}>
                          {result.ok ? `${result.duration}ms` : result.message}
                        </span>
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
                    </Tooltip>
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
      <div className="h-[420px] flex flex-col" data-testid="settings-modal">
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
              <div className="flex items-center justify-end gap-1 mb-2">
                <Button
                  size="small"
                  type="text"
                  icon={<DownloadOutlined />}
                  onClick={handleExportConfig}
                  data-testid="export-config-btn"
                >
                  导出配置
                </Button>
                <Button
                  size="small"
                  type="text"
                  icon={<UploadOutlined />}
                  onClick={() => fileInputRef.current?.click()}
                  data-testid="import-config-btn"
                >
                  导入配置
                </Button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".sql,.json,application/json,text/plain"
                  onChange={handleImportFile}
                  className="hidden"
                />
              </div>
              <Button
                type="dashed"
                icon={<PlusOutlined />}
                block
                onClick={handleCreate}
                loading={loading}
                data-testid="add-provider-btn"
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
