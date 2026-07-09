import { useState, useEffect } from 'react';
import { Modal, Button, message } from 'antd';
import { CopyOutlined, CheckOutlined } from '@ant-design/icons';
import { getProxyStatus } from '../../utils/api';
import { DEFAULT_PROXY_PORT, COPIED_FEEDBACK_DURATION_MS } from '../../constants';
import type { EndpointType } from '../../types';

interface UsageGuideProps {
  open: boolean;
  onClose: () => void;
  onOpenSettings?: () => void;
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

export interface AccessLine {
  providerName: string;
  endpointType: EndpointType;
  clientName: string;
  cmd: string;
  upstreamUrl: string;
}

export interface AccessLineInput {
  name: string;
  presetName: string | null;
  endpoints: Partial<Record<EndpointType, string>>;
}

/**
 * 生成接入指令列表（纯函数，便于单测）
 *
 * 接入地址规则（与 server 路由一致，见 server/index.ts:108 + proxy.ts:34）:
 * - 预设供应商 (presetName 非空): http://{host}:{port}/{name}
 * - 自定义供应商 (presetName 为空): http://{host}:{port}/custom/{name}
 * - OpenAI 端点: 末尾加 /v1
 *
 * 去重：openai-chat 与 openai-responses 都映射到 OPENAI_BASE_URL 且路径相同，
 * 同一供应商只会生成一条 OPENAI 命令（与 server/index.ts:112 启动 banner 的合并行为一致），
 * 否则默认 openai 预设（两个 OpenAI 端点都配）会显示两条一模一样的命令。
 */
export function buildAccessLines(
  host: string,
  port: number,
  providers: AccessLineInput[],
): AccessLine[] {
  const lines: AccessLine[] = [];
  const seenCmd = new Set<string>();
  for (const provider of providers) {
    const endpointTypes = Object.keys(provider.endpoints) as EndpointType[];
    for (const endpointType of endpointTypes) {
      const endpointUrl = provider.endpoints[endpointType];
      if (!endpointUrl) continue;
      const envVar = ENV_VAR_FOR_ENDPOINT[endpointType];
      const suffix = NEEDS_V1_SUFFIX.has(endpointType) ? '/v1' : '';
      const prefix = provider.presetName ? '' : 'custom/';
      const cmd = `export ${envVar}=http://${host}:${port}/${prefix}${provider.name}${suffix}`;
      // cmd 含 provider name（全局唯一），同一 cmd 只可能来自同一供应商，
      // 故按 cmd 去重只会合并同一供应商的 openai-chat / openai-responses。
      if (seenCmd.has(cmd)) continue;
      seenCmd.add(cmd);
      lines.push({
        providerName: provider.name,
        endpointType,
        clientName: CLIENT_NAME_FOR_ENDPOINT[endpointType],
        cmd,
        upstreamUrl: endpointUrl,
      });
    }
  }
  return lines;
}

export function UsageGuide({ open, onClose, onOpenSettings }: UsageGuideProps) {
  const [proxyPort, setProxyPort] = useState(DEFAULT_PROXY_PORT);
  const [host, setHost] = useState('127.0.0.1');
  const [providers, setProviders] = useState<AccessLineInput[]>([]);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);

  useEffect(() => {
    if (open) {
      getProxyStatus()
        .then((status) => {
          setProxyPort(status.proxyPort || DEFAULT_PROXY_PORT);
          setHost(status.host || '127.0.0.1');
          setProviders((status.providers || []) as AccessLineInput[]);
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

  const handleOpenSettings = () => {
    onClose();
    onOpenSettings?.();
  };

  // 生成接入指令列表
  const accessLines = buildAccessLines(host, proxyPort, providers);

  return (
    <Modal
      open={open}
      onCancel={onClose}
      title="使用说明"
      width={560}
      footer={null}
    >
      <div className="flex flex-col gap-4" data-testid="usage-guide">
        {/* 文案两段 */}
        <div className="flex flex-col gap-2">
          <p className="text-[14px] text-text-secondary leading-relaxed">
            Lucent 是 AI API 代理。在「配置」中添加供应商，设置环境变量将客户端请求指向本代理即可。
          </p>
          <p className="text-[14px] text-text-secondary leading-relaxed">
            预设供应商无前缀；自定义供应商加 <code className="font-mono text-text-primary bg-bg-input px-1.5 py-0.5 rounded text-[13px]">custom/</code>；OpenAI 端点需加 <code className="font-mono text-text-primary bg-bg-input px-1.5 py-0.5 rounded text-[13px]">/v1</code> 后缀。
          </p>
        </div>

        {/* 按客户端分组 */}
        {accessLines.length > 0 && (
          <div className="flex flex-col gap-5">
            {(['Claude Code', 'Codex / OpenAI'] as const).map((groupName) => {
              const groupLines = accessLines.filter(l => l.clientName === groupName);
              if (groupLines.length === 0) return null;
              return (
                <div key={groupName} className="flex flex-col gap-2">
                  <h3 className="text-[14px] font-[560] text-text-primary m-0">{groupName}</h3>
                  <div className="flex flex-col gap-2">
                    {groupLines.map((line, index) => (
                      <div
                        key={`${line.providerName}-${line.endpointType}`}
                        className="flex flex-col gap-1"
                        data-testid="access-line"
                        data-client={line.clientName}
                      >
                        <div className="flex items-center gap-2">
                          <code className="flex-1 text-[13px] px-2 py-1.5 rounded bg-bg-deep text-text-primary font-mono break-all">
                            {line.cmd}
                          </code>
                          <Button
                            type="text"
                            size="small"
                            data-testid="copy-cmd"
                            icon={copiedIndex === index ? <CheckOutlined /> : <CopyOutlined />}
                            onClick={() => handleCopy(line.cmd, index)}
                            className={copiedIndex === index ? '!text-success' : '!text-text-quaternary hover:!text-text-primary'}
                          />
                        </div>
                        <div className="flex items-center gap-2 pl-1">
                          <span className="text-[12px] text-text-quaternary shrink-0">供应商 {line.providerName} → 上游</span>
                          <code className="text-[12px] text-text-tertiary font-mono truncate" title={line.upstreamUrl}>
                            {line.upstreamUrl}
                          </code>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {accessLines.length === 0 && (
          <div className="flex flex-col gap-3">
            <div className="text-[14px] text-text-quaternary">暂无配置的供应商。请先在「配置」中添加供应商。</div>
            {onOpenSettings && (
              <div>
                <Button type="primary" size="small" onClick={handleOpenSettings}>去配置</Button>
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
