/**
 * Lucent 配置管理模块
 *
 * 配置文件: ~/.lucent/config.json
 * 多供应商 + 多端点结构，运行时可修改，内存缓存 + 磁盘持久化
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { CONFIG_PATH, CONFIG_DIR, DEFAULT_PROXY_PORT, DEFAULT_WEB_PORT, DEFAULT_SERVER_HOST, LOG_DIR, MAX_LOG_FILE_SIZE, MAX_LOG_FILES, LOG_RETENTION_DAYS } from './constants.js';
import { ENDPOINT_TYPES, isEndpointType, isValidProviderName, PRESET_NAMES } from './types.js';
import type { EndpointType, Provider } from './types.js';
import createDebug from 'debug';
const log = createDebug('lucent:config');

// ==================== 类型定义 ====================

/**
 * 全局代理配置
 */
export interface ProxyConfig {
  host: string;          // 服务器监听地址，默认 127.0.0.1
  proxyPort: number;     // 代理端口，默认 7048
  webPort: number;       // Web UI 端口，默认 7049
  providers: Provider[];
  // 可选的服务器配置（环境变量优先）
  logDir?: string;
  logRetentionDays?: number;
  maxLogFileSize?: number;
  maxLogFiles?: number;
}

/**
 * 解析后的完整配置（所有字段必填）
 * 优先级：环境变量 > 配置文件 > 默认值
 */
export interface ResolvedConfig {
  host: string;
  proxyPort: number;
  webPort: number;
  logDir: string;
  logRetentionDays: number;
  maxLogFileSize: number;
  maxLogFiles: number;
  providers: Provider[];
}

// ==================== 默认配置 ====================

/**
 * 构造默认配置（含一个 anthropic 种子 provider）
 */
function buildDefaultConfig(): ProxyConfig {
  return {
    host: DEFAULT_SERVER_HOST,
    proxyPort: DEFAULT_PROXY_PORT,
    webPort: DEFAULT_WEB_PORT,
    providers: [
      {
        id: randomUUID(),
        name: 'anthropic',
        endpoints: {
          'openai-chat': null,
          'openai-responses': null,
          'anthropic-messages': 'https://api.anthropic.com',
        },
      },
    ],
  };
}

// ==================== 内存缓存 ====================

let cachedConfig: ProxyConfig | null = null;

// ==================== 工具函数 ====================

function ensureDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

/**
 * 校验单个 provider 的合法性（不包括跨 provider 的 name 唯一性）
 */
function validateProvider(p: unknown, index: number): asserts p is Provider {
  if (!p || typeof p !== 'object') {
    throw new Error(`Provider[${index}] is not an object`);
  }
  const prov = p as Record<string, unknown>;
  if (typeof prov.id !== 'string' || prov.id.length === 0) {
    throw new Error(`Provider[${index}].id must be a non-empty string`);
  }
  if (typeof prov.name !== 'string' || !isValidProviderName(prov.name)) {
    throw new Error(`Provider[${index}].name must match [a-zA-Z0-9_-]{1,32}, got: ${JSON.stringify(prov.name)}`);
  }
  // presetName 校验
  if (prov.presetName !== undefined && prov.presetName !== null) {
    if (typeof prov.presetName !== 'string' || !PRESET_NAMES.has(prov.presetName)) {
      throw new Error(`Provider[${index}].presetName is not a valid preset name: ${JSON.stringify(prov.presetName)}`);
    }
    if (prov.name !== prov.presetName) {
      throw new Error(`Provider[${index}].name must equal presetName when presetName is set, got name=${JSON.stringify(prov.name)}, presetName=${JSON.stringify(prov.presetName)}`);
    }
  }
  if (!prov.endpoints || typeof prov.endpoints !== 'object') {
    throw new Error(`Provider[${index}].endpoints must be an object`);
  }
  const endpoints = prov.endpoints as Record<string, unknown>;
  // 三个 endpoint 键必须齐全（允许 null）
  for (const key of ENDPOINT_TYPES) {
    if (!(key in endpoints)) {
      throw new Error(`Provider[${index}].endpoints missing key: ${key}`);
    }
    const v = endpoints[key];
    if (v !== null && typeof v !== 'string') {
      throw new Error(`Provider[${index}].endpoints.${key} must be string or null, got: ${typeof v}`);
    }
  }
  // 不允许多余的键（必须严格三个）
  for (const key of Object.keys(endpoints)) {
    if (!isEndpointType(key)) {
      throw new Error(`Provider[${index}].endpoints has unknown key: ${key}`);
    }
  }
}

