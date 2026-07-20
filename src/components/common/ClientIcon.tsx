/**
 * 客户端类型图标组件
 * 使用 @lobehub/icons 品牌图标（直接导入 Mono/Color 避免 index 依赖链）
 *
 * 识别来源：服务端通过 User-Agent / originator header 识别
 */

import type { ClientType } from '../../types';
import ClaudeCodeColor from '@lobehub/icons/es/ClaudeCode/components/Color';
import CodexColor from '@lobehub/icons/es/Codex/components/Color';
import OpenCodeMono from '@lobehub/icons/es/OpenCode/components/Mono';
// ZCode 无 @lobehub/icons 图标，用官方 SVG 资产（深色圆角方块 + 白色 Z，自带配色）
import zcodeIconUrl from '../../assets/icons/zcode.svg';

interface ClientIconProps {
  clientType?: ClientType;
  size?: number;
  className?: string;
}

/**
 * 客户端品牌配色（Tailwind className，修复 Bug #32 内联 style 违规）
 * - opencode：text-* 给 Mono 图标着色（SVG 用 currentColor）
 * - cursor/windsurf/test-client：bg-* 给兜底圆点背景
 */
const CLIENT_COLORS: Partial<Record<ClientType, string>> = {
  opencode: 'text-emerald-500',     // emerald-500
  cursor: 'bg-purple-500',          // purple-500
  windsurf: 'bg-cyan-500',          // cyan-500
  'test-client': 'bg-amber-500',    // amber-500
};

export function ClientIcon({ clientType, size = 14, className = '' }: ClientIconProps) {
  if (!clientType || clientType === 'unknown') return null;

  switch (clientType) {
    case 'claude-code':
      return <ClaudeCodeColor size={size} className={className} />;
    case 'codex':
      return <CodexColor size={size} className={className} />;
    case 'opencode':
      return <OpenCodeMono size={size} className={`${CLIENT_COLORS.opencode} ${className}`} />;
    case 'zcode':
      // 官方 SVG 自带深色方块 + 白 Z 配色，明暗背景均可读；object-contain 保持比例
      return (
        <img
          src={zcodeIconUrl}
          alt="ZCode"
          width={size}
          height={size}
          className={`inline-block object-contain ${className}`}
          style={{ width: size, height: size }}
        />
      );
    case 'cursor':
    case 'windsurf':
    case 'test-client':
      // 无 LobeHub 图标的客户端：用 Mono 兜底色圆点
      return (
        <span
          className={`inline-block rounded-full ${CLIENT_COLORS[clientType] ?? 'bg-gray-400'} ${className}`}
          style={{ width: size, height: size }}
        />
      );
    default:
      return null;
  }
}
