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

interface ClientIconProps {
  clientType?: ClientType;
  size?: number;
  className?: string;
}

/** 客户端品牌主色（用于 Mono 图标着色） */
const CLIENT_COLORS: Partial<Record<ClientType, string>> = {
  opencode: '#10B981',    // emerald-500
  cursor: '#A855F7',      // purple-500
  windsurf: '#06B6D4',    // cyan-500
  'test-client': '#F59E0B', // amber-500
};

export function ClientIcon({ clientType, size = 14, className = '' }: ClientIconProps) {
  if (!clientType || clientType === 'unknown') return null;

  switch (clientType) {
    case 'claude-code':
      return <ClaudeCodeColor size={size} className={className} />;
    case 'codex':
      return <CodexColor size={size} className={className} />;
    case 'opencode':
      return <OpenCodeMono size={size} style={{ color: CLIENT_COLORS.opencode }} className={className} />;
    case 'cursor':
    case 'windsurf':
    case 'test-client':
      // 无 LobeHub 图标的客户端：用 Mono 兜底色圆点
      return (
        <span
          className={`inline-block rounded-full ${className}`}
          style={{
            width: size,
            height: size,
            backgroundColor: CLIENT_COLORS[clientType] ?? '#9CA3AF',
          }}
        />
      );
    default:
      return null;
  }
}
