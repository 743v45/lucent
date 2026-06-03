import { useState, useEffect } from 'react';
import { Modal, Form, Input, Button, Space, message, Divider, Select, Tooltip } from 'antd';
import {
  PlusOutlined,
  SaveOutlined,
  CheckCircleOutlined,
  CopyOutlined,
  EditOutlined,
  DeleteOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { ProviderIcon } from '../common/ProviderIcon';
import {
  getProxyConfig,
  getProfileFull,
  updateProfile,
  createProfile,
  setActiveProfile,
  renameProfile,
  deleteProfile,
  testConnection,
} from '../../utils/api';
import type { ProxyConfig, ProviderType } from '../../types';

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
}

export function SettingsModal({ open, onClose }: SettingsModalProps) {
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; duration: number; message: string } | null>(null);
  const [config, setConfig] = useState<ProxyConfig | null>(null);
  const [selected, setSelected] = useState<string>('');
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState('');
  const [form] = Form.useForm();

  useEffect(() => {
    if (open) loadConfig();
  }, [open]);

  const loadConfig = async () => {
    try {
      const data = await getProxyConfig();
      setConfig(data);
      if (!selected || !data.profiles.some(p => p.name === selected)) {
        setSelected(data.activeProfile);
      }
    } catch {
      message.error('加载配置失败');
    }
  };

  useEffect(() => {
    if (selected) loadProfileForm(selected);
  }, [selected]);

  const loadProfileForm = async (name: string) => {
    try {
      const profile = await getProfileFull(name);
      form.setFieldsValue({
        upstreamBaseUrl: profile.upstreamBaseUrl,
        apiKey: profile.apiKey,
        provider: profile.provider,
      });
      setTestResult(null);
    } catch {
      message.error('加载配置详情失败');
    }
  };

  const handleSelect = (name: string) => {
    setSelected(name);
    setEditingName(false);
  };

  const handleActivate = async () => {
    try {
      await setActiveProfile(selected);
      message.success(`已启用: ${selected}`);
      await loadConfig();
    } catch {
      message.error('启用失败');
    }
  };

  const handleSave = async () => {
    try {
      const values = await form.validateFields();
      if (!selected) return;
      setSaving(true);
      await updateProfile(selected, {
        upstreamBaseUrl: values.upstreamBaseUrl,
        apiKey: values.apiKey,
        provider: values.provider,
      });
      message.success('保存成功');
      await loadConfig();
    } catch {
      message.error('请检查输入');
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    try {
      const values = await form.getFieldsValue(['upstreamBaseUrl', 'apiKey']);
      setTesting(true);
      setTestResult(null);
      const result = await testConnection(values.upstreamBaseUrl, values.apiKey);
      setTestResult(result);
      if (result.ok) {
        message.success(`连接正常 (${result.duration}ms)`);
      } else {
        message.warning(result.message);
      }
    } catch {
      setTestResult({ ok: false, duration: 0, message: '连接失败' });
    } finally {
      setTesting(false);
    }
  };

  const handleCreate = async () => {
    try {
      const existing = config?.profiles.map(p => p.name) ?? [];
      let name = 'default';
      let i = 2;
      while (existing.includes(name)) {
        name = `default ${i}`;
        i++;
      }
      await createProfile({
        name,
        upstreamBaseUrl: 'https://api.anthropic.com',
        apiKey: '',
        provider: 'anthropic',
      });
      setSelected(name);  // 先设置选中新创建的
      await loadConfig();  // 再加载配置，这样 selected 会在 profiles 中
      message.success(`已创建 ${name}`);
    } catch {
      message.error('创建失败');
    }
  };

  const handleRename = async () => {
    if (!nameInput.trim() || nameInput === selected) {
      setEditingName(false);
      return;
    }
    try {
      const result = await renameProfile(selected, nameInput.trim());
      if (!result) {
        message.error('名称已存在');
        return;
      }
      setSelected(nameInput.trim());
      await loadConfig();
      message.success('已重命名');
    } catch {
      message.error('重命名失败');
    } finally {
      setEditingName(false);
    }
  };

  const handleDelete = async () => {
    if ((config?.profiles.length ?? 0) <= 1) {
      message.warning('至少保留一个代理配置');
      return;
    }
    if (!window.confirm(`确定要删除「${selected}」吗？`)) return;

    try {
      const result = await deleteProfile(selected);
      if (!result) {
        message.warning('删除失败');
        return;
      }
      message.success('已删除');
      await loadConfig();
    } catch {
      message.error('删除失败');
    }
  };

  const handleCopyEnv = () => {
    const port = config?.proxyPort ?? 7048;
    const envCmd = `export ANTHROPIC_BASE_URL=http://127.0.0.1:${port}`;
    navigator.clipboard.writeText(envCmd).then(() => {
      message.success('已复制到剪贴板');
    }).catch(() => {
      message.error('复制失败');
    });
  };

  const isActive = selected === config?.activeProfile;
  const profiles = config?.profiles ?? [];

  return (
    <Modal
      title={<span className="text-text-primary text-[17px] font-[510]">代理配置</span>}
      open={open}
      onCancel={onClose}
      width={780}
      footer={null}
      destroyOnClose
    >
      {/* 左右结构 */}
      <div className="flex min-h-[420px] -mt-2">
        {/* 左侧：profile 列表 */}
        <div className="w-[180px] border-r border-border-subtle pr-4 flex flex-col">
          <span className="text-[13px] font-[510] text-text-quaternary uppercase tracking-wider mb-3">
            代理列表
          </span>

          <div className="flex-1 overflow-auto">
            {profiles.map(p => (
              <div
                key={p.name}
                onClick={() => handleSelect(p.name)}
                className={`flex items-center gap-2 px-3 py-2 mb-1 rounded-md cursor-pointer text-[15px] transition-colors ${
                  p.name === selected
                    ? 'bg-bg-elevated border-l-2 border-l-brand-accent'
                    : 'border-l-2 border-l-transparent hover:bg-bg-surface'
                }`}
              >
                {p.name === config?.activeProfile && (
                  <span className="text-white text-[13px] [&_.anticon]:!text-white">
                    <CheckCircleOutlined />
                  </span>
                )}
                <span className={`flex-1 truncate ${p.name === selected ? 'font-[510] text-text-primary' : 'text-text-secondary'}`}>
                  {p.name}
                </span>
                <Tooltip title={p.provider === 'openai' ? 'OpenAI' : 'Anthropic'}>
                  <ProviderIcon type={p.provider || 'anthropic'} size={18} />
                </Tooltip>
              </div>
            ))}
          </div>

          <Button
            type="dashed"
            icon={<PlusOutlined />}
            onClick={handleCreate}
            block
            size="small"
            className="!mt-2"
          >
            添加代理
          </Button>
        </div>

        {/* 右侧：配置编辑 */}
        <div className="flex-1 pl-4">
          {/* 标题行：名称 + 使用按钮 */}
          <div className="flex items-center mb-4">
            {editingName ? (
              <Input
                size="small"
                value={nameInput}
                onChange={e => setNameInput(e.target.value)}
                onPressEnter={handleRename}
                onBlur={handleRename}
                className="!w-[160px] !mr-2"
                autoFocus
              />
            ) : (
              <span
                className="text-lg font-[510] text-text-primary cursor-pointer flex items-center gap-1 hover:text-brand-accent transition-colors"
                onClick={() => { setEditingName(true); setNameInput(selected); }}
                title="点击重命名"
              >
                {selected}
                <EditOutlined className="text-[13px] text-text-quaternary" />
              </span>
            )}

            <div className="flex-1" />

            {!isActive && (
              <Button
                type="primary"
                icon={<ThunderboltOutlined />}
                onClick={handleActivate}
                size="small"
              >
                使用
              </Button>
            )}
            {isActive && (
              <span className="text-sm text-text-tertiary flex items-center gap-1">
                <CheckCircleOutlined className="text-white" />
                当前使用中
              </span>
            )}
          </div>

          <Form form={form} layout="vertical">
            <Form.Item
              label="代理类型"
              name="provider"
              className="mb-4"
            >
              <Select
                options={[
                  { label: 'Anthropic (Claude)', value: 'anthropic' },
                  { label: 'OpenAI (GPT)', value: 'openai' },
                ]}
              />
            </Form.Item>

            <Form.Item
              label="上游地址"
              name="upstreamBaseUrl"
              rules={[{ required: true, message: '请输入上游地址' }]}
              className="mb-4"
            >
              <Input placeholder="https://api.anthropic.com" />
            </Form.Item>

            <Form.Item label="API Key" name="apiKey" className="mb-4">
              <Input.Password
                placeholder="sk-ant-...（留空使用 Claude 配置的 key）"
              />
            </Form.Item>

            <Form.Item className="mb-2">
              <Space>
                <Button type="primary" icon={<SaveOutlined />} onClick={handleSave} loading={saving}>
                  保存
                </Button>
                <Button onClick={handleTest} loading={testing}>
                  测试连接
                </Button>
              </Space>
            </Form.Item>

            {testResult && (
              <div className={`px-3 py-2 rounded-lg text-[15px] mb-4 border ${
                testResult.ok
                  ? 'bg-success/10 border-success/20 text-success'
                  : 'bg-warning/10 border-warning/20 text-warning'
              }`}>
                {testResult.ok ? '✅' : '⚠️'} {testResult.message}
                {testResult.duration > 0 && (
                  <span className="ml-2 text-text-quaternary">{testResult.duration}ms</span>
                )}
              </div>
            )}
          </Form>

          <Divider className="!my-3 !border-border-subtle" />

          {/* 使用方式 */}
          <div>
            <span className="text-[17px] font-[510] text-text-secondary">使用方式</span>
            <div className="mt-2 px-4 py-2 bg-bg-input rounded-lg border border-border-subtle flex items-center justify-between">
              <code className="text-sm text-text-secondary font-mono">
                export ANTHROPIC_BASE_URL=http://127.0.0.1:{config?.proxyPort ?? 7048}
              </code>
              <Button
                type="text"
                size="small"
                icon={<CopyOutlined />}
                onClick={handleCopyEnv}
                className="!text-text-quaternary hover:!text-text-primary"
              />
            </div>
          </div>

          <Divider className="!my-3 !border-border-subtle" />

          {/* 删除 */}
          <Button
            type="text"
            danger
            icon={<DeleteOutlined />}
            onClick={handleDelete}
            size="small"
            className="!text-error/60 hover:!text-error"
          >
            删除此代理配置
          </Button>
        </div>
      </div>
    </Modal>
  );
}
