import type { EndpointType, ProviderPreset } from '../types';

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    name: 'anthropic',
    label: 'Anthropic',
    iconKey: 'Anthropic',
    category: 'official',
    endpoints: { 'openai-chat': null, 'openai-responses': null, 'anthropic-messages': 'https://api.anthropic.com' },
  },
  {
    name: 'openai',
    label: 'OpenAI',
    iconKey: 'OpenAI',
    category: 'official',
    endpoints: { 'openai-chat': 'https://api.openai.com/v1', 'openai-responses': 'https://api.openai.com/v1', 'anthropic-messages': null },
  },
  {
    name: 'gemini',
    label: 'Google Gemini',
    iconKey: 'Gemini',
    category: 'official',
    endpoints: { 'openai-chat': 'https://generativelanguage.googleapis.com/v1beta/openai', 'openai-responses': null, 'anthropic-messages': null },
  },
  {
    name: 'deepseek',
    label: 'DeepSeek',
    iconKey: 'DeepSeek',
    category: 'official',
    endpoints: { 'openai-chat': 'https://api.deepseek.com/v1', 'openai-responses': null, 'anthropic-messages': null },
  },
  {
    name: 'groq',
    label: 'Groq',
    iconKey: 'Groq',
    category: 'community',
    endpoints: { 'openai-chat': 'https://api.groq.com/openai/v1', 'openai-responses': null, 'anthropic-messages': null },
  },
  {
    name: 'mistral',
    label: 'Mistral',
    iconKey: 'Mistral',
    category: 'community',
    endpoints: { 'openai-chat': 'https://api.mistral.ai/v1', 'openai-responses': null, 'anthropic-messages': null },
  },
  {
    name: 'together',
    label: 'Together AI',
    iconKey: 'Together',
    category: 'community',
    endpoints: { 'openai-chat': 'https://api.together.xyz/v1', 'openai-responses': null, 'anthropic-messages': null },
  },
  {
    name: 'fireworks',
    label: 'Fireworks AI',
    iconKey: 'Fireworks',
    category: 'community',
    endpoints: { 'openai-chat': 'https://api.fireworks.ai/inference/v1', 'openai-responses': null, 'anthropic-messages': null },
  },
  {
    name: 'perplexity',
    label: 'Perplexity',
    iconKey: 'Perplexity',
    category: 'community',
    endpoints: { 'openai-chat': 'https://api.perplexity.ai', 'openai-responses': null, 'anthropic-messages': null },
  },
  {
    name: 'cohere',
    label: 'Cohere',
    iconKey: 'Cohere',
    category: 'community',
    endpoints: { 'openai-chat': 'https://api.cohere.com/v2', 'openai-responses': null, 'anthropic-messages': null },
  },
  {
    name: 'zhipu',
    label: '智谱 GLM',
    iconKey: 'Zhipu',
    category: 'official',
    endpoints: { 'openai-chat': 'https://open.bigmodel.cn/api/paas/v4', 'openai-responses': null, 'anthropic-messages': 'https://open.bigmodel.cn/api/anthropic' },
  },
  {
    name: 'moonshot',
    label: 'Moonshot',
    iconKey: 'Moonshot',
    category: 'official',
    endpoints: { 'openai-chat': 'https://api.moonshot.cn/v1', 'openai-responses': null, 'anthropic-messages': null },
  },
  {
    name: 'qwen',
    label: '通义千问',
    iconKey: 'Qwen',
    category: 'official',
    endpoints: { 'openai-chat': 'https://dashscope.aliyuncs.com/compatible-mode/v1', 'openai-responses': null, 'anthropic-messages': null },
  },
  {
    name: 'baichuan',
    label: '百川',
    iconKey: 'Baichuan',
    category: 'community',
    endpoints: { 'openai-chat': 'https://api.baichuan-ai.com/v1', 'openai-responses': null, 'anthropic-messages': null },
  },
  {
    name: 'minimax',
    label: 'Minimax',
    iconKey: 'Minimax',
    category: 'official',
    endpoints: { 'openai-chat': 'https://api.minimax.chat/v1', 'openai-responses': null, 'anthropic-messages': null },
  },
  {
    name: 'spark',
    label: '讯飞星火',
    iconKey: 'Spark',
    category: 'community',
    endpoints: { 'openai-chat': 'https://spark-api-open.xf-yun.com/v1', 'openai-responses': null, 'anthropic-messages': null },
  },
  {
    name: 'doubao',
    label: '豆包',
    iconKey: 'Doubao',
    category: 'community',
    endpoints: { 'openai-chat': 'https://ark.cn-beijing.volces.com/api/v3', 'openai-responses': null, 'anthropic-messages': null },
  },
  {
    name: 'stepfun',
    label: '阶跃星辰',
    iconKey: 'Stepfun',
    category: 'community',
    endpoints: { 'openai-chat': 'https://api.stepfun.com/v1', 'openai-responses': null, 'anthropic-messages': null },
  },
  {
    name: 'siliconcloud',
    label: 'SiliconCloud',
    iconKey: 'SiliconCloud',
    category: 'community',
    endpoints: { 'openai-chat': 'https://api.siliconflow.cn/v1', 'openai-responses': null, 'anthropic-messages': null },
  },
  {
    name: 'openrouter',
    label: 'OpenRouter',
    iconKey: 'OpenRouter',
    category: 'community',
    endpoints: { 'openai-chat': 'https://openrouter.ai/api/v1', 'openai-responses': 'https://openrouter.ai/api/v1', 'anthropic-messages': null },
  },
  {
    name: 'xai',
    label: 'xAI (Grok)',
    iconKey: 'XAI',
    category: 'community',
    endpoints: { 'openai-chat': 'https://api.x.ai/v1', 'openai-responses': null, 'anthropic-messages': null },
  },
  {
    name: 'cerebras',
    label: 'Cerebras',
    iconKey: 'Cerebras',
    category: 'community',
    endpoints: { 'openai-chat': 'https://api.cerebras.ai/v1', 'openai-responses': null, 'anthropic-messages': null },
  },
  {
    name: 'deepinfra',
    label: 'DeepInfra',
    iconKey: 'DeepInfra',
    category: 'community',
    endpoints: { 'openai-chat': 'https://api.deepinfra.com/v1', 'openai-responses': null, 'anthropic-messages': null },
  },
  {
    name: 'novita',
    label: 'Novita AI',
    iconKey: 'Novita',
    category: 'community',
    endpoints: { 'openai-chat': 'https://api.novita.ai/v3', 'openai-responses': null, 'anthropic-messages': null },
  },
  {
    name: 'sambanova',
    label: 'SambaNova',
    iconKey: 'SambaNova',
    category: 'community',
    endpoints: { 'openai-chat': 'https://api.sambanova.ai/v1', 'openai-responses': null, 'anthropic-messages': null },
  },
  {
    name: 'nvidia',
    label: 'Nvidia NIM',
    iconKey: 'Nvidia',
    category: 'community',
    endpoints: { 'openai-chat': 'https://integrate.api.nvidia.com/v1', 'openai-responses': null, 'anthropic-messages': null },
  },
];

