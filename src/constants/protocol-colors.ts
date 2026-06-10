/**
 * 协议（EndpointType）配色常量
 *
 * 用于 ProtocolIcon、SettingsModal、LogList 等所有需要区分协议的地方。
 * 风格参考 LogList 的 tag：`bg-[#XXX]/20 text-[#XXX]`。
 *
 * 选色原则：每个 EndpointType 一个独立色，保证两个 OpenAI 协议（chat / responses）也能区分。
 */

import type { EndpointType } from '../types';

export interface ProtocolColor {
  /** 主色（HEX），用于 text、border、icon fill */
  hex: string;
  /** 文字色 className（Tailwind 任意值） */
  text: string;
  /** 背景色 className（带 /20 透明度） */
  bg: string;
  /** 边框色 className（带 /30 透明度） */
  border: string;
}

export const PROTOCOL_COLOR_MAP: Record<EndpointType, ProtocolColor> = {
  // Anthropic 品牌橙
  'anthropic-messages': {
    hex: '#D97757',
    text: 'text-[#D97757]',
    bg: 'bg-[#D97757]/20',
    border: 'border-[#D97757]/30',
  },
  // OpenAI 绿（chat 用经典绿）
  'openai-chat': {
    hex: '#10A37F',
    text: 'text-[#10A37F]',
    bg: 'bg-[#10A37F]/20',
    border: 'border-[#10A37F]/30',
  },
  // OpenAI Responses 紫（与 chat 同源但色相区分）
  'openai-responses': {
    hex: '#8B5CF6',
    text: 'text-[#8B5CF6]',
    bg: 'bg-[#8B5CF6]/20',
    border: 'border-[#8B5CF6]/30',
  },
};

/** 按 EndpointType 查询配色（带兜底） */
export function getProtocolColor(type: EndpointType): ProtocolColor {
  return PROTOCOL_COLOR_MAP[type] ?? PROTOCOL_COLOR_MAP['openai-chat'];
}
