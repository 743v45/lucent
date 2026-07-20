/**
 * Lucent 配置管理模块
 *
 * 配置文件: ~/.lucent/config.json
 * 多供应商 + 多端点结构，运行时可修改，内存缓存 + 磁盘持久化
 */

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { CONFIG_PATH, CONFIG_DIR, DEFAULT_PROXY_PORT, DEFAULT_WEB_PORT, DEFAULT_SERVER_HOST, LOG_DIR, DB_PATH, LOG_RETENTION_DAYS, TEMP_LOG_TTL_MINUTES } from './constants.js';
import { ENDPOINT_TYPES, isEndpointType, isValidProviderName, PRESET_NAMES } from './types.js';
import type { EndpointType, Provider, BodyRewriteRule } from './types.js';
import { parseFieldPath } from './body-rewriter.js';
import createDebug from 'debug';
const log = createDebug('lucent:config');

// ==================== 类型定义 ====================

/** 日志记录模式：off=只过路不记 / temporary=临时落库（带 TTL，到期自动删）/ archive=存档（按保留期清理） */
export type LogMode = 'off' | 'temporary' | 'archive';

const LOG_MODES: ReadonlySet<LogMode> = new Set(['off', 'temporary', 'archive']);

/** 类型守卫：字符串是否为合法 LogMode */
function isLogMode(s: unknown): s is LogMode {
  return typeof s === 'string' && (LOG_MODES as Set<string>).has(s);
}

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
  dbPath?: string;
  logRetentionDays?: number;
  /** 可选：全局请求 body 重写规则（opt-in，缺省视为无规则，代理保持透明） */
  bodyRewrites?: BodyRewriteRule[];
  /**
   * 日志记录模式（缺省视为 'archive'，保持现状全量记录）。env LUCENT_LOG_MODE 覆盖。
   * 旧字段 logRecording 已废弃：读取时映射 true→archive / false→off（见 loadConfig）。
   */
  logMode?: LogMode;
  /** 临时模式 TTL（分钟）；仅 logMode=temporary 时写入的日志带此到期时间。env LUCENT_TEMP_LOG_TTL_MINUTES 覆盖。 */
  tempLogTtlMinutes?: number;
  /** @deprecated 已被 logMode 取代，仅为向后兼容旧 config.json 保留（loadConfig 映射后清除） */
  logRecording?: boolean;
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
  providers: Provider[];
  /** SQLite 数据库路径（env LUCENT_DB_PATH 覆盖） */
  dbPath: string;
  /** 日志记录模式（env LUCENT_LOG_MODE 覆盖，缺省 'archive'） */
  logMode: LogMode;
  /** 临时模式 TTL 分钟（env LUCENT_TEMP_LOG_TTL_MINUTES 覆盖，缺省 TEMP_LOG_TTL_MINUTES） */
  tempLogTtlMinutes: number;
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
          // baseUrl 必须含 /v1，与 presets.ts 对齐；proxy.ts 假设 baseUrl 已含版本路径
          'anthropic-messages': 'https://api.anthropic.com/v1',
        },
      },
    ],
    // 示例：脱敏 Claude Code system prompt 里的 billing header（默认禁用，仅作模板）
    // ⚠️ 启用后会使上游 KV-Cache 失效（system[0].text 通常带 cache_control 断点，Anthropic 按字节寻址）
    bodyRewrites: [
      {
        id: 'example-redact-billing-header',
        name: '示例：脱敏 billing header',
        enabled: false,
        fieldPath: 'system[0].text',
        pattern: 'x-anthropic-billing-header:[^;]*;[^;]*;?',
        replacement: '',
      },
    ],
    // 默认存档模式（全量记录、按保留期清理）。env LUCENT_LOG_MODE 覆盖。
    logMode: 'archive',
    // 临时模式默认 TTL（分钟）；仅 logMode=temporary 时生效。env LUCENT_TEMP_LOG_TTL_MINUTES 覆盖。
    tempLogTtlMinutes: TEMP_LOG_TTL_MINUTES,
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
 * 深克隆配置（纯 JSON 可序列化结构，structuredClone 安全保留类型）。
 *
 * 用途：CRUD 写入前基于克隆构造新对象，再整体替换 cachedConfig——
 * 避免就地 mutate 由 getConfig() 返回的共享缓存引用。
 * 一旦 saveConfig 因磁盘满/EACCES 抛错，缓存引用仍为旧值，不与磁盘分叉。
 */