export const PRESET_NAMES = new Set(PROVIDER_PRESETS.map(p => p.name));

export function getPresetByName(name: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find(p => p.name === name);
}

/** 按 provider 的 name 字段查找匹配的预设 */
export function getMatchingPreset(providerName: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find(p => p.name === providerName);
}

// ==================== 协议（端点类型）预设 ====================

/**
 * 协议预设：每个端点类型对应一个 iconKey + 显示名
 * iconKey 对应 @lobehub/icons/es/ 下的目录
 */
export interface ProtocolPreset {
  type: EndpointType;
  label: string;
  iconKey: 'OpenAI' | 'Anthropic' | 'Gemini';
}

export const PROTOCOL_PRESETS: ProtocolPreset[] = [
  { type: 'openai-chat', label: 'OpenAI Chat', iconKey: 'OpenAI' },
  { type: 'openai-responses', label: 'OpenAI Responses', iconKey: 'OpenAI' },
  { type: 'anthropic-messages', label: 'Anthropic Messages', iconKey: 'Anthropic' },
];

/** 按 EndpointType 查找协议预设 */
export function getProtocolByType(type: EndpointType): ProtocolPreset {
  // PROTOCOL_PRESETS 一定包含所有 EndpointType（按 type 严格相等兜底）
  return PROTOCOL_PRESETS.find(p => p.type === type) ?? { type, label: type, iconKey: 'OpenAI' };
}
