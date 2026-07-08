/**
 * SSE 流提取器
 *
 * 从 Anthropic / OpenAI SSE 流中：
 * - 收集原始 SSE 行数据（存储）
 * - 导出提取函数（展示时调用）
 *
 * 从 interceptor.ts 提取而来
 */

import { EventSourceParserStream } from 'eventsource-parser/stream';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RawLogEntry, SSERawLine } from './types.js';
import createDebug from 'debug';
const dbgSse = createDebug('lucent:interceptor:sse');

// ==================== SSE 提取函数（from shared 单源） ====================
// extractFromEvent / extractFromSSELines / extractedToResponseBody 统一在
// shared/sse-events.ts，前后端共用，避免两份逻辑漂移。
import { extractFromSSELines, classifySSEEventTokenBucket } from '../shared/sse-events.js';
export {
  extractFromEvent,
  extractFromSSELines,
  extractedToResponseBody,
} from '../shared/sse-events.js';
export type { ExtractedInfo, SSERawLine as SharedSSERawLine, ContentBlock } from '../shared/sse-events.js';

// ==================== SSE Debug 开关 ====================

const SSE_DEBUG_DIR = '/tmp/lucent-sse-debug';
let sseDebugEnabled = !!process.env.LUCENT_SSE_DEBUG;

export function setSseDebugEnabled(enabled: boolean): void {
  sseDebugEnabled = enabled;
}

export function isSseDebugEnabled(): boolean {
  return sseDebugEnabled;
}

function dumpSseDebug(entry: RawLogEntry, lines: SSERawLine[]): void {
  if (!isSseDebugEnabled()) return;

  mkdirSync(SSE_DEBUG_DIR, { recursive: true });

  const filename = `${new Date().toISOString().replace(/[:.]/g, '-')}_${entry.id}.sse`;
  const filePath = join(SSE_DEBUG_DIR, filename);

  const content = lines.map(l => {
    if (l.event) return `event: ${l.event}\ndata: ${l.data}\n`;
    return `data: ${l.data}\n`;
  }).join('\n');

  writeFileSync(filePath, content, 'utf-8');
  console.log(`[Lucent SSE Debug] id=${entry.id} ${entry.method} ${entry.url} → ${filePath} (${lines.length} events)`);
}

// ==================== 后台收集原始 SSE 行 ====================

/** SSE 后台收集超时时间（毫秒）
 * 3 分钟：覆盖 LLM 长输出 / thinking 流的常见时长。
 * 这是日志收集副链路（tee 出的副本）的超时，不影响主链路对客户端的透传。
 * 超时后写入已收集的部分数据并标记 truncated=true。 */
const SSE_COLLECT_TIMEOUT_MS = 180_000; // 3 分钟

/** SSE 原始行累计字节上限（防止超长流导致 OOM） */
const SSE_COLLECT_MAX_BYTES = 2 * 1024 * 1024; // 2MB

/**
 * 后台收集 SSE 原始行数据（不阻塞客户端响应）
 * 存储原始数据，展示时再调用 extractFromSSELines 提取
 *
 * 带超时保护：如果上游在 SSE_COLLECT_TIMEOUT_MS 内未关闭流，
 * 写入已收集的部分数据并标记 truncated=true
 */
/**
 * 用首 token 时刻 + reqStartMs 派生 TTFT 字段、终结流式 duration、算 tokens/s，写到 entry 上。
 * 在写日志（onLogEntry）前调用。
 */
function finalizeStreamTiming(
  entry: RawLogEntry,
  firstThinkingAt: number | undefined,
  firstAnswerAt: number | undefined,
  reqStartMs: number,
): void {
  const candidates = [firstThinkingAt, firstAnswerAt].filter((x): x is number => x !== undefined);
  const firstTokenAt = candidates.length > 0 ? Math.min(...candidates) : undefined;

  if (firstTokenAt !== undefined) entry.ttftFirstTokenMs = firstTokenAt - reqStartMs;
  if (firstThinkingAt !== undefined) entry.ttftThinkingMs = firstThinkingAt - reqStartMs;
  if (firstAnswerAt !== undefined) entry.ttftAnswerMs = firstAnswerAt - reqStartMs;

  // 流式 duration：请求到达 → 流消费结束（覆盖拦截器在响应头到达时设的临时值）
  entry.duration = Date.now() - reqStartMs;

  // tokens/s：decode 阶段吞吐（首 token 之后的生成速度），流式专属
  const outTokens = entry.tokenUsage?.output_tokens ?? 0;
  if (entry.ttftFirstTokenMs !== undefined && entry.duration > entry.ttftFirstTokenMs && outTokens > 0) {
    const tps = outTokens / ((entry.duration - entry.ttftFirstTokenMs) / 1000);
    entry.tokensPerSecond = Math.round(tps * 10) / 10;
  }
}