/**
 * 校验 providers 数组：每个 provider 合法 + name 全局唯一
 */
function validateProviders(providers: unknown): asserts providers is Provider[] {
  if (!Array.isArray(providers)) {
    throw new Error('providers must be an array');
  }
  const names = new Set<string>();
  providers.forEach((p, i) => {
    validateProvider(p, i);
    if (names.has(p.name)) {
      throw new Error(`Duplicate provider name: ${p.name}`);
    }
    names.add(p.name);
  });
}

/**
 * 校验完整的 ProxyConfig 结构（不允许字段缺失）
 */
function validateConfig(cfg: unknown): asserts cfg is ProxyConfig {
  if (!cfg || typeof cfg !== 'object') {
    throw new Error('config must be an object');
  }
  const c = cfg as Record<string, unknown>;
  if (typeof c.host !== 'string' || c.host.length === 0) {
    throw new Error('config.host must be a non-empty string');
  }
  if (typeof c.proxyPort !== 'number' || !Number.isInteger(c.proxyPort)) {
    throw new Error('config.proxyPort must be an integer');
  }
  if (typeof c.webPort !== 'number' || !Number.isInteger(c.webPort)) {
    throw new Error('config.webPort must be an integer');
  }
  validateProviders(c.providers);
}

// ==================== 核心 API ====================

/**
 * 解析环境变量中的数字，失败则返回 fallback
 */
function parseEnvNumber(name: string, fallback: number): number {
  const val = process.env[name];
  if (!val) return fallback;
  const n = parseInt(val, 10);
  return isNaN(n) ? fallback : n;
}

/**
 * 解析完整配置：环境变量 > 配置文件 > 默认值
 */
export function resolveEffectiveConfig(): ResolvedConfig {
  const raw = getConfig();
  return {
    host:                process.env.LUCENT_HOST              || raw.host,
    proxyPort:           parseEnvNumber('LUCENT_PROXY_PORT',  raw.proxyPort),
    webPort:             parseEnvNumber('LUCENT_WEB_PORT',    raw.webPort),
    logDir:              process.env.LUCENT_LOG_DIR           || raw.logDir             || LOG_DIR,
    logRetentionDays:    parseEnvNumber('LUCENT_LOG_RETENTION_DAYS', raw.logRetentionDays ?? LOG_RETENTION_DAYS),
    maxLogFileSize:      parseEnvNumber('LUCENT_MAX_LOG_FILE_SIZE',  raw.maxLogFileSize   ?? MAX_LOG_FILE_SIZE),
    maxLogFiles:         parseEnvNumber('LUCENT_MAX_LOG_FILES',      raw.maxLogFiles      ?? MAX_LOG_FILES),
    providers:           raw.providers,
  };
}

/**
 * 环境变量覆盖 host（CLI --host 选项通过 LUCENT_HOST 传递）
 */
function applyHostOverride(config: ProxyConfig): void {
  if (!config.host) {
    config.host = DEFAULT_SERVER_HOST;
  }
  if (process.env.LUCENT_HOST) {
    config.host = process.env.LUCENT_HOST;
  }
}

/**
 * 写入默认配置到磁盘并缓存
 */
function initDefaultConfig(): ProxyConfig {
  const def = buildDefaultConfig();
  ensureDir();
  writeFileSync(CONFIG_PATH, JSON.stringify(def, null, 2), 'utf-8');
  cachedConfig = def;
  applyHostOverride(cachedConfig);
  log('初始化默认配置: providers=%d', def.providers.length);
  return cachedConfig;
}

/**
 * 加载配置（从磁盘读取）
 *
 * 行为：
 * - 文件不存在 → 创建默认配置并写盘
 * - 文件存在但 JSON 解析失败或校验失败 → 创建默认配置并写盘（旧的不要了）
 * - 文件合法 → 返回
 */
