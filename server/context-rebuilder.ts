/**
 * Context 重建器
 * 从多个 API 调用中重建完整对话上下文
 */

import {
  MAX_CONTEXT_CHECKPOINTS,
  CHECKPOINT_KEY_CONTENT_LENGTH,
} from './constants.js';
import { getContextSizeForModel } from './kvcache.js';
import createDebug from 'debug';
const log = createDebug('lucent:context:rebuild');

interface ContextMessage {
  role: string;
  content: string | ContentBlock[];
  timestamp: string;
  tool_use_id?: string;
  name?: string;
  id?: string;
}

interface ContentBlock {
  type: string;
  text?: string;
  cache_control?: { type: string };
  tool_use_id?: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: unknown;
  [key: string]: unknown;
}

interface Message {
  role: string;
  content: string | ContentBlock[];
}

interface RequestBody {
  system?: string | ContentBlock[];
  messages?: Message[];
  tools?: Tool[];
}

interface ResponseBody {
  role: string;
  content: ContentBlock[];
  id?: string;
  model?: string;
  stop_reason?: string;
}

interface Tool {
  name: string;
  input_schema?: Record<string, unknown>;
  description?: string;
}

interface ContextCheckpoint {
  timestamp: string;
  messages: ContextMessage[];
  systemPrompt?: string;
  tools?: Tool[];
  model?: string;
}

interface ContextWindow {
  totalTokens: number;
  contextSize: number;
  usedPercentage: number;
  remainingPercentage: number;
}

/**
 * Context 重建器类
 */
export class ContextRebuilder {
  private checkpoints: Map<string, ContextCheckpoint> = new Map();
  private currentCheckpointKey: string | null = null;
  private readonly maxCheckpoints = MAX_CONTEXT_CHECKPOINTS;

  /**
   * 从请求体中提取消息并转换为上下文消息
   */
  private extractMessagesFromRequest(
    body: RequestBody,
    timestamp: string
  ): ContextMessage[] {
    const messages: ContextMessage[] = [];

    if (!body.messages || !Array.isArray(body.messages)) {
      return messages;
    }

    for (const msg of body.messages) {
      const content = this.normalizeContent(msg.content);
      messages.push({
        role: msg.role,
        content,
        timestamp,
      });
    }

    return messages;
  }

  /**
   * 从响应体中提取消息并转换为上下文消息
   */
  private extractMessagesFromResponse(
    body: ResponseBody,
    timestamp: string
  ): ContextMessage[] {
    const messages: ContextMessage[] = [];

    if (!body.content || !Array.isArray(body.content)) {
      return messages;
    }

    for (const block of body.content) {
      if (block.type === 'text' && block.text) {
        messages.push({
          role: body.role || 'assistant',
          content: block.text,
          timestamp,
          id: body.id,
        });
      } else if (block.type === 'thinking') {
        // Anthropic 扩展思考块：提取 thinking 文本作为 assistant 消息。
        messages.push({
          role: body.role || 'assistant',
          content: typeof block.thinking === 'string' ? block.thinking : '',
          timestamp,
          id: body.id,
        });
      } else if (block.type === 'tool_use') {
        messages.push({
          role: body.role || 'assistant',
          content: [block],
          timestamp,
          id: body.id,
          tool_use_id: block.id as string | undefined,
          name: block.name as string | undefined,
        });
      }
      // TODO: tool_result 块（type==='tool_result'）当前未单独提取，
      // 因请求侧已通过 extractMessagesFromRequest 覆盖工具结果消息。
      // TODO: OpenAI 响应（choices[].message）走不同结构，不在此函数适用范围，
      // 其上下文由 context-extractors.ts 处理，此处不硬改。
    }

    return messages;
  }

  /**
   * 规范化内容为 ContentBlock[] 格式
   */
  private normalizeContent(content: string | ContentBlock[]): ContentBlock[] {
    if (typeof content === 'string') {
      return [{ type: 'text', text: content }];
    }
    return content;
  }

  /**
   * 从 ContentBlock[] 提取纯文本
   */
  private extractTextFromBlocks(blocks: ContentBlock[]): string {
    return blocks
      .filter(b => b.type === 'text' && typeof b.text === 'string')
      .map(b => b.text)
      .join('\n');
  }

  /**
   * 提取系统提示词
   */
  private extractSystemPrompt(body: RequestBody): string | undefined {
    if (!body.system) {
      return undefined;
    }

    if (typeof body.system === 'string') {
      return body.system;
    }

    if (Array.isArray(body.system)) {
      return this.extractTextFromBlocks(body.system);
    }

    return undefined;
  }

