/**
 * 代理类型图标组件
 * 使用 @lobehub/icons Mono 图标（纯 SVG，无依赖问题）
 * 直接导入 components/Mono 避免 index 文件的 Avatar 依赖链
 */

import OpenAIMono from '@lobehub/icons/es/OpenAI/components/Mono';
import AnthropicMono from '@lobehub/icons/es/Anthropic/components/Mono';

type ApiProviderType = 'anthropic-messages' | 'openai-chat' | 'openai-responses';

interface ProviderIconProps {
  type: ApiProviderType;
  size?: number;
  className?: string;
}

// OpenAI 品牌颜色（用于区分不同协议）
const OPENAI_PLATFORM_COLOR = '#0000FE'; // Responses API 用 platform 蓝

export function ProviderIcon({ type, size = 14, className = '' }: ProviderIconProps) {
  switch (type) {
    case 'anthropic-messages':
      return <AnthropicMono size={size} className={className} />;
    case 'openai-chat':
      // Chat Completions: 使用标准 OpenAI 图标（继承父元素颜色）
      return <OpenAIMono size={size} className={className} />;
    case 'openai-responses':
      // Responses API: 使用 platform 蓝色区分
      return <OpenAIMono size={size} style={{ color: OPENAI_PLATFORM_COLOR }} className={className} />;
    default:
      return null;
  }
}