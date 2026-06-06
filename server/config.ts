/**
 * AgentProxy 配置管理模块
 *
 * 配置文件: ~/.agentproxy/config.json
 * 支持多 API 类型分组，每个 group 多 profile 切换，运行时可修改，内存缓存 + 磁盘持久化
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { CONFIG_PATH, CONFIG_DIR, DEFAULT_PROXY_PORT, DEFAULT_WEB_PORT, DEFAULT_UPSTREAM_URLS, API_KEY_MASK_PREFIX, API_KEY_MASK_SUFFIX, DEFAULT_SERVER_HOST, LOG_DIR, MAX_LOG_FILE_SIZE, MAX_LOG_FILES, LOG_RETENTION_DAYS } from './constants.js';
import type { ApiProviderType } from './types.js';
import createDebug from 'debug';
const log = createDebug('agentproxy:config');

// ==================== 类型定义 ====================

// ApiProviderType 已移至 types.ts，此处重新导出以保持向后兼容
export type { ApiProviderType };

/**
 * 代理配置 profile
 */
export interface ProxyProfile {
  id: string;            // 简单递增 ID，如 '1', '2', '3'
  name: string;
  upstreamBaseUrl: string;
  apiKey: string;
}

/**
 * 代理分组（按 API 类型分组）
 */
export interface ProxyGroup {
  apiType: ApiProviderType;
  profiles: ProxyProfile[];
  activeProfileId: string;
}

/**
 * 全局代理配置
 */
export interface ProxyConfig {
  host: string;          // 服务器监听地址，默认 127.0.0.1
  proxyPort: number;     // 代理端口，默认 7048
  webPort: number;       // Web UI 端口，默认 7049
  groups: ProxyGroup[];
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
  groups: ProxyGroup[];
}

// 旧格式（用于数据迁移）
interface LegacyConfig {
  upstreamBaseUrl: string;
  proxyPort: number;
  apiKey: string;
}

// 中间格式（当前版本的格式）
interface MiddleFormatConfig {
  proxyPort: number;
  profiles: Array<{
    name: string;
    upstreamBaseUrl: string;
    apiKey: string;
    provider?: 'anthropic' | 'openai';
  }>;
  activeProfile: string;
}

// ==================== 常量 ====================


const DEFAULT_GROUPS: ProxyGroup[] = [
  {
    apiType: 'anthropic-messages',
    profiles: [{ id: '1', name: 'Claude 官方', upstreamBaseUrl: DEFAULT_UPSTREAM_URLS['anthropic-messages'], apiKey: '' }],
    activeProfileId: '1',
  },
  {
    apiType: 'openai-chat',
    profiles: [{ id: '1', name: 'OpenAI Chat', upstreamBaseUrl: DEFAULT_UPSTREAM_URLS['openai-chat'], apiKey: '' }],
    activeProfileId: '1',
  },
  {
    apiType: 'openai-responses',
    profiles: [{ id: '1', name: 'OpenAI Responses', upstreamBaseUrl: DEFAULT_UPSTREAM_URLS['openai-responses'], apiKey: '' }],
    activeProfileId: '1',
  },
];

const DEFAULT_CONFIG: ProxyConfig = {
  host: DEFAULT_SERVER_HOST,
  proxyPort: DEFAULT_PROXY_PORT,
  webPort: DEFAULT_WEB_PORT,
  groups: DEFAULT_GROUPS,
};

// ==================== 内存缓存 ====================

let cachedConfig: ProxyConfig | null = null;

// ==================== 工具函数 ====================

function ensureDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

/**
 * 检测是否为旧格式配置（最早的格式）
 */
function isLegacyConfig(data: unknown): data is LegacyConfig {
  return (
    typeof data === 'object' &&
    data !== null &&
    !('profiles' in data) &&
    'upstreamBaseUrl' in data
  );
}

/**
 * 旧格式迁移到新格式
 */
