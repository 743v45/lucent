/**
 * API 工具函数
 */

import type { ProxyConfig, CreateProfileData, UpdateProfileData, ProfileFull } from '../types';

const API_BASE = '/api';

/**
 * 通用请求函数
 */
async function request<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const url = `${API_BASE}${endpoint}`;
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
  webPort: number;
  proxyPort: number;
  logFile: string | null;
}> {
  return request('/status');
}

/**
 * 获取日志列表
 */
export async function getLogs(): Promise<{
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
    subAgentType?: string;
    duration: number;
    metadata: {
      model: string;
      provider: string;
      stream: boolean;
    };
    error?: string;
  }>;
}> {
  return request('/logs');
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

// ==================== 配置 API ====================

/**
 * 获取代理配置（脱敏）
 */
export async function getProxyConfig(): Promise<ProxyConfig> {
  return request('/config');
}

/**
 * 获取 profile 详情（含 apiKey）
 */
export async function getProfileFull(name: string): Promise<ProfileFull> {
  return request(`/config/${encodeURIComponent(name)}/full`);
}

/**
 * 更新 profile
 */
export async function updateProfile(name: string, updates: UpdateProfileData): Promise<ProxyConfig> {
  return request(`/config/profiles/${encodeURIComponent(name)}`, {
    method: 'PUT',
    body: JSON.stringify(updates),
  });
}

/**
 * 创建 profile
 */
export async function createProfile(profile: CreateProfileData): Promise<ProxyConfig> {
  return request('/config/profiles', {
    method: 'POST',
    body: JSON.stringify(profile),
  });
}

/**
 * 切换激活 profile
 */
export async function setActiveProfile(name: string): Promise<ProxyConfig> {
  return request('/config/active', {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
}

/**
 * 重命名 profile
 */
export async function renameProfile(oldName: string, newName: string): Promise<ProxyConfig> {
  return request(`/config/profiles/${encodeURIComponent(oldName)}/rename`, {
    method: 'PUT',
    body: JSON.stringify({ newName }),
  });
}

/**
 * 删除 profile
 */
export async function deleteProfile(name: string): Promise<ProxyConfig> {
  return request(`/config/profiles/${encodeURIComponent(name)}`, {
    method: 'DELETE',
  });
}

/**
 * 测试上游连接
 */
export async function testConnection(url: string, apiKey?: string): Promise<{
  ok: boolean;
  status?: number;
  duration: number;
  message: string;
}> {
  return request('/config/test', {
    method: 'POST',
    body: JSON.stringify({ url, apiKey }),
  });
}
