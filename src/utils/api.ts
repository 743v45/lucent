/**
 * API 工具函数
 */

import type { Provider, EndpointType } from '../types';
import { API_BASE_PATH } from '../constants';

/**
 * 通用请求函数
 */
async function request<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const url = `${API_BASE_PATH}${endpoint}`;
  const response = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
    ...options,
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`API Error: ${response.status} - ${error}`);
  }

  return response.json();
}

/**
 * 获取代理状态
 */
export async function getProxyStatus(): Promise<{
  enabled: boolean;
  running: boolean;
  host: string;
  webPort: number;
  proxyPort: number;
  logFile: string | null;
  providers?: import('../types').Provider[];
}> {
  return request('/status');
}

/**
 * 获取日志列表（分页）
 */
export async function getLogs(params?: { limit?: number; offset?: number }): Promise<{
  total: number;
  logs: Array<{
    id: string;
    timestamp: string;
    request: {
      method: string;
      url: string;
      headers: Record<string, string>;
      body: {
        model: string;
        messages: Array<{
          role: string;
          content: string | unknown;
        }>;
      };
    };
    response: {
      status: number;
      statusText: string;
      headers: Record<string, string>;
      body: {
        id: string;
        type: string;
        role: string;
        content: unknown;
        usage?: {
          input_tokens: number;
          output_tokens: number;
          cache_creation_tokens?: number;
          cache_read_tokens?: number;
        };
      };
    };
    agentType: string;
    duration: number;
    metadata: {
      model: string;
      provider: string;
      stream: boolean;
    };
    error?: string;
  }>;
}> {
  const qs = new URLSearchParams();
  if (params?.limit) qs.set('limit', String(params.limit));
  if (params?.offset) qs.set('offset', String(params.offset));
  const query = qs.toString();
  return request(`/logs${query ? `?${query}` : ''}`);
}

/**
 * 启用代理
 */
export async function enableProxy(): Promise<{ success: boolean }> {
  return request('/enable', { method: 'POST' });
}

/**
 * 禁用代理
 */
export async function disableProxy(): Promise<{ success: boolean }> {
  return request('/disable', { method: 'POST' });
}

/**
 * 刷新日志
 */
export async function refreshLogs(): Promise<{ success: boolean }> {
  return request('/logs/refresh', { method: 'POST' });
}

/**
 * 获取日志统计信息
 */
export async function getLogStats(): Promise<{
  totalEntries: number;
  totalSize: number;
  fileCount: number;
  oldestEntry?: string;
  newestEntry?: string;
}> {
  return request('/logs/stats');
}

/**
 * 导出日志
 */
export async function exportLogs(
  format: 'jsonl' | 'markdown' = 'jsonl',
  includeMeta = false
): Promise<{
  success: boolean;
  count: number;
  path: string;
}> {
  return request('/logs/export', {
    method: 'POST',
    body: JSON.stringify({ format, includeMeta }),
  });
}

/**
 * 导入日志
 */
export async function importLogs(
  filePath: string,
  merge = true,
  validate = true
): Promise<{
  success: boolean;
  imported: number;
  errors: number;
}> {
  return request('/logs/import', {
    method: 'POST',
    body: JSON.stringify({ filePath, merge, validate }),
  });
}

/**
 * 清空所有日志
 */
export async function clearAllLogs(): Promise<{
  success: boolean;
  deleted: number;
}> {
  return request('/logs', { method: 'DELETE' });
}

/**
 * 获取日志文件列表
 */
export async function getLogFiles(): Promise<
  Array<{
    name: string;
    size: number;
    created: number;
    modified: number;
  }>
> {
  return request('/log-files');
}

// ==================== Provider API ====================

/**
 * 列出所有供应商
 */
export async function listProviders(): Promise<Provider[]> {
  const data = await request<{ providers: Provider[] }>('/providers');
  return data.providers;
}

/**
 * 获取指定供应商完整信息
 */
export async function getProviderFull(name: string): Promise<Provider> {
  return request(`/providers/${encodeURIComponent(name)}/full`);
}

/**
 * 创建供应商
 */
export async function createProvider(input: {
  name: string;
  presetName?: string;
  endpoints: Record<EndpointType, string | null>;
}): Promise<Provider> {
  return request('/providers', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/**
 * 更新供应商（endpoints）
 */
export async function updateProvider(
  name: string,
  patch: { endpoints?: Record<EndpointType, string | null> }
): Promise<Provider> {
  return request(`/providers/${encodeURIComponent(name)}`, {
    method: 'PUT',
    body: JSON.stringify(patch),
  });
}

/**
 * 删除供应商
 */
export async function deleteProvider(name: string): Promise<void> {
  await request(`/providers/${encodeURIComponent(name)}`, {
    method: 'DELETE',
  });
}

/**
 * 重命名供应商
 */
export async function renameProvider(name: string, newName: string): Promise<Provider> {
  return request(`/providers/${encodeURIComponent(name)}/rename`, {
    method: 'POST',
    body: JSON.stringify({ newName }),
  });
}

/**
 * 测试供应商指定端点协议的连通性
 */
export async function testProviderEndpoint(
  name: string,
  endpointType: EndpointType
): Promise<{
  ok: boolean;
  status?: number;
  duration: number;
  message: string;
}> {
  return request(`/providers/${encodeURIComponent(name)}/test`, {
    method: 'POST',
    body: JSON.stringify({ endpointType }),
  });
}