function migrateLegacyConfig(legacy: LegacyConfig): ProxyConfig {
  // 旧格式默认当作 anthropic-messages 类型
  return {
    host: DEFAULT_SERVER_HOST,
    proxyPort: legacy.proxyPort || DEFAULT_PROXY_PORT,
    webPort: DEFAULT_WEB_PORT,
    groups: [
      {
        apiType: 'anthropic-messages',
        profiles: [{ id: '1', name: '默认', upstreamBaseUrl: legacy.upstreamBaseUrl, apiKey: legacy.apiKey ?? '' }],
        activeProfileId: '1',
      },
      {
        apiType: 'openai-chat',
        profiles: [{ id: '1', name: 'OpenAI Chat', upstreamBaseUrl: DEFAULT_UPSTREAM_URLS['openai-chat'], apiKey: '' }],
        activeProfileId: '1',
      },
      {
        apiType: 'openai-responses',
        profiles: [{ id: '1', name: 'OpenAI Responses', upstreamBaseUrl: DEFAULT_UPSTREAM_URLS['openai-responses'], apiKey: '' }],
        activeProfileId: '1',
      },
    ],
  };
}

/**
 * 检测是否为旧的新格式配置（profiles 中包含 proxyPort）
 */
function isOldNewFormat(data: unknown): data is { profiles: Array<{ proxyPort?: number }>; activeProfile?: string } {
  return (
    typeof data === 'object' &&
    data !== null &&
    'profiles' in data &&
    Array.isArray(data.profiles) &&
    data.profiles.length > 0 &&
    'proxyPort' in data.profiles[0]
  );
}

/**
 * 迁移旧的新格式配置（profiles 中有 proxyPort）到中间格式
 */
function migrateOldNewFormat(old: { profiles: Array<{ proxyPort?: number; name?: string; upstreamBaseUrl?: string; apiKey?: string; provider?: 'anthropic' | 'openai' }>; activeProfile?: string }): MiddleFormatConfig {
  // 从第一个 profile 中提取端口，或使用默认值
  const proxyPort = old.profiles[0]?.proxyPort || DEFAULT_PROXY_PORT;

  // 移除每个 profile 中的 proxyPort
  const profiles: MiddleFormatConfig['profiles'] = old.profiles.map(({ proxyPort: _, ...rest }) => ({
    name: rest.name || '默认',
    upstreamBaseUrl: rest.upstreamBaseUrl || '',
    apiKey: rest.apiKey || '',
    provider: rest.provider,
  }));

  return {
    proxyPort,
    activeProfile: old.activeProfile || profiles[0]?.name || '默认',
    profiles,
  };
}

/**
 * 检测是否为中间格式（当前的扁平 profiles 格式）
 */
function isMiddleFormat(data: unknown): data is MiddleFormatConfig {
  return (
    typeof data === 'object' &&
    data !== null &&
    'profiles' in data &&
    'proxyPort' in data &&
    !('groups' in data)
  );
}

/**
 * 中间格式迁移到新的分组格式
 * 根据 provider 字段或 upstreamBaseUrl 判断 API 类型
 */
function migrateMiddleFormat(middle: MiddleFormatConfig): ProxyConfig {
  const groupsMap = new Map<ApiProviderType, ProxyGroup>();

  // 初始化默认 groups
  DEFAULT_GROUPS.forEach(g => {
    groupsMap.set(g.apiType, { ...g, profiles: [] });
  });

  // 遍历 profiles，根据 provider 或 upstreamBaseUrl 分类
  middle.profiles.forEach((profile, index) => {
    const id = String(index + 1);
    const newProfile: ProxyProfile = {
      id,
      name: profile.name,
      upstreamBaseUrl: profile.upstreamBaseUrl,
      apiKey: profile.apiKey,
    };

    // 判断 API 类型
    let apiType: ApiProviderType;
    if (profile.provider === 'anthropic' || profile.upstreamBaseUrl.includes('anthropic.com')) {
      apiType = 'anthropic-messages';
    } else if (profile.provider === 'openai' || profile.upstreamBaseUrl.includes('openai.com')) {
      // 默认归入 openai-chat
      apiType = 'openai-chat';
    } else {
      // 未知类型，默认归入 anthropic-messages
      apiType = 'anthropic-messages';
    }

    const group = groupsMap.get(apiType);
    if (group) {
      group.profiles.push(newProfile);
      // 如果这是激活的 profile，设置 activeProfileId
      if (profile.name === middle.activeProfile && group.profiles.length === 1) {
        group.activeProfileId = id;
      }
    }
  });

  // 确保每个 group 至少有一个默认 profile
  groupsMap.forEach(group => {
    if (group.profiles.length === 0) {
      const defaultGroup = DEFAULT_GROUPS.find(g => g.apiType === group.apiType);
      if (defaultGroup) {
        group.profiles = [{ ...defaultGroup.profiles[0] }];
      }
    }
    // 如果没有 activeProfileId 或对应的 profile 不存在，设置为第一个
    if (!group.profiles.find(p => p.id === group.activeProfileId)) {
      group.activeProfileId = group.profiles[0]?.id || '1';
    }
  });

  return {
    host: DEFAULT_SERVER_HOST,
    proxyPort: middle.proxyPort || DEFAULT_PROXY_PORT,
    webPort: DEFAULT_WEB_PORT,
    groups: Array.from(groupsMap.values()),
  };
}

