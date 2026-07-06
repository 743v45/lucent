/**
 * Agent 识别模块
 *
 * 主/子 Agent 判定：基于 system prompt 的身份指纹 + Claude Code billing header 标记，
 * 而非 messages 多轮性（主代理首请求也没有 assistant 历史，靠历史长度判定必然误判）。
 *
 * 判据移植自 cc-viewer 的 isMainAgentRequest，适配 lucent 多端点（OpenAI tools 在
 * function.name，Anthropic 在 tool.name；OpenAI 格式 system 在 messages 内 role=system）。
 */

import { AgentType, ClientType } from './types.js';
import createDebug from 'debug';
const log = createDebug('lucent:agent-id');

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens?: number;
  cache_creation_tokens?: number;
}

// ==================== 主/子 Agent 判定 ====================
//
// 三类「伪装成主代理的子代理」，须在正向判定前显式排除（均为 cc-viewer 实战踩坑积累）：
//   ① cc_is_subagent=true —— Claude Code 2.1.181+ 在 billing header 显式标注的子代理。
//      此类子代理继承完整 "You are Claude Code" prompt + Edit/Bash/Agent 工具，会误中正向判据。
//      结尾 \b 锚定：仅匹配 `=true`（其后为 `;`/空白/串尾），避免 `=truex` 之类误匹配。
//   ② specialist —— Claude Code 内置专用子代理（command execution / file search / planning 等）。
//      注：「general-purpose agent」必须锚定身份句式（you are a general-purpose agent），不能裸匹配——
//      Claude Code 主代理的 system 会枚举 Agent 工具可用类型，描述里含
//      「general-purpose: General-purpose agent for ...」，裸串会误伤主代理。
//   ③ teammate —— 同进程 Agent/Task 队友：system 注入团队协作标记但继承完整 "You are Claude Code"
//      prompt + 工具，且不带 --agent-name 进程参数。须排除，否则其 thinking 污染主回复 overlay。
const SUBAGENT_BILLING_RE = /cc_is_subagent=true\b/;
const SUBAGENT_SPECIALIST_RE = /(?:command execution|file search|planning) specialist|you are a general-purpose agent|security monitor|performing a web search/i;
const TEAMMATE_SYSTEM_RE = /running as an agent in a team|Agent Teammate Communication/i;

/** Claude Code 主代理身份声明（真·主代理恒定带此串，子代理身份声明不同）。 */
const MAIN_AGENT_IDENTITY = 'You are Claude Code';

/**
 * 从请求体提取 system prompt 全文。
 * 兼容三种端点协议：
 *  - Anthropic Messages：顶层 `system`（string 或 content block 数组）
 *  - OpenAI Chat：`messages` 内 role=system 的内容
 *  - OpenAI Responses：顶层 `instructions`
 */
function getSystemText(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  const b = body as Record<string, unknown>;

  // Anthropic：顶层 system
  const sys = b.system;
  if (typeof sys === 'string') return sys;
  if (Array.isArray(sys)) {
    return sys
      .map((s) => (s && typeof s === 'object' && typeof (s as { text?: unknown }).text === 'string'
        ? (s as { text: string }).text : ''))
      .join('');
  }

  // OpenAI Chat：messages 内 system
  const messages = b.messages;
  if (Array.isArray(messages)) {
    const parts: string[] = [];
    for (const m of messages) {
      if (!m || typeof m !== 'object') continue;
      if ((m as { role?: string }).role !== 'system') continue;
      const c = (m as { content?: unknown }).content;
      if (typeof c === 'string') {
        parts.push(c);
      } else if (Array.isArray(c)) {
        parts.push(
          c.map((b) => (b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string'
            ? (b as { text: string }).text : '')).join(''),
        );
      }
    }
    if (parts.length) return parts.join('');
  }

  // OpenAI Responses：instructions
  if (typeof b.instructions === 'string') return b.instructions;

  return '';
}

/**
 * 判定请求是主 Agent 还是子 Agent。
 *
 * 决策顺序：
 *  1. 权威排除：明确标记为子代理（cc_is_subagent / teammate / specialist）→ sub
 *  2. Claude Code 主代理：system 含 "You are Claude Code"（且无 ① 标记）→ main
 *  3. 兜底：无任何已知身份/标记 → main（非 Claude Code 的第三方请求先按主代理处理，
 *     以后再细分）。子代理必须靠 ① 的明确标记命中，绝不靠「没有标记」推断为 sub。
 */
