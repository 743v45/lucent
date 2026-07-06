/**
 * 日志写入/读取 round-trip：JSONL 格式 + frontmatter 兼容性
 *
 * 背景：旧实现用自创分隔符 '\n---\n' + escape/unescape 二次转义层，
 * 与 JSON 自身转义冲突。当 body 含 markdown / YAML frontmatter（字面
 * '\n---\n' 开头）时，unescapeLogContent 在 JSON.parse 之前破坏字符串值，
 * 导致该条目及之后所有条目解析失败、被 /api/logs 静默丢弃。
 *
 * 本测试覆盖：frontmatter round-trip、分隔符序列保留、每条单行、
 * 解析失败不级联。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as LogWriter from '../server/services/log-writer.js';
import * as LogReader from '../server/services/log-reader.js';
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

describe('日志 JSONL round-trip — frontmatter / 分隔符序列兼容', () => {
  let logDir: string;
  let configDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'lucent-jsonl-'));
    logDir = join(configDir, 'logs');
    const cfg = {
      logDir,
      maxLogFileSize: 100 * 1024 * 1024,
      logRetentionDays: 30,
    } as unknown as ResolvedConfig;
    LogWriter.init(cfg);
    LogReader.init(cfg);
    LogReader.invalidateCache();
  });

  afterEach(async () => {
    await LogWriter.drainWriteQueue();
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

  it('每条日志在文件中恰占一行（值为 JSON.stringify(entry)+\\n，无 --- 分隔符）', async () => {
    LogWriter.writeLogEntry(makeEntry('line-1', 'hello'));
    LogWriter.writeLogEntry(makeEntry('line-2', 'world'));
    await LogWriter.drainWriteQueue();

    const files = readdirSync(logDir).filter(f => f.endsWith('.jsonl'));
    expect(files.length).toBe(1);
    const raw = readFileSync(join(logDir, files[0]), 'utf-8');

    // 文件不含旧的 --- 分隔符
    expect(raw).not.toContain('\n---\n');
    expect(raw).not.toContain('\\n---\\n');

    // 按真实换行拆分，得到 2 个非空行（末尾换行产生一个空段）
    const lines = raw.split('\n').filter(l => l.length > 0);
    expect(lines.length).toBe(2);
    // 每行都是合法 JSON
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});