/**
 * 生成下一个 profile ID
 */
function generateNextProfileId(profiles: ProxyProfile[]): string {
  if (profiles.length === 0) return '1';
  const maxId = Math.max(...profiles.map(p => parseInt(p.id, 10) || 0));
  return String(maxId + 1);
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
    host:                process.env.AGENTPROXY_HOST              || raw.host,
    proxyPort:           parseEnvNumber('AGENTPROXY_PROXY_PORT',  raw.proxyPort),
    webPort:             parseEnvNumber('AGENTPROXY_WEB_PORT',    raw.webPort),
    logDir:              process.env.AGENTPROXY_LOG_DIR           || raw.logDir             || LOG_DIR,
    logRetentionDays:    parseEnvNumber('AGENTPROXY_LOG_RETENTION_DAYS', raw.logRetentionDays ?? LOG_RETENTION_DAYS),
    maxLogFileSize:      parseEnvNumber('AGENTPROXY_MAX_LOG_FILE_SIZE',  raw.maxLogFileSize   ?? MAX_LOG_FILE_SIZE),
    maxLogFiles:         parseEnvNumber('AGENTPROXY_MAX_LOG_FILES',      raw.maxLogFiles      ?? MAX_LOG_FILES),
    groups:              raw.groups,
  };
}

/**
 * 环境变量覆盖 host（CLI --host 选项通过 AGENTPROXY_HOST 传递）
 * @deprecated 使用 resolveEffectiveConfig() 代替
 */
function applyHostOverride(config: ProxyConfig): void {
  if (!config.host) {
    config.host = DEFAULT_SERVER_HOST;
  }
  if (process.env.AGENTPROXY_HOST) {
    config.host = process.env.AGENTPROXY_HOST;
  }
}

/**
 * 加载配置（从磁盘读取）
 */
