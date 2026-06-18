/**
 * SSE 提取函数（前端入口）
 *
 * 实际逻辑统一在 shared/sse-events.ts，前后端共用单源。
 * 此文件仅做 re-export，避免逻辑漂移。
 *
 * 支持的 SSE 事件见 shared/sse-events.ts 文件头注释。
 */

export {
  extractFromEvent,
  extractFromSSELines,
  extractedToResponseBody,
} from '../../shared/sse-events.js';
export type { ExtractedInfo, SSERawLine, ContentBlock } from '../../shared/sse-events.js';
