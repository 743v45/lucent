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

/**
 * 单一品牌图标表（修复 Bug #34：原 MONO_LOADERS / AVATAR_LOADERS 两份各 26 条 lazy 表）。
 *
 * 每个品牌一条，mono + avatar 共址 —— 新增/移除品牌只改这一处，不再两表同步。
 * 仍保留各 brand 显式的静态 import() 字符串字面量，Vite 可静态分析做 code-split。
 */
const ICON_LOADERS: Record<string, { mono: MonoComp; avatar: AvatarComp }> = {
  Anthropic: {
    mono: lazy(() => import('@lobehub/icons/es/Anthropic/components/Mono')),
    avatar: lazy(() => import('@lobehub/icons/es/Anthropic/components/Avatar')),
  },
  OpenAI: {
    mono: lazy(() => import('@lobehub/icons/es/OpenAI/components/Mono')),
    avatar: lazy(() => import('@lobehub/icons/es/OpenAI/components/Avatar')),
  },
  Gemini: {
    mono: lazy(() => import('@lobehub/icons/es/Gemini/components/Mono')),
    avatar: lazy(() => import('@lobehub/icons/es/Gemini/components/Avatar')),
  },
  DeepSeek: {
    mono: lazy(() => import('@lobehub/icons/es/DeepSeek/components/Mono')),
    avatar: lazy(() => import('@lobehub/icons/es/DeepSeek/components/Avatar')),
  },
  Groq: {
    mono: lazy(() => import('@lobehub/icons/es/Groq/components/Mono')),
    avatar: lazy(() => import('@lobehub/icons/es/Groq/components/Avatar')),
  },
  Mistral: {
    mono: lazy(() => import('@lobehub/icons/es/Mistral/components/Mono')),
    avatar: lazy(() => import('@lobehub/icons/es/Mistral/components/Avatar')),
  },
  Together: {
    mono: lazy(() => import('@lobehub/icons/es/Together/components/Mono')),
    avatar: lazy(() => import('@lobehub/icons/es/Together/components/Avatar')),
  },
  Fireworks: {
    mono: lazy(() => import('@lobehub/icons/es/Fireworks/components/Mono')),
    avatar: lazy(() => import('@lobehub/icons/es/Fireworks/components/Avatar')),
  },
  Perplexity: {
    mono: lazy(() => import('@lobehub/icons/es/Perplexity/components/Mono')),
    avatar: lazy(() => import('@lobehub/icons/es/Perplexity/components/Avatar')),
  },
  Cohere: {
    mono: lazy(() => import('@lobehub/icons/es/Cohere/components/Mono')),
    avatar: lazy(() => import('@lobehub/icons/es/Cohere/components/Avatar')),
  },
  Zhipu: {
    mono: lazy(() => import('@lobehub/icons/es/Zhipu/components/Mono')),
    avatar: lazy(() => import('@lobehub/icons/es/Zhipu/components/Avatar')),
  },
  Moonshot: {
    mono: lazy(() => import('@lobehub/icons/es/Moonshot/components/Mono')),
    avatar: lazy(() => import('@lobehub/icons/es/Moonshot/components/Avatar')),
  },
  Qwen: {
    mono: lazy(() => import('@lobehub/icons/es/Qwen/components/Mono')),
    avatar: lazy(() => import('@lobehub/icons/es/Qwen/components/Avatar')),
  },
  Baichuan: {
    mono: lazy(() => import('@lobehub/icons/es/Baichuan/components/Mono')),
    avatar: lazy(() => import('@lobehub/icons/es/Baichuan/components/Avatar')),
  },
  Minimax: {
    mono: lazy(() => import('@lobehub/icons/es/Minimax/components/Mono')),
    avatar: lazy(() => import('@lobehub/icons/es/Minimax/components/Avatar')),
  },
  Spark: {
    mono: lazy(() => import('@lobehub/icons/es/Spark/components/Mono')),
    avatar: lazy(() => import('@lobehub/icons/es/Spark/components/Avatar')),
  },
  Doubao: {
    mono: lazy(() => import('@lobehub/icons/es/Doubao/components/Mono')),
    avatar: lazy(() => import('@lobehub/icons/es/Doubao/components/Avatar')),
  },
  Stepfun: {
    mono: lazy(() => import('@lobehub/icons/es/Stepfun/components/Mono')),
    avatar: lazy(() => import('@lobehub/icons/es/Stepfun/components/Avatar')),
  },
  SiliconCloud: {
    mono: lazy(() => import('@lobehub/icons/es/SiliconCloud/components/Mono')),
    avatar: lazy(() => import('@lobehub/icons/es/SiliconCloud/components/Avatar')),
  },
  OpenRouter: {
    mono: lazy(() => import('@lobehub/icons/es/OpenRouter/components/Mono')),
    avatar: lazy(() => import('@lobehub/icons/es/OpenRouter/components/Avatar')),
  },
  XAI: {
    mono: lazy(() => import('@lobehub/icons/es/XAI/components/Mono')),
    avatar: lazy(() => import('@lobehub/icons/es/XAI/components/Avatar')),
  },
  Cerebras: {
    mono: lazy(() => import('@lobehub/icons/es/Cerebras/components/Mono')),
    avatar: lazy(() => import('@lobehub/icons/es/Cerebras/components/Avatar')),
  },
  DeepInfra: {
    mono: lazy(() => import('@lobehub/icons/es/DeepInfra/components/Mono')),
    avatar: lazy(() => import('@lobehub/icons/es/DeepInfra/components/Avatar')),
  },
  Novita: {
    mono: lazy(() => import('@lobehub/icons/es/Novita/components/Mono')),
    avatar: lazy(() => import('@lobehub/icons/es/Novita/components/Avatar')),
  },
  SambaNova: {
    mono: lazy(() => import('@lobehub/icons/es/SambaNova/components/Mono')),
    avatar: lazy(() => import('@lobehub/icons/es/SambaNova/components/Avatar')),
  },
  Nvidia: {
    mono: lazy(() => import('@lobehub/icons/es/Nvidia/components/Mono')),
    avatar: lazy(() => import('@lobehub/icons/es/Nvidia/components/Avatar')),
  },
};

/** 所有已接入的品牌图标 key（用于单测断言与预设覆盖校验） */
export const ICON_KEYS: readonly string[] = Object.keys(ICON_LOADERS);

// ==================== Fallback ====================

/** fallback：首字母圆形 */
function FallbackAvatar({ name, size, className }: { name: string; size: number; className?: string }) {
  const letter = name.charAt(0).toUpperCase();
  return (
    <span
      className={`inline-flex items-center justify-center rounded-full text-xs font-medium text-white bg-gray-500 ${className ?? ''}`}
      style={{ width: size, height: size }}
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
    const LazyAvatar = ICON_LOADERS[preset.iconKey]?.avatar;
    if (!LazyAvatar) return <FallbackAvatar name={providerName} size={size} className={className} />;
    return (
      <Suspense fallback={<FallbackAvatar name={providerName} size={size} className={className} />}>
        <LazyAvatar size={size} shape="circle" />
      </Suspense>
    );
  }

  const LazyIcon = ICON_LOADERS[preset.iconKey]?.mono;
  if (!LazyIcon) {
    return <FallbackAvatar name={providerName} size={size} className={className} />;
  }

  return (
    <Suspense fallback={<FallbackAvatar name={providerName} size={size} className={className} />}>
      <LazyIcon size={size} className={className} />
    </Suspense>
  );
}
