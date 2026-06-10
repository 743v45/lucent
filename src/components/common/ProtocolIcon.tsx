/**
 * 协议品牌图标组件
 * 按 protocol.type 查找预设，lazy load @lobehub/icons Mono 图标
 * 颜色：按 EndpointType 应用 PROTOCOL_COLOR_MAP（两个 OpenAI 协议可区分）
 */

import React, { Suspense, lazy } from 'react';
import { getProtocolByType } from '../../constants/presets';
import { getProtocolColor } from '../../constants/protocol-colors';
import type { EndpointType } from '../../types';

// 每条都是静态字符串，Vite 可分析并 code-split
const ICON_LOADERS: Record<string, React.LazyExoticComponent<React.ComponentType<{ size?: number | string; className?: string; style?: React.CSSProperties }>>> = {
  OpenAI: lazy(() => import('@lobehub/icons/es/OpenAI/components/Mono')),
  Anthropic: lazy(() => import('@lobehub/icons/es/Anthropic/components/Mono')),
  Gemini: lazy(() => import('@lobehub/icons/es/Gemini/components/Mono')),
};

interface ProtocolIconProps {
  /** 端点类型 */
  type: EndpointType;
  size?: number;
  className?: string;
  /** 灰显（用于"未配置"或"被默认值覆盖"场景） */
  dimmed?: boolean;
  /** 关闭按协议自动着色，使用 currentColor */
  noColor?: boolean;
}

export function ProtocolIcon({ type, size = 12, className, dimmed, noColor }: ProtocolIconProps) {
  const preset = getProtocolByType(type);
  const LazyIcon = ICON_LOADERS[preset.iconKey];
  const cls = `${dimmed ? 'opacity-30' : ''} ${className ?? ''}`;
  const color = noColor ? undefined : getProtocolColor(type).hex;
  if (!LazyIcon) return null;
  return (
    <Suspense fallback={null}>
      <LazyIcon size={size} className={cls} style={color ? { color } : undefined} />
    </Suspense>
  );
}

