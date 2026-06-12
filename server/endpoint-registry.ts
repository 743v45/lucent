/**
 * 端点类型注册机制
 *
 * 将 EndpointType 的行为（路径匹配、SSE 提取、Context 提取）集中注册，
 * 减少添加新端点类型时的改动点。
 */

import type { EndpointType, ExtractedInfo } from './types.js';
import type { ExtractedContext, NormalizedMessage, NormalizedTool } from './context-extractors.js';

// ==================== Handler 接口 ====================

export interface EndpointHandler {
  /** 从 stripped path（去掉 /v1 前缀后的路径）判断是否匹配 */
  matchPath(strippedPath: string): boolean;

  /** 从该端点类型的 SSE 事件中提取信息 */
  extractSSE(eventType: string, data: any, acc: ExtractedInfo): void;

  /** 从该端点类型的请求体中提取 context */
  extractContext(body: any): ExtractedContext | null;
}

// ==================== 注册表 ====================

const registry = new Map<EndpointType, EndpointHandler>();

/**
 * 注册端点类型处理器
 */
export function registerEndpoint(type: EndpointType, handler: EndpointHandler): void {
  registry.set(type, handler);
}

/**
 * 查找已注册的处理器
 */
export function getEndpointHandler(type: EndpointType): EndpointHandler | undefined {
  return registry.get(type);
}

/**
 * 获取所有已注册的端点类型
 */
export function getRegisteredTypes(): EndpointType[] {
  return [...registry.keys()];
}

/**
 * 从 stripped path 推断端点类型（查注册表）
 */
export function inferEndpointTypeFromPath(strippedPath: string): EndpointType | null {
  for (const [type, handler] of registry) {
    if (handler.matchPath(strippedPath)) return type;
  }
  return null;
}

/**
 * 从 SSE 事件提取信息（按端点类型分发）
 *
 * 如果 endpointType 已知，只调用对应 handler；
 * 否则尝试所有 handler（兼容旧日志无 endpointType 的场景）
 */
export function extractSSEByEndpoint(
  eventType: string,
  data: any,
  acc: ExtractedInfo,
  endpointType?: EndpointType | null,
): void {
  if (endpointType) {
    const handler = registry.get(endpointType);
    if (handler) {
      handler.extractSSE(eventType, data, acc);
      return;
    }
  }
  // Fallback：尝试所有 handler
  for (const [, handler] of registry) {
    handler.extractSSE(eventType, data, acc);
  }
}

/**
 * 从请求体提取 context（按端点类型分发）
 */
export function extractContextByEndpoint(
  body: any,
  endpointType?: EndpointType | null,
): ExtractedContext | null {
  if (endpointType) {
    const handler = registry.get(endpointType);
    if (handler) return handler.extractContext(body);
  }
  // Fallback：尝试所有 handler
  for (const [, handler] of registry) {
    const result = handler.extractContext(body);
    if (result) return result;
  }
  return null;
}

// ==================== Context 辅助类型 ====================

// Re-export from context-extractors for convenience
export type { ExtractedContext, NormalizedMessage, NormalizedTool };