export async function collectSSELinesInBackground(
  body: ReadableStream<Uint8Array>,
  entry: RawLogEntry,
  reqStartMs: number,
  onLogEntry: (entry: RawLogEntry) => void,
  onDeltaCommit: () => void,
): Promise<void> {
  const lines: SSERawLine[] = [];
  let totalBytes = 0;
  let truncated = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  // TTFT：首个思考/回答内容 delta 到达的墙钟时刻（两桶各记一次）
  let firstThinkingAt: number | undefined;
  let firstAnswerAt: number | undefined;

  try {
    const eventStream = body
      .pipeThrough(new TextDecoderStream() as any)
      .pipeThrough(new EventSourceParserStream()) as ReadableStream<any>;

    const reader = eventStream.getReader();

    // 超时保护：超时后写入部分数据
    const timeoutPromise = new Promise<'timeout'>(resolve => {
      timeoutId = setTimeout(() => resolve('timeout'), SSE_COLLECT_TIMEOUT_MS);
    });

    const readPromise = (async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return 'done' as const;
        // 累计字节上限保护：超限后停止收集，标记截断
        totalBytes += (value?.event?.length || 0) + (value?.data?.length || 0);
        if (totalBytes > SSE_COLLECT_MAX_BYTES) {
          truncated = true;
          return 'limit' as const;
        }
        const ev = value.event || '';
        const dat = value.data || '';
        lines.push({ event: ev, data: dat });
        // TTFT：首个思考/回答内容 delta 到达时刻（两桶都拿到后停止分类省 CPU）
        if (firstThinkingAt === undefined || firstAnswerAt === undefined) {
          let parsed: any;
          try { parsed = JSON.parse(dat); } catch { parsed = null; }
          if (parsed) {
            const cls = classifySSEEventTokenBucket(ev, parsed, entry.endpointType ?? null);
            if (cls.thinking && firstThinkingAt === undefined) firstThinkingAt = Date.now();
            if (cls.answer && firstAnswerAt === undefined) firstAnswerAt = Date.now();
          }
        }
      }
    })();

    const result = await Promise.race([readPromise, timeoutPromise]);

    if (result === 'timeout') {
      truncated = true;
      dbgSse('SSE 收集超时: lines=%d id=%s', lines.length, entry.id);
    } else if (result === 'limit') {
      dbgSse('SSE 收集超限: lines=%d bytes=%d id=%s', lines.length, totalBytes, entry.id);
    }

    if (result === 'timeout') {
      try { reader.cancel(); } catch { /* ignore */ }
      // reader.cancel() 会令 readPromise 内的 reader.read() reject，
      // 这里主动 await 吃掉，避免未处理的 Promise rejection
      await readPromise.catch(() => {});
    }

    // 写入日志：存储原始 SSE 数据
    entry.response = {
      status: entry.response?.status || 200,
      statusText: entry.response?.statusText || 'OK',
      headers: entry.response?.headers || {},
      body: {
        type: 'sse_raw',
        lines,
        ...(truncated ? { truncated: true } : {}),
      },
    };

    // 从 SSE 行中提取 token 使用情况
    const extracted = extractFromSSELines(lines);
    if (extracted.usage.input > 0 || extracted.usage.output > 0) {
      entry.tokenUsage = {
        input_tokens: extracted.usage.input,
        output_tokens: extracted.usage.output,
        cache_read_tokens: extracted.usage.cache_read || undefined,
        cache_creation_tokens: extracted.usage.cache_create || undefined,
      };
    }

    // 派生 TTFT / 终结流式 duration / tokens/s（须在 tokenUsage 设好后、写日志前）
    finalizeStreamTiming(entry, firstThinkingAt, firstAnswerAt, reqStartMs);

    onLogEntry(entry);
    onDeltaCommit();

    dumpSseDebug(entry, lines);
    dbgSse('SSE 收集完成: lines=%d truncated=%s', lines.length, truncated);
  } catch (err) {
    dbgSse('SSE 收集失败: %O', err);
    entry.response = {
      status: entry.response?.status || 200,
      statusText: entry.response?.statusText || 'OK',
      headers: entry.response?.headers || {},
      body: {
        type: 'sse_raw',
        lines,
        error: String(err),
        ...(lines.length > 0 ? { truncated: true } : {}),
      },
    };
    finalizeStreamTiming(entry, firstThinkingAt, firstAnswerAt, reqStartMs);
    onLogEntry(entry);
    onDeltaCommit();
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

// 兼容旧名称的别名
export const extractInBackground = collectSSELinesInBackground;