export function classifyAgent(body: unknown): AgentType {
  const sysText = getSystemText(body);

  // ① 权威排除：明确标记为子代理的，绝不升为主代理。
  if (SUBAGENT_BILLING_RE.test(sysText)) {
    log('识别为子 Agent（cc_is_subagent 标记）');
    return 'sub';
  }
  if (TEAMMATE_SYSTEM_RE.test(sysText)) {
    log('识别为子 Agent（teammate 标记）');
    return 'sub';
  }

  // ② Claude Code 主代理：真·主代理恒带此身份声明（主代理首请求也能命中）。
  //    specialist 子代理虽有 "You are Claude Code" 前缀但带专用角色短语 → 排除。
  if (sysText.includes(MAIN_AGENT_IDENTITY)) {
    if (SUBAGENT_SPECIALIST_RE.test(sysText)) {
      log('识别为子 Agent（specialist）');
      return 'sub';
    }
    log('识别为主 Agent（You are Claude Code）');
    return 'main';
  }

  // ③ 兜底：无 Claude Code 身份声明、无子代理标记（含非 CC 第三方请求、无 system 请求）→ main。
  log('识别为主 Agent（兜底：无已知身份标记，按主代理处理）');
  return 'main';
}

// ==================== Token 提取 ====================
export function extractTokenUsage(responseBody: unknown): TokenUsage | undefined {
  if (!responseBody || typeof responseBody !== 'object') {
    return undefined;
  }

  const body = responseBody as Record<string, unknown>;
  const usage = body.usage as Record<string, unknown> | undefined;

  if (!usage) {
    return undefined;
  }

  // 兼容两套字段：
  // - Anthropic: usage.input_tokens / usage.output_tokens
  // - OpenAI 非流式: usage.prompt_tokens / usage.completion_tokens
  const inputTokens = typeof usage.input_tokens === 'number'
    ? usage.input_tokens
    : (typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : 0);
  const outputTokens = typeof usage.output_tokens === 'number'
    ? usage.output_tokens
    : (typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0);

  // cache 读：Anthropic 的 cache_read_input_tokens / cache_creation_input_tokens，
  // 兼容 OpenAI 的 prompt_tokens_details.cached_tokens。
  const promptTokensDetails = usage.prompt_tokens_details as Record<string, unknown> | undefined;
  const cachedTokens = typeof promptTokensDetails?.cached_tokens === 'number'
    ? promptTokensDetails.cached_tokens
    : undefined;

  const result = {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_read_tokens: typeof usage.cache_read_input_tokens === 'number'
      ? usage.cache_read_input_tokens
      : cachedTokens,
    cache_creation_tokens: typeof usage.cache_creation_input_tokens === 'number' ? usage.cache_creation_input_tokens : undefined,
  };
  log('Token 使用: input=%d output=%d cacheRead=%d cacheCreate=%d', result.input_tokens, result.output_tokens, result.cache_read_tokens ?? 0, result.cache_creation_tokens ?? 0);
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

// ==================== 客户端识别 ====================

/**
 * 从请求 headers 识别客户端应用
 *
 * 各客户端 User-Agent 特征：
 * - Claude Code CLI: 包含 "claude-code" 或 "claude-cli"
 * - OpenCode: 包含 "opencode"
 * - Codex CLI: 包含 "codex"
 * - Cursor: 包含 "cursor"
 * - Windsurf: 包含 "windsurf"
 * - 测试客户端: 包含 "test-client" 或 "lucent-test"
 */
export function identifyClient(headers: Record<string, string>): ClientType {
  const ua = (headers['user-agent'] || '').toLowerCase();
  const originator = (headers['originator'] || '').toLowerCase();

  // OpenCode 会发送 originator header
  if (originator.includes('opencode') || ua.includes('opencode')) {
    return 'opencode';
  }

  // Claude Code CLI
  if (ua.includes('claude-code') || ua.includes('claude-cli') || ua.includes('claude')) {
    return 'claude-code';
  }

  // Codex CLI
  if (ua.includes('codex')) {
    return 'codex';
  }

  // Cursor
  if (ua.includes('cursor')) {
    return 'cursor';
  }

  // Windsurf
  if (ua.includes('windsurf')) {
    return 'windsurf';
  }

  // Test Client
  if (ua.includes('test-client') || ua.includes('lucent-test')) {
    return 'test-client';
  }

  return 'unknown';
}
