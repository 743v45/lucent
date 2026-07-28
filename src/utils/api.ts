/**
 * API 工具函数
 */

import type {
  Provider,
  EndpointType,
  BodyRewriteRule,
  RequestData,
  ResponseData,
  AgentType,
  ClientType,
  TokenUsage,
  Metadata,
  KVCacheInfo,
  ContextData,
} from '../types';
import { API_BASE_PATH } from '../constants';

/**
 * /logs 接口返回的单条日志原始形状（对齐运行时实际字段）。
 * 供 getLogs 返回类型与 useLogs.formatLog 入参共享，避免 type narrowing 丢失字段
 * （tokenUsage / kvCache / context / threadId / expiresAt 等十余字段）后被 `as` 强制断言。
 */
export interface ApiLog {
  id: string;
  timestamp: string;
  request: RequestData;
  response: ResponseData;
  agentType: AgentType;
  apiType?: EndpointType;
  clientType?: ClientType;
  duration: number;
  ttftFirstTokenMs?: number;
  ttftThinkingMs?: number;
  ttftAnswerMs?: number;
  tokensPerSecond?: number;
  tokenUsage?: TokenUsage;
  metadata: Metadata;
  kvCache?: KVCacheInfo;
  context?: ContextData;
  error?: string;
  isTest?: boolean;
  providerName?: string;
  threadId?: string;
  endpointType?: EndpointType;
  expiresAt?: string;
}

/**
 * 通用请求函数
 *
 * headers 合并：先解构出 options.headers，再把默认 Content-Type 与调用方 headers
 * 合并到最后。尾部 ...options 不能再覆盖 headers（low#12：原写法 ...options 在 headers
 * 之后会整体击穿默认 Content-Type）。
 */
export async function request<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const url = `${API_BASE_PATH}${endpoint}`;
  const { headers, ...rest } = options;
  const response = await fetch(url, {
    ...rest,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
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
  logMode?: import('../types').LogMode;
  logModeEnvLocked?: boolean;
  tempLogTtlMinutes?: number;
  retentionDays?: number;
}> {
  return request('/status');
}

/**
 * 切换日志记录模式（持久化）。可选同时更新临时 TTL。
 * 返回有效值 logMode 与是否被 env 锁定 envLocked。
 */
export async function setLogMode(
  logMode: import('../types').LogMode,
  tempTtlMinutes?: number,
): Promise<{ success: boolean; logMode: import('../types').LogMode; envLocked: boolean }> {
  return request('/recording', {
    method: 'POST',
    body: JSON.stringify({ logMode, tempTtlMinutes }),
  });
}

/**
 * 设置存档保留期（天，持久化）。返回有效值 retentionDays 与是否被 env 锁定。
 */
export async function setRetentionDays(
  days: number,
): Promise<{ success: boolean; retentionDays: number; envLocked: boolean }> {
  return request('/retention', {
    method: 'POST',
    body: JSON.stringify({ days }),
  });
}

/**
 * 获取日志列表（keyset 分页 + 服务端 search / 过滤）
 *
 * 分页用 cursor（keyset，深页不退化）：首页不传，续页传上次返回的 nextCursor。
 * search 非空走 FTS5 全文检索；providerName / endpointType 服务端过滤。
 */
export async function getLogs(params?: {
  limit?: number;
  cursor?: string;
  search?: string;
  providerName?: string;
  endpointType?: string;
  threadId?: string;
}): Promise<{
  total: number;
  nextCursor: string | null;
  hasMore: boolean;
  logs: ApiLog[];
}> {
  const qs = new URLSearchParams();
  if (params?.limit) qs.set('limit', String(params.limit));
  if (params?.cursor) qs.set('cursor', params.cursor);
  if (params?.search) qs.set('search', params.search);
  if (params?.providerName && params.providerName !== 'all') qs.set('providerName', params.providerName);
  if (params?.endpointType && params.endpointType !== 'all') qs.set('endpointType', params.endpointType);
  if (params?.threadId) qs.set('threadId', params.threadId);
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

// ==================== Config 导入导出 API ====================

/**
 * 导出当前配置为可移植 SQL 脚本（config 表单行 JSON blob）。返回 SQL 文本（可直接下载/喂 sqlite）。
 */
export async function exportConfigSql(): Promise<string> {
  const response = await fetch(`${API_BASE_PATH}/config/export`);
  if (!response.ok) {
    throw new Error(`API Error: ${response.status} - ${await response.text()}`);
  }
  return response.text();
}

/**
 * 导入配置（JSON 对象/字符串，或导出的 SQL 脚本），事务替换。校验失败抛错（消息来自后端）。
 */
export async function importConfig(payload: string | object): Promise<{ success: boolean }> {
  return request('/config/import', {
    method: 'POST',
    body: JSON.stringify({ payload }),
  });
}

// ==================== Body Rewrite API ====================

/**
 * 列出全部 body 重写规则
 */
export async function listBodyRewrites(): Promise<BodyRewriteRule[]> {
  const data = await request<{ bodyRewrites: BodyRewriteRule[] }>('/body-rewrites');
  return data.bodyRewrites;
}

/**
 * 新增一条 body 重写规则（id 由后端生成）
 */
export async function createBodyRewrite(input: {
  fieldPath: string;
  pattern: string;
  replacement: string;
  name?: string;
  enabled?: boolean;
  flags?: string;
}): Promise<BodyRewriteRule> {
  return request('/body-rewrites', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/**
 * 更新一条 body 重写规则（按 id，id 不可改）
 */
export async function updateBodyRewrite(
  id: string,
  patch: Partial<Omit<BodyRewriteRule, 'id'>>,
): Promise<BodyRewriteRule> {
  return request(`/body-rewrites/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(patch),
  });
}

/**
 * 删除一条 body 重写规则（按 id）
 */
export async function deleteBodyRewrite(id: string): Promise<void> {
  await request(`/body-rewrites/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}