  /**
   * 生成检查点键（基于对话标识）
   */
  private generateCheckpointKey(requestBody: RequestBody): string {
    // 使用第一个用户消息作为键
    if (requestBody.messages && requestBody.messages.length > 0) {
      const firstUserMsg = requestBody.messages.find(m => m.role === 'user');
      if (firstUserMsg) {
        const content = typeof firstUserMsg.content === 'string'
          ? firstUserMsg.content
          : this.extractTextFromBlocks(firstUserMsg.content);
        // 内容非空时用内容前缀作键
        if (content) {
          return `cp_${content.substring(0, CHECKPOINT_KEY_CONTENT_LENGTH).replace(/\s/g, '_')}`;
        }
      }
    }

    // 回退：首条 user 消息为空/缺失时，用 system + 首条 message 文本组合的简单哈希，
    // 而非时间戳——避免同对话每次请求生成新 key 导致 checkpoint 孤立。
    const systemText = typeof requestBody.system === 'string'
      ? requestBody.system
      : (Array.isArray(requestBody.system) ? this.extractTextFromBlocks(requestBody.system) : '');
    const firstMsg = requestBody.messages?.[0];
    const firstMsgText = firstMsg
      ? (typeof firstMsg.content === 'string'
        ? firstMsg.content
        : this.extractTextFromBlocks(firstMsg.content))
      : '';
    const fallbackSeed = `${systemText}|${firstMsgText}`;
    if (fallbackSeed.trim()) {
      // 简单确定性哈希（djb2），保证相同对话产生相同 key。
      let hash = 5381;
      for (let i = 0; i < fallbackSeed.length; i++) {
        hash = ((hash << 5) + hash + fallbackSeed.charCodeAt(i)) | 0;
      }
      return `cp_${(hash >>> 0).toString(36)}`;
    }

    return `cp_empty`;
  }

  /**
   * 创建检查点
   */
  public createCheckpoint(
    requestBody: RequestBody,
    responseBody: ResponseBody,
    timestamp: string,
    model?: string
  ): string {
    const key = this.generateCheckpointKey(requestBody);

    const messages: ContextMessage[] = [
      ...this.extractMessagesFromRequest(requestBody, timestamp),
      ...this.extractMessagesFromResponse(responseBody, timestamp),
    ];

    const checkpoint: ContextCheckpoint = {
      timestamp,
      messages: this.sortMessagesByTimestamp(messages),
      systemPrompt: this.extractSystemPrompt(requestBody),
      tools: requestBody.tools,
      model,
    };

    this.checkpoints.set(key, checkpoint);
    this.currentCheckpointKey = key;
    log('创建 checkpoint: key=%s messages=%d', key, checkpoint.messages.length);

    // 清理旧检查点
    this.cleanupOldCheckpoints();

    return key;
  }

  /**
   * 按时间戳排序消息
   */
  private sortMessagesByTimestamp(messages: ContextMessage[]): ContextMessage[] {
    return [...messages].sort((a, b) => {
      const timeA = new Date(a.timestamp).getTime();
      const timeB = new Date(b.timestamp).getTime();
      // 非法时间戳（NaN）会令比较函数恒返回 false 导致排序不可预测；
      // NaN 回退为 0，使其相对顺序稳定（不早于任意有效时间戳之后随机排列）。
      const safeA = Number.isNaN(timeA) ? 0 : timeA;
      const safeB = Number.isNaN(timeB) ? 0 : timeB;
      return safeA - safeB;
    });
  }

  /**
   * 添加消息到当前检查点
   */
  public addMessagesToCheckpoint(messages: ContextMessage[]): void {
    if (!this.currentCheckpointKey) {
      return;
    }

    const checkpoint = this.checkpoints.get(this.currentCheckpointKey);
    if (!checkpoint) {
      return;
    }

    checkpoint.messages = this.sortMessagesByTimestamp([
      ...checkpoint.messages,
      ...messages,
    ]);

    this.checkpoints.set(this.currentCheckpointKey, checkpoint);
  }

  /**
   * 获取当前检查点
   */
  public getCurrentCheckpoint(): ContextCheckpoint | null {
    if (!this.currentCheckpointKey) {
      return null;
    }
    return this.checkpoints.get(this.currentCheckpointKey) || null;
  }

  /**
   * 获取指定检查点
   */
  public getCheckpoint(key: string): ContextCheckpoint | null {
    return this.checkpoints.get(key) || null;
  }

  /**
   * 获取所有检查点
   */
  public getAllCheckpoints(): Map<string, ContextCheckpoint> {
    return this.checkpoints;
  }

