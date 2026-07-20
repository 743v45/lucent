/**
 * DetailPanel 详情面板的纯工具函数（跨 tab 共用，无 React 依赖）。
 * 从原 DetailPanel.tsx 拆出（#19 巨石拆分），行为零变更。
 *
 * 汇集：
 * - localStorage 展开态读写（readExpandedPair）
 * - token 数值格式化（formatTokenValue）
 * - 命中率配色纯函数（hitRateColorClass，InlineTokenStats + KVCacheTab 共用，去重 low#8）
 * - token 使用情况解析（resolveTokenUsage，SSE / JSON / tokenUsage 三路归一）
 * - SSE 原始文本重建（sseLinesToRawText）
 * - 安全剪贴板复制（copyText，带回退，low#9）
 */
import type { LogEntry, SSERawBody, SSERawLine } from '../../../types';
import {
  TOKEN_FORMAT_THRESHOLD_MILLION,
  TOKEN_FORMAT_THRESHOLD_KILO,
  CACHE_HIT_RATE_GOOD_THRESHOLD,
  CACHE_HIT_RATE_BAD_THRESHOLD,
} from '../../../constants';
import { extractFromSSELines } from '../../../utils/sse-extractor';

// ==================== localStorage 展开态读写 ====================

// 从 localStorage 读 { request, response } 布尔对，格式不对或缺省一律回 false（折叠）。
// 详情面板的 Body 全展开 / Headers 折叠态都走这个套路记忆，切日志不再重置。
export function readExpandedPair(key: string): { request: boolean; response: boolean } {
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object'
        && typeof parsed.request === 'boolean'
        && typeof parsed.response === 'boolean') {
        return { request: parsed.request, response: parsed.response };
      }
    }
  } catch {
    // 损坏 / 禁用 localStorage：回退默认折叠
  }
  return { request: false, response: false };
}

// ==================== Token 数值格式化 ====================

export function formatTokenValue(n: number | undefined): string {
  if (n == null) return '0';
  if (n >= TOKEN_FORMAT_THRESHOLD_MILLION) return `${(n / TOKEN_FORMAT_THRESHOLD_MILLION).toFixed(1)}M`;
  if (n >= TOKEN_FORMAT_THRESHOLD_KILO) return `${(n / TOKEN_FORMAT_THRESHOLD_KILO).toFixed(1)}K`;
  return String(n);
}

// ==================== 命中率配色（InlineTokenStats + KVCacheTab 共用，low#8 去重） ====================

// 命中率配色：>70 绿 / 30-70 黄 / <30 红 / 无值灰。
// 抽成纯函数统一 InlineTokenStats 与 KVCacheTab 两处原本重复的阈值分支。
export function hitRateColorClass(hr: number, hasValue: boolean): string {
  if (!hasValue) return 'text-text-quaternary';
  if (hr > CACHE_HIT_RATE_GOOD_THRESHOLD) return 'text-success';
  if (hr > CACHE_HIT_RATE_BAD_THRESHOLD) return 'text-warning';
  return 'text-error';
}

// ==================== Token 使用情况解析 ====================

/**
 * 从日志的响应体中提取 token 使用情况（前端 fallback）
 * 覆盖三种情况：tokenUsage 已有、非流式 JSON 响应、SSE 流式响应
 */
export function resolveTokenUsage(log: LogEntry) {
  const body = log.response?.body;

  // 1. SSE 流式响应：从 SSE 原始行实时提取（source of truth）
  if (body && typeof body === 'object' && (body as SSERawBody).type === 'sse_raw') {
    const lines = (body as SSERawBody).lines;
    if (lines?.length) {
      const extracted = extractFromSSELines(lines);
      if (extracted.usage.input > 0 || extracted.usage.output > 0) {
        return {
          input_tokens: extracted.usage.input,
          output_tokens: extracted.usage.output,
          cache_creation_tokens: extracted.usage.cache_create || undefined,
          cache_read_tokens: extracted.usage.cache_read || undefined,
        };
      }
    }
  }

  // 2. 非流式 JSON 响应：从 response.body.usage 提取（Anthropic 字段名）
  // 注：保留原 (body as any) 读法——usage 字段名跨协议不一且结构松散，强类型化会让
  // resolveTokenUsage 返回类型掺入 unknown，破坏下游（formatTokenValue 等）。行为零变更。
  if (body && typeof body === 'object' && body.type !== 'sse_raw') {
    const usage = (body as { usage?: Record<string, unknown> }).usage;
    if (usage && typeof usage === 'object') {
      return {
        input_tokens: (usage.input_tokens as number | undefined) ?? 0,
        output_tokens: (usage.output_tokens as number | undefined) ?? 0,
        cache_creation_tokens: usage.cache_creation_input_tokens as number | undefined,
        cache_read_tokens: usage.cache_read_input_tokens as number | undefined,
      };
    }
  }

  // 3. 回退：服务端已映射好的 tokenUsage
  if (log.tokenUsage?.input_tokens || log.tokenUsage?.output_tokens) {
    return log.tokenUsage;
  }

  return undefined;
}

// resolveTokenUsage 的返回类型：SSE / JSON / tokenUsage 三路归一的结果（可能 undefined）。
export type TokenUsage = ReturnType<typeof resolveTokenUsage>;

// ==================== SSE 原始文本重建 ====================

/**
 * 将原始 SSE lines 重建为实际的 SSE 文本流格式
 * 输出格式：event: xxx\ndata: {...}\n\n
 */
export function sseLinesToRawText(lines: SSERawLine[]): string {
  return lines.map(line => {
    const parts: string[] = [];
    if (line.event) {
      parts.push(`event: ${line.event}`);
    }
    parts.push(`data: ${line.data}`);
    return parts.join('\n');
  }).join('\n\n');
}

// ==================== Clipboard（带回退的安全复制，low#9） ====================

/**
 * 安全复制文本到剪贴板：
 * 1) 优先 navigator.clipboard.writeText（安全上下文）；
 * 2) 失败 / 不可用（非安全上下文 HTTP、权限拒绝）回退 document.execCommand('copy')；
 * 3) 全部失败返回 false，调用方据实反馈，不产生 unhandled rejection。
 *
 * 注：下方 textarea 的 position/opacity 是 execCommand 剪贴板回退机制必需的 DOM 定位
 * （让 textarea 可被选中又不闪烁），属于 DOM 工具代码，非组件 UI 样式。
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 非安全上下文 / 权限拒绝：走 execCommand 回退
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    // 剪贴板回退机制：让临时 textarea 可选中且不可见
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