export function loadConfig(): ProxyConfig {
  if (!existsSync(CONFIG_PATH)) {
    log('配置文件不存在，初始化默认配置');
    return initDefaultConfig();
  }

  try {
    const raw = readFileSync(CONFIG_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    validateConfig(parsed);
    cachedConfig = parsed;
    applyHostOverride(cachedConfig);
    return cachedConfig;
  } catch (error) {
    log('配置文件无效，重置为默认配置: %O', error);
    return initDefaultConfig();
  }
}

/**
 * 获取当前配置（内存缓存，无磁盘 IO）
 */
export function getConfig(): ProxyConfig {
  if (!cachedConfig) {
    return loadConfig();
  }
  return cachedConfig;
}

/**
 * 保存配置（更新缓存 + 写磁盘）
 *
 * 写入前会做完整校验，校验失败会抛出 Error，不会写入坏数据。
 */
export function saveConfig(config: ProxyConfig): ProxyConfig {
  validateConfig(config);
  ensureDir();
  cachedConfig = config;
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
  log('配置已保存: %d providers, host=%s, proxyPort=%d', config.providers.length, config.host, config.proxyPort);
  return config;
}

// ==================== Provider 查找 ====================

/**
 * 按 name 查找 provider（精确匹配）
 */
export function findProviderByName(config: ProxyConfig, name: string): Provider | null {
  return config.providers.find(p => p.name === name) || null;
}

/**
 * 按 id 查找 provider
 */
export function findProviderById(config: ProxyConfig, id: string): Provider | null {
  return config.providers.find(p => p.id === id) || null;
}

// ==================== Provider CRUD ====================

/**
 * 创建 Provider（自动生成 id）
 *
 * 失败抛 Error：name 非法 / name 已存在 / endpoints 非法。
 */
export function createProvider(input: Omit<Provider, 'id'>): Provider {
  const config = getConfig();
  if (!isValidProviderName(input.name)) {
    throw new Error(`Invalid provider name: ${JSON.stringify(input.name)}`);
  }
  if (findProviderByName(config, input.name)) {
    throw new Error(`Provider name already exists: ${input.name}`);
  }
  // 预设名校验：无 presetName 但 name 是保留名 → 拒绝
  if (!input.presetName && PRESET_NAMES.has(input.name)) {
    throw new Error('Cannot use reserved preset name without presetName');
  }
  const newProvider: Provider = {
    id: randomUUID(),
    name: input.name,
    ...(input.presetName ? { presetName: input.presetName } : {}),
    endpoints: input.endpoints,
  };
  validateProvider(newProvider, config.providers.length);
  config.providers.push(newProvider);
  saveConfig(config);
  return newProvider;
}

/**
 * 更新 Provider（按 id），仅允许更新 endpoints；改名走 renameProvider。
 *
 * 失败抛 Error：provider 不存在 / endpoints 非法。
 */
export function updateProvider(id: string, updates: { endpoints?: Record<EndpointType, string | null> }): Provider {
  const config = getConfig();
  const provider = findProviderById(config, id);
  if (!provider) {
    throw new Error(`Provider not found: ${id}`);
  }
  const merged: Provider = {
    ...provider,
    ...(updates.endpoints !== undefined ? { endpoints: updates.endpoints } : {}),
  };
  // 校验合并后的 provider
  validateProvider(merged, config.providers.indexOf(provider));
  Object.assign(provider, merged);
  saveConfig(config);
  return provider;
}

/**
 * 重命名 Provider（按 id）
 *
 * 失败抛 Error：provider 不存在 / 新名称非法 / 新名称已被占用。
 */
export function renameProvider(id: string, newName: string): Provider {
  const config = getConfig();
  if (!isValidProviderName(newName)) {
    throw new Error(`Invalid provider name: ${JSON.stringify(newName)}`);
  }
  if (PRESET_NAMES.has(newName)) {
    throw new Error('Cannot rename to a reserved preset name');
  }
  const provider = findProviderById(config, id);
  if (!provider) {
    throw new Error(`Provider not found: ${id}`);
  }
  if (provider.name === newName) {
    return provider; // 没改
  }
  const conflict = findProviderByName(config, newName);
  if (conflict) {
    throw new Error(`Provider name already exists: ${newName}`);
  }
  provider.name = newName;
  saveConfig(config);
  return provider;
}

/**
 * 删除 Provider（按 id）；不能删除最后一个。
 *
 * 失败抛 Error：provider 不存在 / 只剩一个不能删。
 */
export function deleteProvider(id: string): void {
  const config = getConfig();
  if (config.providers.length <= 1) {
    throw new Error('Cannot delete the last provider');
  }
  const idx = config.providers.findIndex(p => p.id === id);
  if (idx === -1) {
    throw new Error(`Provider not found: ${id}`);
  }
  config.providers.splice(idx, 1);
  saveConfig(config);
}
