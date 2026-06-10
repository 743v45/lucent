/**
 * 供应商品牌图标组件
 * 按 providerName 查找预设，lazy load @lobehub/icons
 *
 * - avatar=false（默认）：Mono 单色图标
 * - avatar=true：Avatar 带官方配色的圆形图标（用于选择面板、卡片等）
 */

import React, { Suspense, lazy } from 'react';
import { getMatchingPreset } from '../../constants/presets';

// ==================== 静态图标加载器 ====================
// 每条都是静态字符串，Vite 可分析并 code-split

type MonoComp = React.LazyExoticComponent<React.ComponentType<{ size?: number | string; className?: string; style?: React.CSSProperties }>>;
type AvatarComp = React.LazyExoticComponent<React.ComponentType<{ size: number; shape?: 'circle' | 'square'; background?: string }>>;

const MONO_LOADERS: Record<string, MonoComp> = {
  Anthropic: lazy(() => import('@lobehub/icons/es/Anthropic/components/Mono')),
  OpenAI: lazy(() => import('@lobehub/icons/es/OpenAI/components/Mono')),
  Gemini: lazy(() => import('@lobehub/icons/es/Gemini/components/Mono')),
  DeepSeek: lazy(() => import('@lobehub/icons/es/DeepSeek/components/Mono')),
  Groq: lazy(() => import('@lobehub/icons/es/Groq/components/Mono')),
  Mistral: lazy(() => import('@lobehub/icons/es/Mistral/components/Mono')),
  Together: lazy(() => import('@lobehub/icons/es/Together/components/Mono')),
  Fireworks: lazy(() => import('@lobehub/icons/es/Fireworks/components/Mono')),
  Perplexity: lazy(() => import('@lobehub/icons/es/Perplexity/components/Mono')),
  Cohere: lazy(() => import('@lobehub/icons/es/Cohere/components/Mono')),
  Zhipu: lazy(() => import('@lobehub/icons/es/Zhipu/components/Mono')),
  Moonshot: lazy(() => import('@lobehub/icons/es/Moonshot/components/Mono')),
  Qwen: lazy(() => import('@lobehub/icons/es/Qwen/components/Mono')),
  Baichuan: lazy(() => import('@lobehub/icons/es/Baichuan/components/Mono')),
  Minimax: lazy(() => import('@lobehub/icons/es/Minimax/components/Mono')),
  Spark: lazy(() => import('@lobehub/icons/es/Spark/components/Mono')),
  Doubao: lazy(() => import('@lobehub/icons/es/Doubao/components/Mono')),
  Stepfun: lazy(() => import('@lobehub/icons/es/Stepfun/components/Mono')),
  SiliconCloud: lazy(() => import('@lobehub/icons/es/SiliconCloud/components/Mono')),
  OpenRouter: lazy(() => import('@lobehub/icons/es/OpenRouter/components/Mono')),
  XAI: lazy(() => import('@lobehub/icons/es/XAI/components/Mono')),
  Cerebras: lazy(() => import('@lobehub/icons/es/Cerebras/components/Mono')),
  DeepInfra: lazy(() => import('@lobehub/icons/es/DeepInfra/components/Mono')),
  Novita: lazy(() => import('@lobehub/icons/es/Novita/components/Mono')),
  SambaNova: lazy(() => import('@lobehub/icons/es/SambaNova/components/Mono')),
  Nvidia: lazy(() => import('@lobehub/icons/es/Nvidia/components/Mono')),
};

