import { useState, useEffect } from 'react';
import { Modal, Button, message, Collapse } from 'antd';
import { CopyOutlined, CheckOutlined } from '@ant-design/icons';
import { getProxyStatus } from '../../utils/api';
import { DEFAULT_PROXY_PORT, COPIED_FEEDBACK_DURATION_MS } from '../../constants';
import type { Provider, EndpointType } from '../../types';

interface UsageGuideProps {
  open: boolean;
  onClose: () => void;
}

/** 端点类型对应的接入环境变量名 */
const ENV_VAR_FOR_ENDPOINT: Record<EndpointType, string> = {
  'anthropic-messages': 'ANTHROPIC_BASE_URL',
  'openai-chat': 'OPENAI_BASE_URL',
  'openai-responses': 'OPENAI_BASE_URL',
};

/** 端点类型对应的接入客户端名称 */
const CLIENT_NAME_FOR_ENDPOINT: Record<EndpointType, string> = {
  'anthropic-messages': 'Claude Code',
  'openai-chat': 'Codex / OpenAI',
  'openai-responses': 'Codex / OpenAI',
};

/** OpenAI 端点需要额外加 /v1 后缀 */
const NEEDS_V1_SUFFIX: Set<EndpointType> = new Set(['openai-chat', 'openai-responses']);

export function UsageGuide({ open, onClose }: UsageGuideProps) {
  const [proxyPort, setProxyPort] = useState(DEFAULT_PROXY_PORT);
  const [host, setHost] = useState('127.0.0.1');
  const [providers, setProviders] = useState<Provider[]>([]);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);

  useEffect(() => {
    if (open) {
      getProxyStatus()
        .then((status) => {
          setProxyPort(status.proxyPort || DEFAULT_PROXY_PORT);
          setHost(status.host || '127.0.0.1');
          setProviders(status.providers || []);
        })
        .catch(() => {
          setProxyPort(DEFAULT_PROXY_PORT);
          setHost('127.0.0.1');
          setProviders([]);
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

  // 生成接入指令列表
  const accessLines: Array<{ provider: Provider; endpointType: EndpointType; cmd: string; clientName: string }> = [];
  providers.forEach((provider) => {
    const endpointTypes = Object.keys(provider.endpoints) as EndpointType[];
    endpointTypes.forEach((endpointType) => {
      const endpointUrl = provider.endpoints[endpointType];
      if (endpointUrl) {
        const envVar = ENV_VAR_FOR_ENDPOINT[endpointType];
        const suffix = NEEDS_V1_SUFFIX.has(endpointType) ? '/v1' : '';
        const cmd = `export ${envVar}=http://${host}:${proxyPort}/api/${provider.name}${suffix}`;
        const clientName = CLIENT_NAME_FOR_ENDPOINT[endpointType];
        accessLines.push({ provider, endpointType, cmd, clientName });
      }
    });
  });

  return (
    <Modal
      open={open}
      onCancel={onClose}
      title="使用说明"
      width={520}
      footer={null}
    >
      <div className="flex flex-col gap-4">
        {/* 通用介绍 */}
        <div className="flex flex-col gap-2">
          <p className="text-[14px] text-text-secondary leading-relaxed">
            AgentProxy 是一个 AI API 代理。在「配置」中添加供应商并填入上游 URL，
            然后设置环境变量将客户端请求指向本代理即可。
          </p>
          <p className="text-[14px] text-text-secondary leading-relaxed">
            代理地址格式：<code className="text-text-primary font-mono bg-bg-input px-1.5 py-0.5 rounded text-[13px]">http://{host}:{proxyPort}/api/{"{供应商名}"}</code>
          </p>
        </div>

        {/* 折叠详情 */}
        {accessLines.length > 0 && (
          <Collapse
            ghost
            size="small"
            items={[
              {
                key: 'access',
                label: <span className="text-[14px] font-[510] text-text-secondary">接入指令</span>,
                children: (
                  <div className="flex flex-col gap-3">
                    {accessLines.map((line, index) => (
                      <div key={`${line.provider.name}-${line.endpointType}`} className="flex flex-col gap-1">
                        <div className="flex items-center gap-2">
                          <span className="text-[13px] text-text-secondary shrink-0 w-[100px]">{line.clientName}</span>
                          <code className="flex-1 text-[13px] px-2 py-1 rounded bg-bg-deep text-text-primary font-mono break-all">
                            {line.cmd}
                          </code>
                          <Button
                            type="text"
                            size="small"
                            icon={copiedIndex === index ? <CheckOutlined /> : <CopyOutlined />}
                            onClick={() => handleCopy(line.cmd, index)}
                            className={copiedIndex === index ? '!text-success' : '!text-text-quaternary hover:!text-text-primary'}
                          />
                        </div>
                        <div className="flex items-center gap-2 ml-[108px]">
                          <span className="text-[12px] text-text-quaternary">供应商</span>
                          <code className="text-[12px] text-text-tertiary font-mono">{line.provider.name}</code>
                          <span className="text-[12px] text-text-quaternary">→ 上游</span>
                          <code className="text-[12px] text-text-tertiary font-mono truncate" title={line.provider.endpoints[line.endpointType] || ''}>
                            {line.provider.endpoints[line.endpointType]}
                          </code>
                        </div>
                      </div>
                    ))}
                  </div>
                ),
              },
            ]}
          />
        )}

        {accessLines.length === 0 && (
          <div className="text-[14px] text-text-quaternary">
            暂无配置的供应商。请先在「配置」中添加供应商。
          </div>
        )}
      </div>
    </Modal>
  );
}
