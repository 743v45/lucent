import { useState, useEffect } from 'react';
import { Modal, Button, message } from 'antd';
import { CopyOutlined, CheckOutlined } from '@ant-design/icons';
import { getProxyStatus } from '../../utils/api';
import { DEFAULT_PROXY_PORT, ENV_VAR_NAMES, API_INTERCEPT_PATHS, COPIED_FEEDBACK_DURATION_MS } from '../../constants';
import type { ApiProviderType } from '../../types';

interface UsageGuideProps {
  open: boolean;
  onClose: () => void;
}

const API_ITEMS: Array<{ type: ApiProviderType; label: string; envKey: keyof typeof ENV_VAR_NAMES }> = [
  { type: 'anthropic-messages', label: 'Anthropic', envKey: 'anthropic-messages' },
  { type: 'openai-chat', label: 'OpenAI Chat', envKey: 'openai-chat' },
  { type: 'openai-responses', label: 'OpenAI Responses', envKey: 'openai-responses' },
];

export function UsageGuide({ open, onClose }: UsageGuideProps) {
  const [proxyPort, setProxyPort] = useState(DEFAULT_PROXY_PORT);
  const [host, setHost] = useState('127.0.0.1');
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);

  useEffect(() => {
    if (open) {
      getProxyStatus()
        .then((status) => {
          setProxyPort(status.proxyPort || DEFAULT_PROXY_PORT);
          setHost(status.host || '127.0.0.1');
        })
        .catch(() => {
          setProxyPort(DEFAULT_PROXY_PORT);
          setHost('127.0.0.1');
        });
    }
  }, [open]);

  const handleCopy = (text: string, index: number) => {
    navigator.clipboard.writeText(text).then(() => {
      message.success('已复制到剪贴板');
      setCopiedIndex(index);
      setTimeout(() => setCopiedIndex(null), COPIED_FEEDBACK_DURATION_MS);
    }).catch(() => {
      message.error('复制失败');
    });
  };

  return (
    <Modal
      open={open}
      onCancel={onClose}
      title="使用说明"
      width={520}
      footer={null}
    >
      <div className="flex flex-col gap-4">
        <div>
          <h3 className="text-[15px] font-[510] text-text-primary mb-2">代理接入</h3>
          <p className="text-[14px] text-text-secondary mb-3">
            设置环境变量来接入代理，请求将被转发到对应上游：
          </p>
          <div className="flex flex-col gap-2">
            {API_ITEMS.map((item, index) => {
              const envCmd = `export ${ENV_VAR_NAMES[item.envKey]}=http://${host}:${proxyPort}`;
              const interceptPath = API_INTERCEPT_PATHS[item.type];
              return (
                <div key={item.type} className="flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] text-text-secondary shrink-0 w-[140px]">{item.label}</span>
                    <code className="flex-1 text-[13px] px-2 py-1 rounded bg-bg-deep text-text-primary font-mono break-all">
                      {envCmd}
                    </code>
                    <Button
                      type="text"
                      size="small"
                      icon={copiedIndex === index ? <CheckOutlined /> : <CopyOutlined />}
                      onClick={() => handleCopy(envCmd, index)}
                      className={copiedIndex === index ? '!text-success' : '!text-text-quaternary hover:!text-text-primary'}
                    />
                  </div>
                  <div className="flex items-center gap-2 ml-[148px]">
                    <span className="text-[12px] text-text-quaternary">拦截</span>
                    <code className="text-[12px] text-text-tertiary font-mono">{interceptPath}</code>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </Modal>
  );
}
