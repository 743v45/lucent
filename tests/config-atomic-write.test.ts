/**
 * config 持久化数据完整性单测（Bug #11）
 *
 * 验证 server/config.ts 的 saveConfig 三处修复：
 * ① 原子写：先 writeFileSync 到 `${CONFIG_PATH}.tmp` 再 renameSync 覆盖（POSIX rename 原子），
 *    不再直接 truncate+write CONFIG_PATH。
 * ② 写盘失败不污染缓存：renameSync 抛错时，getConfig() 仍返回旧值、磁盘仍是旧值，且 saveConfig rethrow。
 * ③ CRUD 基于克隆：createProvider 写盘失败时，缓存里的 providers 不被就地 push 污染（证明 cloneConfig 生效）。
 *
 * 手法：vi.mock 拦截 node:fs 的 writeFileSync / renameSync 观察调用顺序 + 注入失败；
 * 每个用例 vi.resetModules + 动态 import 拿全新模块（重置 cachedConfig），
 * LUCENT_CONFIG_DIR 指向 tmpdir，避免污染真实 ~/.lucent。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProxyConfig } from '../server/config.js';

// vi.mock 工厂在 import 之前执行，须用 vi.hoisted 把可变状态暴露给工厂与测试体共享。
const fsMock = vi.hoisted(() => ({
  // 按发生顺序记录 writeFileSync / renameSync 的调用参数
  calls: [] as Array<{ fn: 'writeFileSync' | 'renameSync'; args: unknown[] }>,
  // 非 null 时对应调用抛错（模拟磁盘满 / EACCES / rename 失败）
  writeError: null as Error | null,
  renameError: null as Error | null,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal() as typeof import('node:fs');
  return {
    ...actual,
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      fsMock.calls.push({ fn: 'writeFileSync', args });
      if (fsMock.writeError) throw fsMock.writeError;
      return actual.writeFileSync(...args);
    },
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      fsMock.calls.push({ fn: 'renameSync', args });
      if (fsMock.renameError) throw fsMock.renameError;
      return actual.renameSync(...args);
    },
  };
});

let configDir: string;
let savedConfigDir: string | undefined;
const CONFIG_NAME = 'config.json';

beforeEach(() => {
  // 全新 tmpdir；在动态 import 前设置 env，让 constants.ts 在重新求值时捕获到它
  configDir = mkdtempSync(join(tmpdir(), 'lucent-config-atomic-'));
  savedConfigDir = process.env.LUCENT_CONFIG_DIR;
  process.env.LUCENT_CONFIG_DIR = configDir;
  fsMock.calls = [];
  fsMock.writeError = null;
  fsMock.renameError = null;
  // 清掉 config 模块缓存（cachedConfig 归零）；测试体内动态 import 拿全新实例
  vi.resetModules();
});

afterEach(() => {
  if (savedConfigDir === undefined) delete process.env.LUCENT_CONFIG_DIR;
  else process.env.LUCENT_CONFIG_DIR = savedConfigDir;
  rmSync(configDir, { recursive: true, force: true });
});

const configPath = () => join(configDir, CONFIG_NAME);
const tmpPath = () => join(configDir, `${CONFIG_NAME}.tmp`);

describe('saveConfig — 原子写 + 缓存一致性（Bug #11）', () => {
  it('① 先写 .tmp 再 rename 覆盖到 CONFIG_PATH，不直接 truncate+write', async () => {
    const mod = await import('../server/config.js');
    const cfg = mod.loadConfig(); // 空目录 → bootstrap 默认配置（直接写 CONFIG_PATH）
    // 清掉 bootstrap 的写入记录，只观察 saveConfig 自身的写盘序列
    fsMock.calls.length = 0;
    cfg.webPort = 9999;
    mod.saveConfig(cfg);

    const writes = fsMock.calls.filter(c => c.fn === 'writeFileSync');
    const renames = fsMock.calls.filter(c => c.fn === 'renameSync');

    // 只写一次 .tmp
    expect(writes).toHaveLength(1);
    expect(writes[0].args[0]).toBe(tmpPath());
    // 一次 rename：.tmp → CONFIG_PATH
    expect(renames).toHaveLength(1);
    expect(renames[0].args[0]).toBe(tmpPath());
    expect(renames[0].args[1]).toBe(configPath());
    // 顺序：write 先于 rename
    expect(fsMock.calls.indexOf(writes[0])).toBeLessThan(fsMock.calls.indexOf(renames[0]));
    // 没有直接覆写 CONFIG_PATH（旧的 truncate+write 路径已消失）
    expect(writes.some(w => w.args[0] === configPath())).toBe(false);
    // rename 真的落地：磁盘内容是新值
    const onDisk = JSON.parse(readFileSync(configPath(), 'utf-8'));
    expect(onDisk.webPort).toBe(9999);
  });

  it('② renameSync 失败时不污染缓存且 rethrow：getConfig() 与磁盘都仍是旧值', async () => {
    const mod = await import('../server/config.js');
    const baseline = mod.loadConfig(); // 默认 logMode 'archive'
    expect(baseline.logMode).toBe('archive');

    // 构造一份改过的配置（克隆，不就地 mutate baseline）
    const modified: ProxyConfig = structuredClone(baseline);
    modified.logMode = 'off';

    fsMock.renameError = new Error('mock rename EACCES');
    // writeFileSync(.tmp) 成功，renameSync 抛错 → saveConfig 向上 rethrow
    expect(() => mod.saveConfig(modified)).toThrow(/mock rename EACCES/);

    // 缓存未被提交：getConfig() 仍返回 baseline 的值
    expect(mod.getConfig().logMode).toBe('archive');
    // 磁盘也未被改写（仍是 bootstrap 写入的 archive）
    const onDisk = JSON.parse(readFileSync(configPath(), 'utf-8'));
    expect(onDisk.logMode).toBe('archive');
  });

  it('③ CRUD 基于克隆：createProvider 写盘失败时不就地污染缓存 providers', async () => {
    const mod = await import('../server/config.js');
    const baseline = mod.loadConfig(); // 默认 1 个 provider（anthropic）
    expect(baseline.providers).toHaveLength(1);
    expect(baseline.providers.map(p => p.name)).toEqual(['anthropic']);

    fsMock.renameError = new Error('mock rename EACCES');
    // createProvider 内部 cloneConfig → push 到克隆 → saveConfig 写盘失败抛错
    expect(() => mod.createProvider({
      name: 'z-test-extra',
      endpoints: {
        'openai-chat': 'https://example.com/v1',
        'openai-responses': null,
        'anthropic-messages': null,
      },
    })).toThrow(/mock rename EACCES/);

    // 关键：修复前会就地 push 到 cachedConfig，缓存会变成 2 个 provider（与磁盘分叉）；
    // 修复后缓存仍是 baseline 的 1 个。
    expect(mod.getConfig().providers).toHaveLength(1);
    expect(mod.getConfig().providers.map(p => p.name)).toEqual(['anthropic']);
  });
});
