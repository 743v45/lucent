/**
 * log-manager 路径穿越防御单测（Bug #1 防御层）
 *
 * 路由层已堵穿越（见 logs-routes-security.test.ts），此处给 exportLogs/importLogs
 * 补一层实现级防御：无论调用方是谁，输出/输入路径必须落在有效 logDir 内，否则抛错。
 *
 * 用真实 SQLite（initDb 空库）驱动 exportLogs，证明：
 * - 修复前会真的把穿越文件写到 logDir 之外（高危）
 * - 修复后抛错且不创建任何文件
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { exportLogs, importLogs } from '../server/log-manager.js';
import { initDb, closeDb } from '../server/services/db-instance.js';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let logDir: string; // LUCENT_LOG_DIR（export/import 允许的范围）
let dbDir: string; // 真实 SQLite 目录（与 logDir 不同，便于构造"logDir 外"路径）
let savedEnv: string | undefined;

beforeAll(() => {
  savedEnv = process.env.LUCENT_LOG_DIR;
  logDir = mkdtempSync(join(tmpdir(), 'lucent-lm-logdir-'));
  process.env.LUCENT_LOG_DIR = logDir;
});

afterAll(() => {
  if (savedEnv === undefined) delete process.env.LUCENT_LOG_DIR;
  else process.env.LUCENT_LOG_DIR = savedEnv;
  rmSync(logDir, { recursive: true, force: true });
});

beforeEach(() => {
  dbDir = mkdtempSync(join(tmpdir(), 'lucent-lm-db-'));
  initDb(join(dbDir, 'test.db'));
});

afterEach(() => {
  closeDb();
  rmSync(dbDir, { recursive: true, force: true });
});

describe('exportLogs — 路径穿越防御', () => {
  it('输出路径在 logDir 外时抛错，且不创建任何文件', () => {
    const target = join(dbDir, 'stolen.jsonl'); // dbDir ≠ logDir → 落在 logDir 外
    expect(() => exportLogs(target, { format: 'jsonl' })).toThrow();
    expect(existsSync(target)).toBe(false);
  });

  it('相对穿越 ../../outside 被拒绝（resolve 后落在 logDir 之外）', () => {
    const target = join(logDir, '..', '..', 'outside.jsonl');
    expect(() => exportLogs(target, { format: 'jsonl' })).toThrow();
  });

  it('logDir 内的合法路径正常导出（空库 → 0 条）', () => {
    const result = exportLogs(join(logDir, 'export.jsonl'), { format: 'jsonl' });
    expect(result.success).toBe(true);
    expect(result.count).toBe(0);
  });
});

describe('importLogs — 路径穿越防御', () => {
  it('输入路径在 logDir 外时抛错', () => {
    expect(() => importLogs(join(dbDir, 'secret.jsonl'), { merge: true })).toThrow();
  });

  it('/etc/passwd 等系统绝对路径被拒绝', () => {
    expect(() => importLogs('/etc/passwd', { merge: true })).toThrow();
  });
});
