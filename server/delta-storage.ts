/**
 * Delta 存储管理器
 *
 * 管理增量存储的状态：消息计数、尾部指纹、checkpoint 间隔
 * 从 interceptor.ts 提取而来
 */

import { DELTA_CHECKPOINT_INTERVAL } from './constants.js';
import type { RawLogEntry } from './types.js';
import createDebug from 'debug';
const dbgDelta = createDebug('agentproxy:interceptor:delta');

// ==================== Delta 状态 ====================

let lastMessagesCount = 0;
let lastTailFp = '';
let mainAgentDeltaCount = 0;

// ==================== 工具函数 ====================

/**
 * 计算消息指纹（用于检测 in-place replace）
 */
export function fingerprintMsg(msg: unknown): string {
  if (!msg) return '';
  try {
    return JSON.stringify(msg);
  } catch {
    return String(msg);
  }
}

/**
 * Delta 存储：completed 写入成功后更新状态
 */
export function commitDeltaState(originalLength: number, originalTailFp: string): void {
  if (originalLength > 0 && originalLength > lastMessagesCount) {
    lastMessagesCount = originalLength;
    if (typeof originalTailFp === 'string') {
      lastTailFp = originalTailFp;
    }
  }
}

/**
 * 重置 Delta 状态（日志轮转时调用）
 */
export function resetDeltaState(): void {
  lastMessagesCount = 0;
  lastTailFp = '';
  mainAgentDeltaCount = 0;
}

// ==================== Delta 处理 ====================

export interface DeltaProcessingResult {
  deltaOriginalMessagesLength: number;
  deltaOriginalTailFp: string;
}

/**
 * 处理 Delta 存储逻辑
 *
 * 根据消息变化量决定是 checkpoint（完整保存）还是 delta（只保留新增部分）
 * 通过修改 entry 的 body.messages 和 _delta* 字段来实现
 */
export function processDelta(entry: RawLogEntry, body: any): DeltaProcessingResult {
  const messages = body?.messages;
  if (!Array.isArray(messages)) {
    return { deltaOriginalMessagesLength: 0, deltaOriginalTailFp: '' };
  }

  const deltaOriginalMessagesLength = messages.length;
  const deltaOriginalTailFp = messages.length > 0 ? fingerprintMsg(messages[messages.length - 1]) : '';
  mainAgentDeltaCount++;

  // 快照上一请求的状态
  const prevMessagesCount = lastMessagesCount;
  const prevTailFp = lastTailFp;

  // Eager update：立即推到本次值
  if (deltaOriginalMessagesLength > 0) {
    lastMessagesCount = deltaOriginalMessagesLength;
    if (deltaOriginalTailFp !== '') {
      lastTailFp = deltaOriginalTailFp;
    }
  }

  // In-place replace 检测
  const sameLenInPlaceReplace =
    messages.length === prevMessagesCount &&
    prevMessagesCount > 0 &&
    prevTailFp !== '' &&
    deltaOriginalTailFp !== '' &&
    deltaOriginalTailFp !== prevTailFp;

  // 判断是否需要 checkpoint
  const needsCheckpoint =
    prevMessagesCount === 0 ||
    messages.length < prevMessagesCount ||
    (mainAgentDeltaCount % DELTA_CHECKPOINT_INTERVAL === 0) ||
    sameLenInPlaceReplace;

  if (needsCheckpoint) {
    // Checkpoint：保持完整 messages
    entry._deltaFormat = 1;
    entry._totalMessageCount = messages.length;
    entry._conversationId = 'mainAgent';
    entry._isCheckpoint = true;
    if (sameLenInPlaceReplace) {
      entry._inPlaceReplaceDetected = true;
    }
    dbgDelta('Checkpoint: isCheckpoint=true totalMsgs=%d prevCount=%d inPlaceReplace=%s', messages.length, prevMessagesCount, sameLenInPlaceReplace);
  } else {
    // Delta：只保留新增的 messages
    const delta = messages.slice(prevMessagesCount);
    entry._deltaFormat = 1;
    entry._totalMessageCount = messages.length;
    entry._conversationId = 'mainAgent';
    entry._isCheckpoint = false;
    entry.body = { ...body, messages: delta };
    dbgDelta('Delta: slicing messages [%d..%d] (%d new)', prevMessagesCount, messages.length, delta.length);
  }

  return { deltaOriginalMessagesLength, deltaOriginalTailFp };
}