export function loadConfig(): ProxyConfig {
  try {
    if (existsSync(CONFIG_PATH)) {
      const raw = readFileSync(CONFIG_PATH, 'utf-8');
      const parsed = JSON.parse(raw);

      if (isLegacyConfig(parsed)) {
        const migrated = migrateLegacyConfig(parsed);
        saveConfig(migrated);
        log('迁移旧格式配置 (legacy)');
        cachedConfig = migrated;
        applyHostOverride(cachedConfig);
        return cachedConfig;
      }

      if (isOldNewFormat(parsed)) {
        const middle = migrateOldNewFormat(parsed);
        const migrated = migrateMiddleFormat(middle);
        saveConfig(migrated);
        log('迁移旧的新格式配置 (old-new)');
        cachedConfig = migrated;
        applyHostOverride(cachedConfig);
        return cachedConfig;
      }

      if (isMiddleFormat(parsed)) {
        const migrated = migrateMiddleFormat(parsed);
        saveConfig(migrated);
        log('迁移中间格式配置 (middle)');
        cachedConfig = migrated;
        applyHostOverride(cachedConfig);
        return cachedConfig;
      }

      if ('groups' in parsed && 'proxyPort' in parsed) {
        cachedConfig = parsed as ProxyConfig;
        applyHostOverride(cachedConfig);
        return cachedConfig;
      }
    }
  } catch (error) {
    log('加载配置失败，使用默认值: %O', error);
  }

  cachedConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as ProxyConfig;
  applyHostOverride(cachedConfig);
  return cachedConfig;
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
 */
export function saveConfig(config: ProxyConfig): ProxyConfig {
  ensureDir();
  cachedConfig = config;
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
  log('配置已保存: %d groups, host=%s, proxyPort=%d', config.groups.length, config.host, config.proxyPort);
  return config;
}

/**
 * 根据 API 类型获取分组
 */
export function getGroupByApiType(apiType: ApiProviderType): ProxyGroup | null {
  const config = getConfig();
  return config.groups.find(g => g.apiType === apiType) || null;
}

/**
 * 获取指定 API 类型的激活 profile
 */
export function getActiveProfileForApiType(apiType: ApiProviderType): ProxyProfile | null {
  const group = getGroupByApiType(apiType);
  if (!group) return null;

  const profile = group.profiles.find(p => p.id === group.activeProfileId);
  if (profile) return profile;

  // activeProfileId 不存在但有 profiles，取第一个
  if (group.profiles.length > 0) {
    return group.profiles[0];
  }

  return null;
}

/**
 * 切换指定 API 类型的激活 profile
 */
export function setActiveProfile(apiType: ApiProviderType, profileId: string): ProxyConfig | null {
  const config = getConfig();
  const group = config.groups.find(g => g.apiType === apiType);
  if (!group) return null;

  const exists = group.profiles.some(p => p.id === profileId);
  if (!exists) return null;

  group.activeProfileId = profileId;
  return saveConfig(config);
}

/**
 * 创建新 profile（指定 API 类型）
 */
export function createProfile(apiType: ApiProviderType, profile: Omit<ProxyProfile, 'id'>): ProxyConfig | null {
  const config = getConfig();
  const group = config.groups.find(g => g.apiType === apiType);
  if (!group) return null;

  // 检查名称是否重复
  const exists = group.profiles.some(p => p.name === profile.name);
  if (exists) return null;

  const newProfile: ProxyProfile = {
    ...profile,
    id: generateNextProfileId(group.profiles),
  };

  group.profiles.push(newProfile);
  return saveConfig(config);
}

/**
 * 更新 profile（指定 API 类型）
 */
export function updateProfile(apiType: ApiProviderType, profileId: string, updates: Partial<Omit<ProxyProfile, 'id'>>): ProxyConfig | null {
  const config = getConfig();
  const group = config.groups.find(g => g.apiType === apiType);
  if (!group) return null;

  const idx = group.profiles.findIndex(p => p.id === profileId);
  if (idx === -1) return null;

  // 不允许改 name 本身（如需改名用 renameProfile）
  group.profiles[idx] = {
    ...group.profiles[idx],
    ...updates,
    id: profileId, // 保持原 id 不变
    name: group.profiles[idx].name, // 保持原 name 不变
  };
  return saveConfig(config);
}

/**
 * 重命名 profile（指定 API 类型）
 */
export function renameProfile(apiType: ApiProviderType, profileId: string, newName: string): ProxyConfig | null {
  const config = getConfig();
  const group = config.groups.find(g => g.apiType === apiType);
  if (!group) return null;

  // 检查新名称是否重复
  if (group.profiles.some(p => p.name === newName)) return null;

  const idx = group.profiles.findIndex(p => p.id === profileId);
  if (idx === -1) return null;

  group.profiles[idx].name = newName;
  return saveConfig(config);
}

/**
 * 删除 profile（指定 API 类型，不能删除最后一个）
 */
export function deleteProfile(apiType: ApiProviderType, profileId: string): ProxyConfig | null {
  const config = getConfig();
  const group = config.groups.find(g => g.apiType === apiType);
  if (!group) return null;

  if (group.profiles.length <= 1) return null;

  const filtered = group.profiles.filter(p => p.id !== profileId);
  if (filtered.length < group.profiles.length) {
    group.profiles = filtered;
    if (group.activeProfileId === profileId) {
      group.activeProfileId = group.profiles[0].id;
    }
  }
  return saveConfig(config);
}

/**
 * 脱敏配置（用于 API 返回，不暴露完整 apiKey）
 */
export function getSafeConfig() {
  const config = getConfig();
  return {
    host: config.host,
    proxyPort: config.proxyPort,
    webPort: config.webPort,
    groups: config.groups.map(group => ({
      apiType: group.apiType,
      activeProfileId: group.activeProfileId,
      profiles: group.profiles.map(p => ({
        id: p.id,
        name: p.name,
        upstreamBaseUrl: p.upstreamBaseUrl,
        apiKeySet: p.apiKey.length > 0,
        apiKeyPreview: p.apiKey
          ? p.apiKey.slice(0, API_KEY_MASK_PREFIX) + '****' + p.apiKey.slice(-API_KEY_MASK_SUFFIX)
          : '',
      })),
    })),
  };
}
