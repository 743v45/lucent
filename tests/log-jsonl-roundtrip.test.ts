/**
 * 日志写入/读取 round-trip（SQLite 后端）
 *
 * 旧实现用 JSONL + 自创分隔符 '\n---\n' + escape/unescape，与 JSON 转义冲突，
 * body 含 markdown / YAML frontmatter（字面 '\n---\n'）时解析失败被静默丢弃。
 * 切 SQLite 后内容以 JSON 文本存储，不再有分隔符冲突——本测试验证内容完整性仍成立，
 * 并补「同 id 幂等不产生重复行」（insertLog OR IGNORE）。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as LogWriter from '../server/services/log-writer.js';
import * as LogReader from '../server/services/log-reader.js';
import { closeDb } from '../server/services/db-instance.js';
import type { RawLogEntry } from '../server/types.js';
import type { ResolvedConfig } from '../server/config.js';

function makeEntry(id: string, content: string): RawLogEntry {
  return {
    id,
    timestamp: `2026-06-18T00:00:0${id.slice(-1)}.000Z`,
    project: '',
    url: 'http://upstream/v1/chat/completions',
    method: 'POST',
    headers: {},
    body: {
      model: 'test-model',
      messages: [{ role: 'user', content }],
    },
    response: {
      status: 200,
      statusText: 'OK',
      headers: {},
      body: { type: 'sse_raw', lines: [] },
    },
    duration: 10,
    isStream: true,
    mainAgent: true,
    agentType: 'main',
    clientType: 'unknown',
    isTest: false,
    providerName: 'hxy',
    endpointType: 'openai-chat',
  } as unknown as RawLogEntry;
}

const FRONTMATTER_CONTENT =
  'Pre text\n---\ntitle: "SOUL.md"\n---\nPost text';

describe('日志 round-trip（SQLite 后端）— frontmatter / 内容完整性 / 幂等', () => {
  let configDir: string;
  let dbPath: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'lucent-jsonl-'));
    dbPath = join(configDir, 'lucent.db');
    const cfg = {
      logDir: join(configDir, 'logs'),
      dbPath,
      maxLogFileSize: 100 * 1024 * 1024,
      logRetentionDays: 30,
    } as unknown as ResolvedConfig;
    closeDb(); // db-instance 是进程级单例，重开前先关旧库
    LogWriter.init(cfg);
    LogReader.init(cfg);
    LogReader.invalidateCache();
  });

  afterEach(async () => {
    await LogWriter.drainWriteQueue();
    closeDb();
    rmSync(configDir, { recursive: true, force: true });
  });

  it('body 含 markdown frontmatter（字面 \\n---\\n）round-trip 后内容字节级等价', async () => {
    LogWriter.writeLogEntry(makeEntry('frontmatter-1', FRONTMATTER_CONTENT));
    await LogWriter.drainWriteQueue();

    const { logs } = await LogReader.readLogs({ limit: 100 });
    expect(logs.length).toBe(1);
    const body = logs[0].request?.body as any;
    expect(body.messages[0].content).toBe(FRONTMATTER_CONTENT);
  });

  it('frontmatter 条目不会污染后续条目 —— 两条都能读回', async () => {
    LogWriter.writeLogEntry(makeEntry('frontmatter-A', FRONTMATTER_CONTENT));
    LogWriter.writeLogEntry(makeEntry('normal-B', 'just plain text'));
    await LogWriter.drainWriteQueue();

    const { logs, total } = await LogReader.readLogs({ limit: 100 });
    expect(total).toBe(2);
    expect(logs.length).toBe(2);
    const ids = logs.map(l => l.id).sort();
    expect(ids).toEqual(['frontmatter-A', 'normal-B'].sort());
  });

  it('content 含两个 \\n---\\n 序列不被错误拆分成多条', async () => {
    const content = 'a\n---\nb\n---\nc';
    LogWriter.writeLogEntry(makeEntry('multi-sep', content));
    await LogWriter.drainWriteQueue();

    const { logs, total } = await LogReader.readLogs({ limit: 100 });
    expect(total).toBe(1);
    expect(logs.length).toBe(1);
    const body = logs[0].request?.body as any;
    expect(body.messages[0].content).toBe(content);
  });

  it('同 id 二次写入幂等：不产生重复行（insertLog OR IGNORE）', async () => {
    LogWriter.writeLogEntry(makeEntry('dup-1', 'first'));
    LogWriter.writeLogEntry(makeEntry('dup-1', 'second')); // 同 id
    await LogWriter.drainWriteQueue();

    const { logs, total } = await LogReader.readLogs({ limit: 100 });
    expect(total).toBe(1);
    expect(logs.length).toBe(1);
    // SQLite 库文件确实生成
    expect(existsSync(dbPath)).toBe(true);
  });
});
