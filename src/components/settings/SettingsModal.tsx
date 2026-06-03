import { useState, useEffect } from 'react';
import { Modal, Form, Input, InputNumber, Button, Space, message, Divider, Typography } from 'antd';
import {
  PlusOutlined,
  SaveOutlined,
  CheckCircleOutlined,
  CopyOutlined,
  ThunderboltOutlined,
  EditOutlined,
  DeleteOutlined,
} from '@ant-design/icons';
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
import type { ProxyConfig } from '../../types';

const { Text } = Typography;

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

  // 加载配置
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

  // 选中 profile 时加载表单
  useEffect(() => {
    if (selected) loadProfileForm(selected);
  }, [selected]);

  const loadProfileForm = async (name: string) => {
    try {
      const profile = await getProfileFull(name);
      form.setFieldsValue({
        upstreamBaseUrl: profile.upstreamBaseUrl,
        apiKey: profile.apiKey,
        proxyPort: profile.proxyPort,
      });
      setTestResult(null);
    } catch {
      message.error('加载配置详情失败');
    }
  };

  // 选中（仅编辑，不激活）
  const handleSelect = (name: string) => {
    setSelected(name);
    setEditingName(false);
  };

  // 激活使用
  const handleActivate = async () => {
    try {
      await setActiveProfile(selected);
      message.success(`已启用: ${selected}`);
      await loadConfig();
    } catch {
      message.error('启用失败');
    }
  };

  // 保存
  const handleSave = async () => {
    try {
      const values = await form.validateFields();
      if (!selected) return;
      setSaving(true);
      await updateProfile(selected, {
        upstreamBaseUrl: values.upstreamBaseUrl,
        apiKey: values.apiKey,
        proxyPort: values.proxyPort,
      });
      message.success('保存成功');
      await loadConfig();
    } catch {
      message.error('请检查输入');
    } finally {
      setSaving(false);
    }
  };

  // 测试
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

  // 新增（自动命名）
  const handleCreate = async () => {
    try {
      // 生成默认名称: default, default 2, default 3 ...
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
        proxyPort: 7048,
      });
      await loadConfig();
      setSelected(name);
      message.success(`已创建 ${name}`);
    } catch {
      message.error('创建失败');
    }
  };

  // 改名
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

  // 删除 profile
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

  // 复制环境变量
  const handleCopyEnv = () => {
    const port = form.getFieldValue('proxyPort') ?? 7048;
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
      title="代理配置"
      open={open}
      onCancel={onClose}
      width={780}
      footer={null}
      destroyOnClose
    >
      {/* 左右结构 */}
      <div style={{ display: 'flex', gap: 0, minHeight: 400, marginTop: -8 }}>
        {/* 左侧：profile 列表 */}
        <div style={{
          width: 180,
          borderRight: '1px solid #f0f0f0',
          paddingRight: 16,
          display: 'flex',
          flexDirection: 'column',
        }}>
          <Text strong style={{ marginBottom: 12, fontSize: 13, color: '#999' }}>代理列表</Text>

          <div style={{ flex: 1, overflow: 'auto' }}>
            {profiles.map(p => (
              <div
                key={p.name}
                onClick={() => handleSelect(p.name)}
                style={{
                  padding: '8px 12px',
                  marginBottom: 4,
                  borderRadius: 6,
                  cursor: 'pointer',
                  background: p.name === selected ? '#e6f4ff' : 'transparent',
                  borderLeft: p.name === selected ? '3px solid #1890ff' : '3px solid transparent',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: 13,
                }}
              >
                {p.name === config?.activeProfile && (
                  <CheckCircleOutlined style={{ color: '#52c41a', fontSize: 12 }} />
                )}
                <span style={{
                  flex: 1,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  fontWeight: p.name === selected ? 500 : 400,
                }}>
                  {p.name}
                </span>
              </div>
            ))}
          </div>

          <Button
            type="dashed"
            icon={<PlusOutlined />}
            onClick={handleCreate}
            block
            size="small"
            style={{ marginTop: 8 }}
          >
            添加代理
          </Button>
        </div>

        {/* 右侧：配置编辑 */}
        <div style={{ flex: 1, paddingLeft: 16 }}>
          {/* 标题行：名称 + 使用按钮 */}
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 16 }}>
            {editingName ? (
              <Input
                size="small"
                value={nameInput}
                onChange={e => setNameInput(e.target.value)}
                onPressEnter={handleRename}
                onBlur={handleRename}
                style={{ width: 160, marginRight: 8 }}
                autoFocus
              />
            ) : (
              <span
                style={{ fontSize: 16, fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}
                onClick={() => { setEditingName(true); setNameInput(selected); }}
                title="点击重命名"
              >
                {selected}
                <EditOutlined style={{ fontSize: 12, color: '#999' }} />
              </span>
            )}

            <div style={{ flex: 1 }} />

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
              <Text type="secondary" style={{ fontSize: 12 }}>
                <CheckCircleOutlined style={{ color: '#52c41a', marginRight: 4 }} />
                当前使用中
              </Text>
            )}
          </div>

          <Form form={form} layout="vertical">
            <Form.Item
              label="上游地址"
              name="upstreamBaseUrl"
              rules={[{ required: true, message: '请输入上游地址' }]}
            >
              <Input placeholder="https://api.anthropic.com" />
            </Form.Item>

            <Form.Item label="API Key" name="apiKey">
              <Input.Password placeholder="sk-ant-...（留空使用 Claude 配置的 key）" />
            </Form.Item>

            <Form.Item label="代理端口" name="proxyPort">
              <InputNumber min={1024} max={65535} style={{ width: '100%' }} />
            </Form.Item>

            <Form.Item>
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
              <div style={{
                padding: '8px 12px',
                borderRadius: 6,
                background: testResult.ok ? '#f6ffed' : '#fff2e8',
                border: `1px solid ${testResult.ok ? '#b7eb8f' : '#ffbb96'}`,
                fontSize: 13,
                marginBottom: 16,
              }}>
                {testResult.ok ? '✅' : '⚠️'} {testResult.message}
                {testResult.duration > 0 && (
                  <span style={{ marginLeft: 8, color: '#999' }}>{testResult.duration}ms</span>
                )}
              </div>
            )}
          </Form>

          <Divider style={{ margin: '12px 0' }} />

          <div>
            <Text strong style={{ fontSize: 13 }}>使用方式</Text>
            <div style={{
              marginTop: 8,
              padding: '8px 12px',
              background: '#fafafa',
              borderRadius: 6,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}>
              <code style={{ fontSize: 12 }}>
                export ANTHROPIC_BASE_URL=http://127.0.0.1:{form.getFieldValue('proxyPort') ?? 7048}
              </code>
              <Button
                type="text"
                size="small"
                icon={<CopyOutlined />}
                onClick={handleCopyEnv}
              />
            </div>
          </div>

          <Divider style={{ margin: '12px 0' }} />

          <Button
            type="text"
            danger
            icon={<DeleteOutlined />}
            onClick={handleDelete}
            size="small"
          >
            删除此代理配置
          </Button>
        </div>
      </div>
    </Modal>
  );
}