  /**
   * 清理旧检查点（保留最新的 N 个）
   */
  private cleanupOldCheckpoints(): void {
    if (this.checkpoints.size <= this.maxCheckpoints) {
      return;
    }

    // 按时间戳排序，删除最旧的
    const entries = Array.from(this.checkpoints.entries())
      .sort((a, b) => {
        const timeA = new Date(a[1].timestamp).getTime();
        const timeB = new Date(b[1].timestamp).getTime();
        return timeA - timeB;
      });

    const toDelete = entries.slice(0, this.checkpoints.size - this.maxCheckpoints);
    for (const [key] of toDelete) {
      this.checkpoints.delete(key);
    }
    if (toDelete.length > 0) {
      log('清理旧 checkpoints: 删除=%d 剩余=%d', toDelete.length, this.checkpoints.size);
    }
  }

  /**
   * 重置重建器
   */
  public reset(): void {
    this.checkpoints.clear();
    this.currentCheckpointKey = null;
  }

  /**
   * 将检查点转换为可序列化的格式
   */
  public checkpointToSerializable(checkpoint: ContextCheckpoint): {
    timestamp: string;
    messages: unknown[];
    systemPrompt?: string;
    tools?: unknown[];
    model?: string;
  } {
    return {
      timestamp: checkpoint.timestamp,
      messages: checkpoint.messages.map(msg => ({
        ...msg,
        content: typeof msg.content === 'string'
          ? msg.content
          : msg.content,
      })),
      systemPrompt: checkpoint.systemPrompt,
      tools: checkpoint.tools,
      model: checkpoint.model,
    };
  }

  /**
   * 从可序列化格式恢复检查点
   */
  public checkpointFromSerializable(data: {
    timestamp: string;
    messages: unknown[];
    systemPrompt?: string;
    tools?: unknown[];
    model?: string;
  }): ContextCheckpoint {
    return {
      timestamp: data.timestamp,
      messages: data.messages as ContextMessage[],
      systemPrompt: data.systemPrompt,
      tools: data.tools as Tool[],
      model: data.model,
    };
  }
}

/**
 * 全局 Context 重建器实例
 */
export const globalContextRebuilder = new ContextRebuilder();

/**
 * 计算上下文窗口使用情况
 */
export function calculateContextWindow(
  inputTokens: number,
  outputTokens: number,
  model: string
): ContextWindow {
  const contextSize = getContextSizeForModel(model);
  const totalTokens = inputTokens + outputTokens;
  // contextSize 为 0（未知模型等）时避免除零产生 NaN 污染 UI，直接置 0 使用率。
  if (contextSize <= 0) {
    log('上下文窗口: %d/%d tokens (contextSize<=0，置 0)', totalTokens, contextSize);
    return {
      totalTokens,
      contextSize,
      usedPercentage: 0,
      remainingPercentage: 0,
    };
  }
  const usedPercentage = Math.min(100, Math.round((totalTokens / contextSize) * 100));
  const remainingPercentage = 100 - usedPercentage;

  log('上下文窗口: %d/%d tokens (%d%% used)', totalTokens, contextSize, usedPercentage);

  return {
    totalTokens,
    contextSize,
    usedPercentage,
    remainingPercentage,
  };
}

/**
 * 构建对话摘要（用于 UI 显示）
 */
export function buildConversationSummary(
  checkpoint: ContextCheckpoint
): {
  totalMessages: number;
  userMessages: number;
  assistantMessages: number;
  toolMessages: number;
  systemPromptLength: number;
  toolsCount: number;
  duration: number;
} {
  const totalMessages = checkpoint.messages.length;
  const userMessages = checkpoint.messages.filter(m => m.role === 'user').length;
  const assistantMessages = checkpoint.messages.filter(m => m.role === 'assistant').length;
  // toolMessages 只统计"工具结果"消息（role==='tool'，或 Anthropic 中承载 tool_result 的 user 消息）。
  // 注意：assistant 的 tool_use 块也会带 tool_use_id，但那属于 assistant 发起的工具调用，
  // 不应计入 toolMessages（避免与 assistantMessages 双计）。
  const toolMessages = checkpoint.messages.filter(m =>
    m.role === 'tool' ||
    (m.tool_use_id && m.role !== 'assistant')
  ).length;
  const systemPromptLength = checkpoint.systemPrompt?.length || 0;
  const toolsCount = checkpoint.tools?.length || 0;

  // 计算持续时间（从第一条到最后一条消息）
  let duration = 0;
  if (checkpoint.messages.length >= 2) {
    const firstTime = new Date(checkpoint.messages[0].timestamp).getTime();
    const lastTime = new Date(checkpoint.messages[checkpoint.messages.length - 1].timestamp).getTime();
    duration = lastTime - firstTime;
  }

  return {
    totalMessages,
    userMessages,
    assistantMessages,
    toolMessages,
    systemPromptLength,
    toolsCount,
    duration,
  };
}
