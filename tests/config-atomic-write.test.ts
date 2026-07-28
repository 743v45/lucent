/**
 * config 持久化数据完整性单测（DB 后端）
 *
 * 配置已入库（config 表，单行 JSON blob）。验证 server/config.ts 的 saveConfig：
 * ① 落库：saveConfig 把配置写进 SQLite config 表（事务原子——better-sqlite3 transaction 保证
 *    整体生效或整体不变，替代旧的 tmp+rename 文件原子写）。
 * ② 写库失败不污染缓存：writeConfigJson 抛错时，getConfig() 仍返回旧值、库仍是旧值，且 saveConfig rethrow。
 * ③ CRUD 基于克隆：createProvider 写库失败时，缓存里的 providers 不被就地 push 污染（证明 cloneConfig 生效）。
 *
 * 手法：vi.mock 部分模拟 config-store——readConfigJson 用真实实现（读 tmpdir 库），
 * writeConfigJson 可注入失败；每用例 vi.resetModules + 动态 import 拿全新模块（重置 cachedConfig），
 * LUCENT_CONFIG_DIR 指向 tmpdir（→ tmpdir/lucent.db），避免污染真实 ~/.lucent。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { ProxyConfig } from '../server/config.js';

// vi.mock 工厂在 import 之前执行，用 vi.hoisted 暴露可变状态。
const storeMock = vi.hoisted(() => ({
  writeError: null as Error | null,
}));

// 部分模拟 config-store：readConfigJson 用真实实现（读 tmpdir 库），writeConfigJson 可注入失败。
vi.mock('../server/services/config-store.js', async (importOriginal) => {
  const actual = await importOriginal() as typeof import('../server/services/config-store.js');
  return {
    ...actual,
    writeConfigJson: (data: unknown) => {
      if (storeMock.writeError) throw storeMock.writeError;
      return actual.writeConfigJson(data);
    },
  };
});

let configDir: string;
let savedConfigDir: string | undefined;
let savedDbPath: string | undefined;
const DB_NAME = 'lucent.db';

beforeEach(() => {
  // 全新 tmpdir；在动态 import 前设置 env。
  // 关键：设 LUCENT_DB_PATH 指向本用例库——resolveConfigDbPath 运行时读 env，绕开 constants 的模块级缓存，
  // 保证 config-store 写的库与 readStoredConfig 读的库是同一个，跨用例不串。
  configDir = mkdtempSync(join(tmpdir(), 'lucent-config-atomic-'));
  savedConfigDir = process.env.LUCENT_CONFIG_DIR;
  process.env.LUCENT_CONFIG_DIR = configDir;
  savedDbPath = process.env.LUCENT_DB_PATH;
  process.env.LUCENT_DB_PATH = join(configDir, DB_NAME);
  storeMock.writeError = null;
  vi.resetModules(); // 清 config 模块缓存（cachedConfig 归零）；测试体内动态 import 拿全新实例
});

afterEach(() => {
  if (savedConfigDir === undefined) delete process.env.LUCENT_CONFIG_DIR;
  else process.env.LUCENT_CONFIG_DIR = savedConfigDir;
  if (savedDbPath === undefined) delete process.env.LUCENT_DB_PATH;
  else process.env.LUCENT_DB_PATH = savedDbPath;
  rmSync(configDir, { recursive: true, force: true });
});

const dbPath = () => join(configDir, DB_NAME);

/** 直读 config 表（只读连接），返回解析后的对象或 null */
function readStoredConfig(): Record<string, unknown> | null {
  const db = new Database(dbPath(), { readonly: true, fileMustExist: true });
  try {
    const row = db.prepare('SELECT data FROM config WHERE id = 1').get() as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as Record<string, unknown>) : null;
  } finally {
    db.close();
  }
}

describe('saveConfig — DB 事务 + 缓存一致性', () => {
  it('① saveConfig 把配置落进 SQLite config 表（事务原子）', async () => {
    const mod = await import('../server/config.js');
    const cfg = mod.loadConfig(); // 空 DB → bootstrap 默认配置（写 config 表）
    cfg.webPort = 9999;
    mod.saveConfig(cfg);

    // 库里 config 行已更新为新值
    const stored = readStoredConfig();
    expect(stored).not.toBeNull();
    expect(stored!.webPort).toBe(9999);
    // getConfig 与库一致
    expect(mod.getConfig().webPort).toBe(9999);
  });

  it('② writeConfigJson 失败时不污染缓存且 rethrow：getConfig() 与库都仍是旧值', async () => {
    const mod = await import('../server/config.js');
    const baseline = mod.loadConfig(); // 默认 logMode 'archive'
    expect(baseline.logMode).toBe('archive');

    // 构造一份改过的配置（克隆，不就地 mutate baseline）
    const modified: ProxyConfig = structuredClone(baseline);
    modified.logMode = 'off';

    storeMock.writeError = new Error('mock db write EACCES');
    // writeConfigJson 抛错 → saveConfig 向上 rethrow
    expect(() => mod.saveConfig(modified)).toThrow(/mock db write EACCES/);

    // 缓存未被提交：getConfig() 仍返回 baseline 的值
    expect(mod.getConfig().logMode).toBe('archive');
    // 库也未被改写（bootstrap 写入的 archive）
    expect(readStoredConfig()!.logMode).toBe('archive');
  });

  it('③ CRUD 基于克隆：createProvider 写库失败时不就地污染缓存 providers', async () => {
    const mod = await import('../server/config.js');
    const baseline = mod.loadConfig(); // 默认 1 个 provider（anthropic）
    expect(baseline.providers).toHaveLength(1);
    expect(baseline.providers.map(p => p.name)).toEqual(['anthropic']);

    storeMock.writeError = new Error('mock db write EACCES');
    // createProvider 内部 cloneConfig → push 到克隆 → saveConfig 写库失败抛错
    expect(() => mod.createProvider({
      name: 'z-test-extra',
      endpoints: {
        'openai-chat': 'https://example.com/v1',
        'openai-responses': null,
        'anthropic-messages': null,
      },
    })).toThrow(/mock db write EACCES/);

    // 关键：修复前会就地 push 到 cachedConfig，缓存会变成 2 个 provider（与库分叉）；
    // 修复后缓存仍是 baseline 的 1 个。
    expect(mod.getConfig().providers).toHaveLength(1);
    expect(mod.getConfig().providers.map(p => p.name)).toEqual(['anthropic']);
  });
});