function cloneConfig(config: ProxyConfig): ProxyConfig {
  return structuredClone(config);
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
 * bodyRewrites 规则允许的键（禁未知键，防拼错字段名静默失效）
 */
const BODY_REWRITE_KEYS = new Set(['id', 'name', 'enabled', 'fieldPath', 'pattern', 'flags', 'replacement']);

/**
 * 校验 bodyRewrites 数组（可选字段，缺失视为无规则）。
 *
 * 严格校验（镜像 validateProvider 的严格度）：
 * - 必须是数组；每条必须是非 null 对象
 * - 禁未知键（白名单 id/name/enabled/fieldPath/pattern/flags/replacement）
 * - id/fieldPath/pattern 必填且为非空 string；replacement 必须是 string（允许空串）
 * - fieldPath 必须能被 parseFieldPath 成功解析
 * - pattern 必须能 new RegExp(pattern, flags ?? 'g') 构造成功
 * - flags 若存在必须匹配 /^[gimsuy]*$/
 *
 * 失败抛 Error，信息带规则 id（或索引）便于定位。
 */
export function validateBodyRewrites(raw: unknown): asserts raw is BodyRewriteRule[] {
  if (!Array.isArray(raw)) {
    throw new Error('bodyRewrites must be an array');
  }
  raw.forEach((rule, i) => {
    if (!rule || typeof rule !== 'object') {
      throw new Error(`bodyRewrites[${i}] is not an object`);
    }
    const r = rule as Record<string, unknown>;
    // 禁未知键
    for (const key of Object.keys(r)) {
      if (!BODY_REWRITE_KEYS.has(key)) {
        throw new Error(`bodyRewrites[${i}] has unknown key: ${key}`);
      }
    }
    const ruleId = typeof r.id === 'string' ? r.id : `bodyRewrites[${i}]`;
    if (typeof r.id !== 'string' || r.id.length === 0) {
      throw new Error(`bodyRewrites[${i}].id must be a non-empty string`);
    }
    if (r.name !== undefined && typeof r.name !== 'string') {
      throw new Error(`bodyRewrites[id=${ruleId}].name must be a string`);
    }
    if (r.enabled !== undefined && typeof r.enabled !== 'boolean') {
      throw new Error(`bodyRewrites[id=${ruleId}].enabled must be a boolean`);
    }
    if (typeof r.fieldPath !== 'string' || r.fieldPath.length === 0) {
      throw new Error(`bodyRewrites[id=${ruleId}].fieldPath must be a non-empty string`);
    }
    try {
      parseFieldPath(r.fieldPath);
    } catch (e) {
      throw new Error(`bodyRewrites[id=${ruleId}].fieldPath invalid: ${(e as Error).message}`);
    }
    if (r.flags !== undefined) {
      if (typeof r.flags !== 'string' || !/^[gimsuy]*$/.test(r.flags)) {
        throw new Error(`bodyRewrites[id=${ruleId}].flags must match /^[gimsuy]*$/`);
      }
    }
    if (typeof r.pattern !== 'string' || r.pattern.length === 0) {
      throw new Error(`bodyRewrites[id=${ruleId}].pattern must be a non-empty string`);
    }
    try {
      new RegExp(r.pattern, typeof r.flags === 'string' ? r.flags : 'g');
    } catch (e) {
      throw new Error(`bodyRewrites[id=${ruleId}].pattern invalid: ${(e as Error).message}`);
    }
    if (typeof r.replacement !== 'string') {
      throw new Error(`bodyRewrites[id=${ruleId}].replacement must be a string`);
    }
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
  if (c.bodyRewrites !== undefined) {
    validateBodyRewrites(c.bodyRewrites);
  }
  // logMode 三态白名单（缺省视为 'archive'，向后兼容老 config.json）
  if (c.logMode !== undefined && !isLogMode(c.logMode)) {
    throw new Error(`config.logMode must be one of off|temporary|archive, got: ${JSON.stringify(c.logMode)}`);
  }
  // tempLogTtlMinutes 正整数（缺省视为默认值）
  if (c.tempLogTtlMinutes !== undefined && (typeof c.tempLogTtlMinutes !== 'number' || !Number.isInteger(c.tempLogTtlMinutes) || c.tempLogTtlMinutes < 0)) {
    throw new Error('config.tempLogTtlMinutes must be a non-negative integer');
  }
  // logRetentionDays 正整数（缺省视为默认值）
  if (c.logRetentionDays !== undefined && (typeof c.logRetentionDays !== 'number' || !Number.isInteger(c.logRetentionDays) || c.logRetentionDays < 1)) {
    throw new Error('config.logRetentionDays must be a positive integer');
  }
  // 旧字段 logRecording（deprecated 读兼容）：允许存在，由 loadConfig 映射到 logMode
  if (c.logRecording !== undefined && typeof c.logRecording !== 'boolean') {
    throw new Error('config.logRecording must be a boolean (deprecated, use logMode)');
  }
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
 * 解析环境变量中的布尔值：未设置（或设为空串）返回 fallback；
 * 显式 falsey 词（'false'/'0'/'no'/'off'，忽略大小写与空白）为 false，其余为 true。
 * 空串视为「没真设」→ 走 fallback（对记录开关即默认开），避免误设静默关掉日志。
 */
function parseEnvBool(name: string, fallback: boolean): boolean {
  const val = process.env[name];
  if (val === undefined || val.trim() === '') return fallback;
  const s = val.trim().toLowerCase();
  if (s === 'false' || s === '0' || s === 'no' || s === 'off') return false;
  return true;
}

/**
 * 解析 logMode 有效值。优先级：
 *   LUCENT_LOG_MODE > LUCENT_LOG_RECORDING(兼容) > config.logMode > config.logRecording(兼容) > 默认 'archive'
 * 兼容映射：旧 LUCENT_LOG_RECORDING / config.logRecording 的 true→archive / false→off（无法表达 temporary）。
 * 非法 env 值回退到下一优先级，不抛错（防拼错让进程起不来）。
 */
function resolveLogModeFromEnv(raw: ProxyConfig): LogMode {
  // 1. LUCENT_LOG_MODE（三态主入口）
  const envMode = process.env.LUCENT_LOG_MODE;
  if (envMode !== undefined && envMode.trim() !== '') {
    const s = envMode.trim().toLowerCase();
    if (isLogMode(s)) return s;
  }
  // 2. LUCENT_LOG_RECORDING（兼容布尔）
  if (process.env.LUCENT_LOG_RECORDING !== undefined && process.env.LUCENT_LOG_RECORDING.trim() !== '') {
    return parseEnvBool('LUCENT_LOG_RECORDING', true) ? 'archive' : 'off';
  }
  // 3. config.logMode（loadConfig 已把旧 logRecording 归一化进来）
  if (isLogMode(raw.logMode)) return raw.logMode;
  // 4. 兜底
  return 'archive';
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
    dbPath:              process.env.LUCENT_DB_PATH            || raw.dbPath             || DB_PATH,
    logRetentionDays:    parseEnvNumber('LUCENT_LOG_RETENTION_DAYS', raw.logRetentionDays ?? LOG_RETENTION_DAYS),
    logMode:             resolveLogModeFromEnv(raw),
    tempLogTtlMinutes:   parseEnvNumber('LUCENT_TEMP_LOG_TTL_MINUTES', raw.tempLogTtlMinutes ?? TEMP_LOG_TTL_MINUTES),
    providers:           raw.providers,
  };
}

/**
 * 运行时读取 logMode 有效值（env 覆盖 > 配置文件 > 默认 'archive'）。
 * 每次实时解析，反映 toggle 改动——热路径（writeLogEntry）门控用。
 */
export function getLogMode(): LogMode {
  return resolveLogModeFromEnv(getConfig());
}

/**
 * 运行时读取临时 TTL 有效值（分钟）：env LUCENT_TEMP_LOG_TTL_MINUTES > config.tempLogTtlMinutes > 默认 TEMP_LOG_TTL_MINUTES。
 * 每次实时解析，反映 InputNumber 改动——热路径（writeLogEntry 临时注入 expiresAt）用。
 * 非法/缺省值回退到下一级；env 锁定时 config 改动不生效（与 logMode 同语义）。
 */
export function getTempTtlMinutes(): number {
  const envVal = parseEnvNumber('LUCENT_TEMP_LOG_TTL_MINUTES', NaN);
  if (Number.isInteger(envVal) && envVal >= 0) return envVal;
  const cfg = getConfig().tempLogTtlMinutes;
  if (cfg !== undefined && Number.isInteger(cfg) && cfg >= 0) return cfg;
  return TEMP_LOG_TTL_MINUTES;
}

/**
 * 运行时读取存档保留期有效值（天）：env LUCENT_LOG_RETENTION_DAYS > config.logRetentionDays > 默认 LOG_RETENTION_DAYS。
 * 每次实时解析，反映 UI 改动——cleanupOldLogs 热路径用（不得读启动快照）。
 */
export function getRetentionDays(): number {
  const envVal = parseEnvNumber('LUCENT_LOG_RETENTION_DAYS', NaN);
  if (Number.isInteger(envVal) && envVal >= 1) return envVal;
  const cfg = getConfig().logRetentionDays;
  if (cfg !== undefined && Number.isInteger(cfg) && cfg >= 1) return cfg;
  return LOG_RETENTION_DAYS;
}

/**
 * 环境变量是否锁定 logMode（LUCENT_LOG_MODE 或兼容的 LUCENT_LOG_RECORDING 任一已设置）。
 * 设置时 toggle 写入的 config 值不立即生效，UI 应禁用切换。
 */
export function logModeEnvOverridden(): boolean {
  return process.env.LUCENT_LOG_MODE !== undefined || process.env.LUCENT_LOG_RECORDING !== undefined;
}

/**
 * 设置 logMode（可选同时更新临时 TTL）并持久化到 config.json。
 * env 锁定时：config.logMode 仍写入（保留用户意图，env 去掉后生效），
 * 但返回的 logMode 是 env 决定的有效值，envLocked=true 供调用方提示用户。
 */
export function setLogMode(mode: LogMode, tempTtlMinutes?: number): { logMode: LogMode; envLocked: boolean } {
  if (!isLogMode(mode)) throw new Error(`Invalid logMode: ${JSON.stringify(mode)}`);
  // 基于克隆再 mutate：写盘失败时不污染共享缓存
  const config = cloneConfig(getConfig());
  config.logMode = mode;
  delete config.logRecording; // 归一化：落盘只保留 logMode，旧字段自然消亡
  if (tempTtlMinutes !== undefined) {
    if (!Number.isInteger(tempTtlMinutes) || tempTtlMinutes < 1) throw new Error('tempTtlMinutes must be a positive integer');
    config.tempLogTtlMinutes = tempTtlMinutes;
  }
  saveConfig(config);
  return { logMode: getLogMode(), envLocked: logModeEnvOverridden() };
}

/**
 * 设置存档保留期（天）并持久化到 config.json。env 锁定时 config 仍写入（保留意图），
 * 但有效值由 env 决定、envLocked=true。
 */
export function setRetentionDays(days: number): { retentionDays: number; envLocked: boolean } {
  if (!Number.isInteger(days) || days < 1) throw new Error('retentionDays must be a positive integer');
  const config = cloneConfig(getConfig());
  config.logRetentionDays = days;
  saveConfig(config);
  return { retentionDays: getRetentionDays(), envLocked: process.env.LUCENT_LOG_RETENTION_DAYS !== undefined };
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
 * - 文件存在但 JSON 解析失败或校验失败 → 先把损坏文件备份为 config.json.bak，再写默认配置
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
    // 向后兼容：旧 config.json 只有 logRecording 没 logMode，映射 true→archive / false→off
    if (parsed.logMode === undefined && parsed.logRecording !== undefined) {
      parsed.logMode = parsed.logRecording ? 'archive' : 'off';
      delete parsed.logRecording;
    }
    cachedConfig = parsed;
    applyHostOverride(cachedConfig);
    return cachedConfig;
  } catch (error) {
    // 配置损坏：先把原文件备份为 .bak（用户配置不丢失），再写默认配置
    try {
      copyFileSync(CONFIG_PATH, `${CONFIG_PATH}.bak`);
      log('损坏的配置文件已备份: %s', `${CONFIG_PATH}.bak`);
    } catch (backupErr) {
      log('备份损坏配置文件失败（继续覆盖）: %O', backupErr);
    }
    log('配置文件无效，已备份原文件并重置为默认配置: %O', error);
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
 * 保存配置（写磁盘 + 更新缓存）
 *
 * 顺序严格为：校验 → 原子写盘 → 成功后才提交 cachedConfig。
 * - 原子写：先 writeFileSync 到 `${CONFIG_PATH}.tmp` 再 renameSync 覆盖（POSIX rename 原子），
 *   避免 truncate+write 中途崩溃/掉电留下半截 JSON 损坏配置。
 * - 缓存延后提交：写盘失败（磁盘满/EACCES 等）时直接向上抛错，cachedConfig 保持旧值不被污染，
 *   保证此后 getConfig() 返回的内存态与磁盘一致（路由层据此返回 500）。
 *   配合 CRUD 层的 cloneConfig，校验已过但写盘失败也不会留下从未持久化的内存态。
 *
 * 写入前会做完整校验，校验失败会抛出 Error，不会写入坏数据。
 */
export function saveConfig(config: ProxyConfig): ProxyConfig {
  validateConfig(config);
  ensureDir();
  // 原子写：先写 .tmp 再 rename 覆盖（同目录 rename 保证同一文件系统，POSIX 原子）
  const tmpPath = `${CONFIG_PATH}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(config, null, 2), 'utf-8');
  renameSync(tmpPath, CONFIG_PATH);
  // 写盘成功后才提交缓存——失败则向上抛错，缓存保持旧值不污染
  cachedConfig = config;
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
  const config = cloneConfig(getConfig());
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
  const config = cloneConfig(getConfig());
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
  const config = cloneConfig(getConfig());
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
  const config = cloneConfig(getConfig());
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

// ==================== BodyRewrite CRUD ====================

/**
 * 获取全部 body 重写规则
 */
export function getBodyRewrites(): BodyRewriteRule[] {
  return getConfig().bodyRewrites ?? [];
}

/**
 * 新增一条 body 重写规则（自动生成 id）
 *
 * 失败抛 Error：fieldPath 非法 / pattern 非法正则 / 未知键 / flags 非法（信息带定位）。
 */
export function addBodyRewrite(input: Omit<BodyRewriteRule, 'id'>): BodyRewriteRule {
  const config = cloneConfig(getConfig());
  const newRule: BodyRewriteRule = { id: randomUUID(), ...input };
  const list = [...(config.bodyRewrites ?? []), newRule];
  validateBodyRewrites(list);
  config.bodyRewrites = list;
  saveConfig(config);
  return newRule;
}

/**
 * 更新一条 body 重写规则（按 id），id 不可改。
 *
 * 失败抛 Error：规则不存在 / 校验失败。
 */
export function updateBodyRewrite(id: string, patch: Partial<Omit<BodyRewriteRule, 'id'>>): BodyRewriteRule {
  const config = cloneConfig(getConfig());
  const list = config.bodyRewrites ?? [];
  const idx = list.findIndex(r => r.id === id);
  if (idx === -1) {
    throw new Error(`Body rewrite rule not found: ${id}`);
  }
  const updated: BodyRewriteRule = { ...list[idx], ...patch, id };
  list[idx] = updated;
  validateBodyRewrites(list);
  config.bodyRewrites = list;
  saveConfig(config);
  return updated;
}

/**
 * 删除一条 body 重写规则（按 id）
 *
 * 失败抛 Error：规则不存在。
 */
export function deleteBodyRewrite(id: string): void {
  const config = cloneConfig(getConfig());
  const list = config.bodyRewrites ?? [];
  const idx = list.findIndex(r => r.id === id);
  if (idx === -1) {
    throw new Error(`Body rewrite rule not found: ${id}`);
  }
  list.splice(idx, 1);
  config.bodyRewrites = list;
  saveConfig(config);
}
