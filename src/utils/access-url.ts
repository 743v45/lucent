/**
 * 下游接入地址拼接（单一来源，修复 Bug #30 / #33 两处拼接漂移）
 *
 * SettingsModal.getAccessUrl 与 UsageGuide.buildAccessLines 原本各自实现
 * `http://{host}:{port}/{prefix}{name} + openai 加 /v1 + presetName 空加 custom/`，
 * 已在端口维度产生偏差（SettingsModal 硬编码 DEFAULT_PROXY_PORT）。
 *
 * 规则（与 server 路由一致，见 server/index.ts 启动 banner + server/proxy.ts 路由匹配）:
 * - 预设供应商 (presetName 非空): http://{host}:{port}/{name}
 * - 自定义供应商 (presetName 为空): http://{host}:{port}/custom/{name}
 * - OpenAI 端点 (openai-chat / openai-responses): 末尾加 /v1
 */
import type { EndpointType } from '../types';

/** OpenAI 系端点：接入地址末尾需加 /v1 */
const V1_ENDPOINTS: ReadonlySet<EndpointType> = new Set(['openai-chat', 'openai-responses']);

export interface BuildAccessUrlOptions {
  /** 供应商 name（路径段，全局唯一） */
  name: string;
  /** 非空=预设供应商（路径无前缀）；空/undefined=自定义供应商（路径加 custom/ 前缀） */
  presetName?: string | null;
  /** 端点类型：OpenAI 系自动追加 /v1 后缀；不传则只返回基础路径（无 /v1） */
  endpointType?: EndpointType;
  /** 主机，默认 127.0.0.1 */
  host?: string;
  /** 代理端口 */
  port: number;
}

/**
 * 构造下游接入地址（纯函数，便于单测）。
 */
export function buildAccessUrl({
  name,
  presetName,
  endpointType,
  host = '127.0.0.1',
  port,
}: BuildAccessUrlOptions): string {
  const prefix = presetName ? '' : 'custom/';
  const suffix = endpointType && V1_ENDPOINTS.has(endpointType) ? '/v1' : '';
  return `http://${host}:${port}/${prefix}${name}${suffix}`;
}
