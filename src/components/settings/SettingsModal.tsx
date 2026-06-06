import { useState, useEffect } from 'react';
import { Modal, Form, Input, Button, Space, message, Divider, Tooltip, Collapse, Dropdown } from 'antd';
import type { MenuProps } from 'antd';
import {
  PlusOutlined,
  SaveOutlined,
  CheckCircleOutlined,
  CopyOutlined,
  EditOutlined,
  DeleteOutlined,
  ThunderboltOutlined,
  ExclamationCircleOutlined,
  CloseOutlined,
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
import type { ProxyConfig, ApiProviderType, SafeProxyProfile } from '../../types';
import { API_TYPE_LABELS } from '../../types';
import { DEFAULT_PROXY_PORT, DEFAULT_UPSTREAM_URLS, ENV_VAR_NAMES, SETTINGS_MODAL_WIDTH, DEFAULT_PROFILE_NAME } from '../../constants';

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
}

export function SettingsModal({ open, onClose }: SettingsModalProps) {
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; duration: number; message: string } | null>(null);
  const [config, setConfig] = useState<ProxyConfig | null>(null);
  const [selectedApiType, setSelectedApiType] = useState<ApiProviderType>('anthropic-messages');
  const [selectedProfileId, setSelectedProfileId] = useState<string>('');
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState('');
  const [activeGroups, setActiveGroups] = useState<string[]>(['anthropic-messages']);
  const [form] = Form.useForm();

  useEffect(() => {
    if (open) loadConfig();
  }, [open]);

  const loadConfig = async () => {
    try {
      const data = await getProxyConfig();
      setConfig(data);

      // Auto-select the first group's active profile
      if (data.groups.length > 0) {
        const firstGroup = data.groups[0];
        setSelectedApiType(firstGroup.apiType);
        setSelectedProfileId(firstGroup.activeProfileId);
        setActiveGroups([firstGroup.apiType]);
      }
    } catch {
      message.error('加载配置失败');
    }
  };

  useEffect(() => {
    if (selectedApiType && selectedProfileId) loadProfileForm();
  }, [selectedApiType, selectedProfileId]);

  const loadProfileForm = async () => {
    try {
      const profile = await getProfileFull(selectedApiType, selectedProfileId);
      form.setFieldsValue({
        upstreamBaseUrl: profile.upstreamBaseUrl,
        apiKey: profile.apiKey,
      });
      setTestResult(null);
    } catch {
      message.error('加载配置详情失败');
    }
  };

  const handleSelectProfile = (apiType: ApiProviderType, profileId: string) => {
    setSelectedApiType(apiType);
    setSelectedProfileId(profileId);
    setEditingName(false);
    // 切换分组时折叠其他分组，只展开当前分组
    setActiveGroups([apiType]);
  };

  const handleGroupChange = (keys: string | string[]) => {
    const activeKeys = Array.isArray(keys) ? keys : [keys];
    // 手风琴模式：只保留最后点击的一个分组
    if (activeKeys.length > 0) {
      setActiveGroups([activeKeys[activeKeys.length - 1]]);
    } else {
      setActiveGroups([]);
    }
  };

  const handleActivate = async () => {
    try {
      await setActiveProfile(selectedApiType, selectedProfileId);
      message.success('已启用');
      await loadConfig();
    } catch {
      message.error('启用失败');
    }
  };

  const handleSave = async () => {
    try {
      const values = await form.validateFields();
      setSaving(true);
      await updateProfile(selectedApiType, selectedProfileId, {
        upstreamBaseUrl: values.upstreamBaseUrl,
        apiKey: values.apiKey,
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
      const result = await testConnection(selectedApiType, values.upstreamBaseUrl, values.apiKey);
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

  const handleCreate = async (apiType: ApiProviderType) => {
    try {
      const group = config?.groups.find(g => g.apiType === apiType);
      if (!group) return;

      const existing = group.profiles.map(p => p.name);
      let name = DEFAULT_PROFILE_NAME;
      let i = 2;
      while (existing.includes(name)) {
        name = `default ${i}`;
        i++;
      }

      await createProfile(apiType, {
        name,
        upstreamBaseUrl: getDefaultBaseUrl(apiType),
        apiKey: '',
      });

      // 重新加载配置
      const newConfig = await getProxyConfig();
      setConfig(newConfig);

      // 找到新创建的 profile（最后一个）
      const newGroup = newConfig.groups.find(g => g.apiType === apiType);
      const newProfile = newGroup?.profiles[newGroup.profiles.length - 1];
      if (newProfile) {
        setSelectedApiType(apiType);
        setSelectedProfileId(newProfile.id);
        setActiveGroups([apiType]); // 展开该分组，折叠其他
      }

      message.success(`已创建 ${name}`);
    } catch {
      message.error('创建失败');
    }
  };

  const addProxyMenuItems: MenuProps['items'] = [
    {
      key: 'anthropic-messages',
      label: (
        <div className="flex items-center gap-2 text-text-primary">
          <ProviderIcon type="anthropic-messages" size={16} />
          <span>Anthropic Messages</span>
        </div>
      ),
    },
    {
      key: 'openai-chat',
      label: (
        <div className="flex items-center gap-2 text-text-primary">
          <ProviderIcon type="openai-chat" size={16} />
          <span>OpenAI Chat</span>
        </div>
      ),
    },
    {
      key: 'openai-responses',
      label: (
        <div className="flex items-center gap-2 text-text-primary">
          <ProviderIcon type="openai-responses" size={16} />
          <span>OpenAI Responses</span>
        </div>
      ),
    },
  ];

  const handleRename = async () => {
    if (!nameInput.trim() || nameInput === getCurrentProfileName()) {
      setEditingName(false);
      return;
    }
    try {
      await renameProfile(selectedApiType, selectedProfileId, nameInput.trim());
      setSelectedProfileId(nameInput.trim());
      await loadConfig();
      message.success('已重命名');
    } catch {
      message.error('重命名失败');
    } finally {
      setEditingName(false);
    }
  };

  const handleDelete = async () => {
    const group = config?.groups.find(g => g.apiType === selectedApiType);
    if (!group || group.profiles.length <= 1) {
      message.warning('至少保留一个代理配置');
      return;
    }
    if (!window.confirm(`确定要删除「${getCurrentProfileName()}」吗？`)) return;

    try {
      await deleteProfile(selectedApiType, selectedProfileId);
      message.success('已删除');
      await loadConfig();
    } catch {
      message.error('删除失败');
    }
  };

  const handleCopyEnv = () => {
    const port = config?.proxyPort ?? DEFAULT_PROXY_PORT;
    const envVar = getEnvVarName(selectedApiType);
    const envCmd = `export ${envVar}=http://127.0.0.1:${port}`;
    navigator.clipboard.writeText(envCmd).then(() => {
      message.success('已复制到剪贴板');
    }).catch(() => {
      message.error('复制失败');
    });
  };

  const getCurrentProfileName = () => {
    const group = config?.groups.find(g => g.apiType === selectedApiType);
    return group?.profiles.find(p => p.id === selectedProfileId)?.name ?? '';
  };

  const isActive = () => {
    const group = config?.groups.find(g => g.apiType === selectedApiType);
    return selectedProfileId === group?.activeProfileId;
  };

  const getDefaultBaseUrl = (apiType: ApiProviderType): string => {
    return DEFAULT_UPSTREAM_URLS[apiType];
  };

  const getEnvVarName = (apiType: ApiProviderType): string => {
    return ENV_VAR_NAMES[apiType];
  };

  const renderProfileItem = (profile: SafeProxyProfile, apiType: ApiProviderType) => {
    const group = config?.groups.find(g => g.apiType === apiType);
    const isActiveProfile = profile.id === group?.activeProfileId;
    const isSelected = selectedApiType === apiType && selectedProfileId === profile.id;

    return (
      <div
        key={profile.id}
        onClick={() => handleSelectProfile(apiType, profile.id)}
        className={`flex items-center gap-2 px-3 py-2 mb-1 rounded-md cursor-pointer text-[15px] transition-colors ${
          isSelected
            ? 'bg-bg-elevated border-l-2 border-l-brand-accent'
            : 'border-l-2 border-l-transparent hover:bg-bg-surface'
        }`}
      >
        {isActiveProfile && (
          <span className="text-success text-[13px] [&_.anticon]:!text-success">
            <CheckCircleOutlined />
          </span>
        )}
        <span className={`flex-1 truncate ${isSelected ? 'font-[510] text-text-primary' : 'text-text-secondary'}`}>
          {profile.name}
        </span>
        <ProviderIcon type={apiType} size={18} className="text-text-secondary" />
      </div>
    );
  };

  const renderGroupHeader = (apiType: ApiProviderType) => {
    return (
      <div className="flex items-center gap-2 text-[15px] font-[510]">
        <ProviderIcon type={apiType} size={18} className="text-text-secondary" />
        <span className="text-text-primary">{API_TYPE_LABELS[apiType]}</span>
      </div>
    );
  };

  return (
    <Modal
      title={<span className="text-text-primary text-[17px] font-[510]">代理配置</span>}
      open={open}
      onCancel={onClose}
      width={SETTINGS_MODAL_WIDTH}
      footer={null}
      destroyOnClose
    >
      {/* 左右结构 */}
      <div className="flex h-[420px]">
        {/* 左侧：分组可折叠代理列表 */}
        <div className="w-[260px] border-r border-border-subtle pr-4 pt-2 flex flex-col">
          <div className="flex-1 overflow-y-auto">
            <Collapse
              activeKey={activeGroups}
              onChange={handleGroupChange}
              className="!bg-transparent !border-0 [&_.ant-collapse-header]:!bg-bg-surface/50 [&_.ant-collapse-content]:!bg-bg-surface/30 [&_.ant-collapse-content-box]:!p-0 !text-text-primary"
              expandIconPosition="end"
              items={config?.groups.map(group => ({
                key: group.apiType,
                label: renderGroupHeader(group.apiType),
                children: (
                  <div className="px-2 pb-2">
                    {group.profiles.map(p => renderProfileItem(p, group.apiType))}
                  </div>
                ),
              }))}
            />
          </div>

          <Dropdown
            menu={{
              items: addProxyMenuItems,
              onClick: ({ key }) => handleCreate(key as ApiProviderType),
              className: '!bg-bg-surface !border-border-subtle',
            }}
            placement="topLeft"
            overlayClassName="[&_.ant-dropdown-menu]:!bg-bg-surface [&_.ant-dropdown-menu-item]:!text-text-primary [&_.ant-dropdown-menu-item:hover]:!bg-bg-elevated"
          >
            <Button
              type="dashed"
              icon={<PlusOutlined />}
              block
              size="small"
              className="mt-2"
            >
              添加代理
            </Button>
          </Dropdown>
        </div>

        {/* 右侧：配置编辑 */}
        <div className="flex-1 pl-4 pt-2 pb-2 flex flex-col">
          <div className="flex-1 overflow-y-auto border border-border-subtle rounded-lg bg-bg-surface/50 p-4">
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
                onClick={() => { setEditingName(true); setNameInput(getCurrentProfileName()); }}
                title="点击重命名"
              >
                {getCurrentProfileName()}
                <EditOutlined className="text-[13px] text-text-quaternary" />
              </span>
            )}

            <div className="flex-1" />

            {!isActive() && (
              <Button
                type="primary"
                icon={<ThunderboltOutlined />}
                onClick={handleActivate}
                size="small"
              >
                使用
              </Button>
            )}
            {isActive() && (
              <span className="text-sm text-success flex items-center gap-1">
                <CheckCircleOutlined className="text-success" />
                使用中
              </span>
            )}
          </div>

          <Form form={form} layout="vertical">
            <Form.Item
              label="上游地址"
              name="upstreamBaseUrl"
              rules={[{ required: true, message: '请输入上游地址' }]}
              className="mb-4"
            >
              <Input placeholder={getDefaultBaseUrl(selectedApiType)} />
            </Form.Item>

            <Form.Item
              label={
                <span>
                  API Key{' '}
                  <Tooltip title="上游 API 的认证密钥。留空则使用 Claude CLI 自身配置的密钥">
                    <ExclamationCircleOutlined className="text-text-quaternary text-xs" />
                  </Tooltip>
                </span>
              }
              name="apiKey"
              className="mb-4"
            >
              <Input.Password
                placeholder="sk-ant-...（留空使用 Claude 配置的 key）"
                className="!bg-black [&_.ant-input]:!bg-black [&_.ant-input]:!text-white [&_.ant-input-suffix]:!text-white/50"
              />
            </Form.Item>

            <Form.Item className="mb-2 flex justify-end">
              <Space>
                <Button onClick={handleTest} loading={testing}>
                  测试连接
                </Button>
                <Button type="primary" icon={<SaveOutlined />} onClick={handleSave} loading={saving}>
                  保存
                </Button>
              </Space>
            </Form.Item>

            {testResult && (
              <div className={`px-3 py-2 rounded-lg text-[15px] mb-4 border flex items-center justify-between ${
                testResult.ok
                  ? 'bg-success/10 border-success/20 text-success'
                  : 'bg-warning/10 border-warning/20 text-warning'
              }`}>
                <span>
                  {testResult.ok ? '✅' : '⚠️'} {testResult.message}
                  {testResult.duration > 0 && (
                    <span className="ml-2 text-text-quaternary">{testResult.duration}ms</span>
                  )}
                </span>
                <Button
                  type="text"
                  size="small"
                  icon={<CloseOutlined />}
                  onClick={() => setTestResult(null)}
                  className="!text-current hover:!opacity-70"
                />
              </div>
            )}
          </Form>

          <Divider className="!my-3 !border-border-subtle" />

          {/* 使用方式 */}
          <div>
            <span className="text-[17px] font-[510] text-text-secondary">使用方式</span>
            <div className="mt-2 px-4 py-2 bg-bg-input rounded-lg border border-border-subtle flex items-center justify-between">
              <code className="text-sm text-text-secondary font-mono">
                export {getEnvVarName(selectedApiType)}=http://127.0.0.1:{config?.proxyPort ?? DEFAULT_PROXY_PORT}
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
      </div>
    </Modal>
  );
}
