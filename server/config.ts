/**
 * AgentProxy 配置管理模块
 *
 * 配置文件: ~/.agentproxy/config.json
 * 支持多 profile 切换，运行时可修改，内存缓存 + 磁盘持久化
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ==================== 类型定义 ====================

export interface ProxyProfile {
  name: string;
  upstreamBaseUrl: string;
  apiKey: string;
}

export interface ProxyConfig {
  proxyPort: number; // 全局代理端口
  profiles: ProxyProfile[];
  activeProfile: string; // UI 记忆上次选择的 profile
}

// 旧格式（用于数据迁移）
interface LegacyConfig {
  upstreamBaseUrl: string;
  proxyPort: number;
  apiKey: string;
}

// ==================== 常量 ====================

const CONFIG_PATH = join(homedir(), '.agentproxy', 'config.json');

const DEFAULT_CONFIG: ProxyConfig = {
  proxyPort: 7048,
  activeProfile: 'Claude 官方',
  profiles: [
    {
      name: 'Claude 官方',
      upstreamBaseUrl: 'https://api.anthropic.com',
      apiKey: '',
    },
  ],
};

// ==================== 内存缓存 ====================

let cachedConfig: ProxyConfig | null = null;

// ==================== 工具函数 ====================

function ensureDir(): void {
  const dir = join(homedir(), '.agentproxy');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * 检测是否为旧格式配置
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
  return {
    proxyPort: legacy.proxyPort || 7048,
    activeProfile: '默认',
    profiles: [
      {
        name: '默认',
        upstreamBaseUrl: legacy.upstreamBaseUrl,
        apiKey: legacy.apiKey ?? '',
      },
    ],
  };
}

// ==================== 核心 API ====================

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
 * 迁移旧的新格式配置（profiles 中有 proxyPort）到新格式
 */
function migrateOldNewFormat(old: { profiles: Array<{ proxyPort?: number }>; activeProfile?: string }): ProxyConfig {
  // 从第一个 profile 中提取端口，或使用默认值
  const proxyPort = old.profiles[0]?.proxyPort || 7048;

  // 移除每个 profile 中的 proxyPort
  const profiles = old.profiles.map(({ proxyPort: _, ...rest }) => rest);

  return {
    proxyPort,
    activeProfile: old.activeProfile || profiles[0]?.name || '默认',
    profiles,
  };
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
        // 自动保存迁移后的新格式
        saveConfig(migrated);
        console.log('[Config] 旧配置已迁移到新格式');
        cachedConfig = migrated;
        return cachedConfig;
      }

      if (isOldNewFormat(parsed)) {
        const migrated = migrateOldNewFormat(parsed);
        // 自动保存迁移后的新格式
        saveConfig(migrated);
        console.log('[Config] 旧的新格式配置已迁移（proxyPort 移到全局）');
        cachedConfig = migrated;
        return cachedConfig;
      }

      if ('profiles' in parsed && 'proxyPort' in parsed) {
        cachedConfig = parsed as ProxyConfig;
        return cachedConfig;
      }
    }
  } catch (error) {
    console.error('[Config] 加载配置失败，使用默认值:', error);
  }

  cachedConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as ProxyConfig;
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
  console.log('[Config] 配置已保存, 当前 profile:', config.activeProfile);
  return config;
}

/**
 * 获取当前激活的 profile
 */
export function getActiveProfile(): ProxyProfile | null {
  const config = getConfig();
  const profile = config.profiles.find(p => p.name === config.activeProfile);
  if (profile) return profile;

  // activeProfile 不存在但有 profiles，取第一个
  if (config.profiles.length > 0) {
    return config.profiles[0];
  }

  return null;
}

/**
 * 切换激活的 profile
 */
export function setActiveProfile(name: string): ProxyConfig | null {
  const config = getConfig();
  const exists = config.profiles.some(p => p.name === name);
  if (!exists) return null;

  config.activeProfile = name;
  return saveConfig(config);
}

/**
 * 创建新 profile
 */
export function createProfile(profile: ProxyProfile): ProxyConfig | null {
  const config = getConfig();
  const exists = config.profiles.some(p => p.name === profile.name);
  if (exists) return null;

  config.profiles.push(profile);
  return saveConfig(config);
}

/**
 * 更新 profile
 */
export function updateProfile(name: string, updates: Partial<ProxyProfile>): ProxyConfig | null {
  const config = getConfig();
  const idx = config.profiles.findIndex(p => p.name === name);
  if (idx === -1) return null;

  // 不允许改 name 本身
  config.profiles[idx] = {
    ...config.profiles[idx],
    ...updates,
    name, // 保持原 name 不变
  };
  return saveConfig(config);
}

/**
 * 重命名 profile
 */
export function renameProfile(oldName: string, newName: string): ProxyConfig | null {
  const config = getConfig();
  if (config.profiles.some(p => p.name === newName)) return null;

  const idx = config.profiles.findIndex(p => p.name === oldName);
  if (idx === -1) return null;

  config.profiles[idx].name = newName;
  if (config.activeProfile === oldName) {
    config.activeProfile = newName;
  }
  return saveConfig(config);
}

/**
 * 删除 profile（不能删除最后一个）
 */
export function deleteProfile(name: string): ProxyConfig | null {
  const config = getConfig();
  if (config.profiles.length <= 1) return null;

  const filtered = config.profiles.filter(p => p.name !== name);
  if (filtered.length < config.profiles.length) {
    config.profiles = filtered;
    if (config.activeProfile === name) {
      config.activeProfile = config.profiles[0].name;
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
    proxyPort: config.proxyPort,
    activeProfile: config.activeProfile,
    profiles: config.profiles.map(p => ({
      name: p.name,
      upstreamBaseUrl: p.upstreamBaseUrl,
      apiKeySet: p.apiKey.length > 0,
      apiKeyPreview: p.apiKey
        ? p.apiKey.slice(0, 8) + '****' + p.apiKey.slice(-4)
        : '',
    })),
  };
}