const AVATAR_LOADERS: Record<string, AvatarComp> = {
  Anthropic: lazy(() => import('@lobehub/icons/es/Anthropic/components/Avatar')),
  OpenAI: lazy(() => import('@lobehub/icons/es/OpenAI/components/Avatar')),
  Gemini: lazy(() => import('@lobehub/icons/es/Gemini/components/Avatar')),
  DeepSeek: lazy(() => import('@lobehub/icons/es/DeepSeek/components/Avatar')),
  Groq: lazy(() => import('@lobehub/icons/es/Groq/components/Avatar')),
  Mistral: lazy(() => import('@lobehub/icons/es/Mistral/components/Avatar')),
  Together: lazy(() => import('@lobehub/icons/es/Together/components/Avatar')),
  Fireworks: lazy(() => import('@lobehub/icons/es/Fireworks/components/Avatar')),
  Perplexity: lazy(() => import('@lobehub/icons/es/Perplexity/components/Avatar')),
  Cohere: lazy(() => import('@lobehub/icons/es/Cohere/components/Avatar')),
  Zhipu: lazy(() => import('@lobehub/icons/es/Zhipu/components/Avatar')),
  Moonshot: lazy(() => import('@lobehub/icons/es/Moonshot/components/Avatar')),
  Qwen: lazy(() => import('@lobehub/icons/es/Qwen/components/Avatar')),
  Baichuan: lazy(() => import('@lobehub/icons/es/Baichuan/components/Avatar')),
  Minimax: lazy(() => import('@lobehub/icons/es/Minimax/components/Avatar')),
  Spark: lazy(() => import('@lobehub/icons/es/Spark/components/Avatar')),
  Doubao: lazy(() => import('@lobehub/icons/es/Doubao/components/Avatar')),
  Stepfun: lazy(() => import('@lobehub/icons/es/Stepfun/components/Avatar')),
  SiliconCloud: lazy(() => import('@lobehub/icons/es/SiliconCloud/components/Avatar')),
  OpenRouter: lazy(() => import('@lobehub/icons/es/OpenRouter/components/Avatar')),
  XAI: lazy(() => import('@lobehub/icons/es/XAI/components/Avatar')),
  Cerebras: lazy(() => import('@lobehub/icons/es/Cerebras/components/Avatar')),
  DeepInfra: lazy(() => import('@lobehub/icons/es/DeepInfra/components/Avatar')),
  Novita: lazy(() => import('@lobehub/icons/es/Novita/components/Avatar')),
  SambaNova: lazy(() => import('@lobehub/icons/es/SambaNova/components/Avatar')),
  Nvidia: lazy(() => import('@lobehub/icons/es/Nvidia/components/Avatar')),
};

// ==================== Fallback ====================

/** fallback：首字母圆形 */
function FallbackAvatar({ name, size, className }: { name: string; size: number; className?: string }) {
  const letter = name.charAt(0).toUpperCase();
  return (
    <span
      className={`inline-flex items-center justify-center rounded-full text-xs font-medium text-white ${className ?? ''}`}
      style={{ width: size, height: size, backgroundColor: '#6B7280' }}
    >
      {letter}
    </span>
  );
}

// ==================== 组件 ====================

interface ProviderIconProps {
  providerName: string;
  size?: number;
  className?: string;
  /** 使用带官方配色的 Avatar 图标（圆形彩色），用于选择面板、卡片 */
  avatar?: boolean;
}

export function ProviderIcon({ providerName, size = 14, className, avatar }: ProviderIconProps) {
  const preset = getMatchingPreset(providerName);

  if (!preset) {
    return <FallbackAvatar name={providerName} size={size} className={className} />;
  }

  if (avatar) {
    const LazyAvatar = AVATAR_LOADERS[preset.iconKey];
    if (!LazyAvatar) return <FallbackAvatar name={providerName} size={size} className={className} />;
    return (
      <Suspense fallback={<FallbackAvatar name={providerName} size={size} className={className} />}>
        <LazyAvatar size={size} shape="circle" />
      </Suspense>
    );
  }

  const LazyIcon = MONO_LOADERS[preset.iconKey];
  if (!LazyIcon) {
    return <FallbackAvatar name={providerName} size={size} className={className} />;
  }

  return (
    <Suspense fallback={<FallbackAvatar name={providerName} size={size} className={className} />}>
      <LazyIcon size={size} className={className} />
    </Suspense>
  );
}
