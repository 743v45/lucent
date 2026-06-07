/**
 * Agent 识别模块
 *
 * 用于识别请求中的 Agent 类型和子类型
 */

import { AgentType, SubAgentType } from './types.js';
import createDebug from 'debug';
const log = createDebug('agentproxy:agent-id');

export interface AgentIdentification {
  agentType: AgentType;
  subAgentType?: SubAgentType;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface ParsedRequest {
  model?: string;
  messages?: Array<{ role: string; content: string | unknown }>;
  tools?: Array<{ name: string; description?: string }>;
  system?: string;
  stream?: boolean;
}

/**
 * 识别 Agent 类型和子类型
 */
export function identifyAgent(body: unknown): AgentIdentification {
  if (!body || typeof body !== 'object') {
    return { agentType: 'sub', subAgentType: 'unknown' };
  }

  const request = body as ParsedRequest;

  // 主 Agent 识别：完整的 messages 数组且包含多轮对话
  if (Array.isArray(request.messages) && request.messages.length > 2) {
    const hasUserMessage = request.messages.some(m => m.role === 'user');
    const hasAssistantMessage = request.messages.some(m => m.role === 'assistant');

    if (hasUserMessage && hasAssistantMessage) {
      log('识别为主 Agent: messages=%d', request.messages.length);
      return { agentType: 'main' };
    }
  }

  // 辅 Agent 识别 - 通过分析特征识别子类型
  return identifySubAgent(request);
}

/**
 * 识别辅 Agent 子类型
 */
function identifySubAgent(request: ParsedRequest): AgentIdentification {
  const { messages, tools, system } = request;

  // 优先级1: 从 system prompt 识别
  const systemContent = typeof system === 'string' ? system : '';
  if (systemContent) {
    const subType = identifyFromSystemPrompt(systemContent);
    if (subType) {
      return { agentType: 'sub', subAgentType: subType };
    }
  }

  // 优先级2: 从第一个消息内容识别
  const firstMessage = messages?.[0];
  const firstContent = typeof firstMessage?.content === 'string' ? firstMessage.content : '';
  if (firstContent) {
    const subType = identifyFromContent(firstContent);
    if (subType) {
      return { agentType: 'sub', subAgentType: subType };
    }
  }

  // 优先级3: 从工具列表识别
  if (Array.isArray(tools) && tools.length > 0) {
    const subType = identifyFromTools(tools);
    if (subType) {
      return { agentType: 'sub', subAgentType: subType };
    }
  }

  // 默认：未知类型
  return { agentType: 'sub', subAgentType: 'unknown' };
}

/**
 * 从 system prompt 识别 Agent 类型
 */
function identifyFromSystemPrompt(system: string): SubAgentType | null {
  const lower = system.toLowerCase();

  // Plan Agent
  if (lower.includes('plan') && (lower.includes('strategy') || lower.includes('architecture'))) {
    return 'plan';
  }

  // Search Agent
  if (lower.includes('search') || lower.includes('find') || lower.includes('browse')) {
    return 'search';
  }

  // Bash Agent
  if (lower.includes('bash') || lower.includes('command') || lower.includes('execute')) {
    return 'bash';
  }

  // Workflow Agent
  if (lower.includes('workflow') || lower.includes('orchestrat') || lower.includes('pipeline')) {
    return 'workflow';
  }

  return null;
}

/**
 * 从消息内容识别 Agent 类型
 */
function identifyFromContent(content: string): SubAgentType | null {
  const lower = content.toLowerCase();

  // Plan Agent - 关键词识别
  if (lower.includes('create a plan') ||
      lower.includes('develop a strategy') ||
      lower.includes('design approach') ||
      lower.includes('implementation plan')) {
    return 'plan';
  }

  // Search Agent - 关键词识别
  if (lower.includes('search for') ||
      lower.includes('find information') ||
      lower.includes('look up') ||
      lower.includes('browse the web')) {
    return 'search';
  }

  // Bash Agent - 关键词识别
  if (lower.includes('run command') ||
      lower.includes('execute') ||
      lower.includes('terminal') ||
      lower.includes('shell command')) {
    return 'bash';
  }

  // Workflow Agent - 关键词识别
  if (lower.includes('workflow') ||
      lower.includes('orchestrate') ||
      lower.includes('coordinate agents') ||
      lower.includes('parallel execution')) {
    return 'workflow';
  }

  return null;
}

/**
 * 从工具列表识别 Agent 类型
 */
function identifyFromTools(tools: Array<{ name: string }>): SubAgentType | null {
  const toolNames = tools.map(t => t.name.toLowerCase());

  // Plan Agent - 设计和规划工具
  if (toolNames.some(name =>
    name.includes('plan') ||
    name.includes('design') ||
    name.includes('architect'))) {
    return 'plan';
  }

  // Search Agent - 搜索相关工具
  if (toolNames.some(name =>
    name.includes('search') ||
    name.includes('browse') ||
    name.includes('web'))) {
    return 'search';
  }

  // Bash Agent - 命令执行工具
  if (toolNames.some(name =>
    name.includes('bash') ||
    name.includes('command') ||
    name.includes('execute') ||
    name.includes('shell'))) {
    return 'bash';
  }

  // Workflow Agent - 编排和协调工具
  if (toolNames.some(name =>
    name.includes('workflow') ||
    name.includes('orchestrat') ||
    name.includes('pipeline') ||
    name.includes('parallel') ||
    name.includes('agent'))) {
    return 'workflow';
  }

  return null;
}

/**
 * 提取 Token 使用情况
 */
export function extractTokenUsage(responseBody: unknown): TokenUsage | undefined {
  if (!responseBody || typeof responseBody !== 'object') {
    return undefined;
  }

  const body = responseBody as Record<string, unknown>;
  const usage = body.usage as Record<string, unknown> | undefined;

  if (!usage) {
    return undefined;
  }

  const result = {
    inputTokens: typeof usage.input_tokens === 'number' ? usage.input_tokens : 0,
    outputTokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : 0,
    cacheReadTokens: typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : undefined,
    cacheWriteTokens: typeof usage.cache_creation_input_tokens === 'number' ? usage.cache_creation_input_tokens : undefined,
  };
  log('Token 使用: input=%d output=%d cacheRead=%d cacheWrite=%d', result.inputTokens, result.outputTokens, result.cacheReadTokens ?? 0, result.cacheWriteTokens ?? 0);
  return result;
}

/**
 * 计算 Token 百分比
 */
export function calculateTokenPercentage(input: number, output: number, cacheRead?: number): {
  inputPercent: number;
  outputPercent: number;
  cachePercent: number | undefined;
} {
  const total = input + output + (cacheRead || 0);

  if (total === 0) {
    return {
      inputPercent: 0,
      outputPercent: 0,
      cachePercent: undefined,
    };
  }

  return {
    inputPercent: Math.round((input / total) * 100),
    outputPercent: Math.round((output / total) * 100),
    cachePercent: cacheRead !== undefined ? Math.round((cacheRead / total) * 100) : undefined,
  };
}

/**
 * 识别服务提供商
 */
export function identifyProvider(url: string): 'openai' | 'claude' | 'unknown' {
  const lower = url.toLowerCase();

  if (lower.includes('openai') || lower.includes('api.openai.com')) {
    log('识别提供商: openai, url=%s', url);
    return 'openai';
  }

  if (lower.includes('anthropic') || lower.includes('claude')) {
    log('识别提供商: claude, url=%s', url);
    return 'claude';
  }

  return 'unknown';
}
