/**
 * 会话视图（threadId 分组）E2E 测试
 *
 * 现有 e2e 基建为「后端 fetch 风格」（无 Playwright，见 providers-e2e.test.ts /
 * config-reload-e2e.test.ts），故本测试沿用该风格：注入固定 threadId 的 jsonl
 * fixture 到隔离日志目录 → 起 web 服务 → GET /api/logs → 断言返回的 entry 含正确
 * threadId（验证 T5 数据透传链 + 分组数据正确性）。
 *
 * 前端 groupByThread 渲染部分用直接调用 src/utils/group-by-thread.ts 的方式覆盖
 * （该纯函数已有独立单测，此处复用其对 /api/logs 返回数据的分组行为，验证后端
 * 数据足以驱动前端分组：分组 / sub 附属 / 未归类）。
 *
 * conversationView 偏好与 autoCollapse 一样不做 localStorage 持久化（仅内存
 * preferences），故不测「刷新后仍停留在会话视图」。
 *
 * 运行: vitest run tests/conversation-e2e.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { createTestEnv, cleanTestDir, writeTestConfig, startBackend, stopBackend, removeTestDir, seedLogsFromJsonl, type TestEnv } from './e2e-helpers.js';
import { groupByThread } from '../src/utils/group-by-thread.js';
import type { LogEntry, AgentType } from '../src/types.js';

// ==================== 常量 ====================

const testEnv = createTestEnv('conversation-e2e');
const { logDir: LOG_DIR, proxyPort: PROXY_PORT, webPort: WEB_PORT } = testEnv;

/** 日志文件名（不以 export_ 开头，会被 /api/logs 读取；排序后置顶） */
const LOG_FILE = join(LOG_DIR, 'lucent_2026-06-15_conversation-e2e.jsonl');

const WEB_URL = `http://127.0.0.1:${WEB_PORT}`;
const SEP = '\n---\n';

// ==================== Fixture 构造 ====================

/**
 * 构造扁平 RawLogEntry 格式的 jsonl 行（与 interceptor 写盘格式一致）。
 * normalizeLogEntry 会归一化为前端嵌套 LogEntry 格式，threadId 原样透传。
 */
interface FixtureInput {
  id: string;
  timestamp: string;
  agentType: AgentType;
  threadId?: string;
  model?: string;
  userText?: string;
}

function fixtureLine(input: FixtureInput): string {
  const model = input.model ?? 'claude-sonnet-4-6';
  const entry = {
    id: input.id,
    timestamp: input.timestamp,
    project: 'agentproxy',
    url: 'https://api.anthropic.com/v1/messages',
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
    },
    body: {
      model,
      max_tokens: 1024,
      messages: [
        { role: 'user', content: input.userText ?? 'e2e fixture' },
      ],
      stream: false,
    },
    response: {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/json' },
      body: {
        id: `msg_${input.id}`,
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'fixture reply' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 100, output_tokens: 20 },
      },
    },
    duration: 500,
    isStream: false,
    mainAgent: input.agentType === 'main',
    agentType: input.agentType,
    apiType: 'anthropic-messages',
    tokenUsage: { input_tokens: 100, output_tokens: 20 },
    ...(input.threadId ? { threadId: input.threadId } : {}),
  };
  return JSON.stringify(entry);
}

/** 多行 fixture（每行一条 RawLogEntry，用 \n---\n 分隔，与真实写盘一致） */
function fixtureContent(lines: FixtureInput[]): string {
  return lines.map(fixtureLine).join(SEP) + SEP;
}

/** 读取 /api/logs 返回的条目（按 timestamp 升序，便于断言分组顺序） */
async function fetchLogsAscending(): Promise<LogEntry[]> {
  const res = await fetch(`${WEB_URL}/api/logs?limit=100`);
  expect(res.ok).toBe(true);
  const json = (await res.json()) as { logs: LogEntry[] };
  return [...json.logs].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );
}

// ==================== 测试套件 ====================

describe('会话视图 E2E — threadId 数据流 + 分组', () => {
  beforeAll(async () => {
    await cleanTestDir(testEnv);
    await writeTestConfig(testEnv, {
      host: '127.0.0.1',
      proxyPort: PROXY_PORT,
      webPort: WEB_PORT,
      providers: [],
    });
    await startBackend(testEnv);
    await new Promise((r) => setTimeout(r, 1500));
  }, 30000);

  afterAll(async () => {
    await stopBackend();
    await removeTestDir(testEnv);
  }, 10000);

  it('threadId 在 /api/logs 中原样透传（T5 数据透传链）', async () => {
    await seedLogsFromJsonl(testEnv, fixtureContent([
        { id: 't-passthrough-1', timestamp: '2026-06-15T10:00:00.000Z', agentType: 'main', threadId: 'thread_passthrough' },
        { id: 't-passthrough-2', timestamp: '2026-06-15T10:00:05.000Z', agentType: 'main', threadId: 'thread_passthrough' },
      ]));

    const logs = await fetchLogsAscending();
    const matched = logs.filter((l) => l.id.startsWith('t-passthrough'));
    expect(matched).toHaveLength(2);
    expect(matched.every((l) => l.threadId === 'thread_passthrough')).toBe(true);
    // 归一化后嵌套结构正确
    expect(matched[0].request.method).toBe('POST');
    expect(matched[0].response?.status).toBe(200);
  });

  it('分组渲染：同 threadId 的 main + 附属 sub 归一组', async () => {
    await seedLogsFromJsonl(testEnv, fixtureContent([
        { id: 't-group-m1', timestamp: '2026-06-15T11:00:00.000Z', agentType: 'main', threadId: 'thread_group_a', userText: '帮我分析代码' },
        { id: 't-group-m2', timestamp: '2026-06-15T11:00:10.000Z', agentType: 'main', threadId: 'thread_group_a' },
        // sub 无 threadId，时间晚于 thread_group_a 首条 main → 附属到该组
        { id: 't-group-s1', timestamp: '2026-06-15T11:00:05.000Z', agentType: 'sub' },
      ]));

    const logs = (await fetchLogsAscending()).filter((l) => l.id.startsWith('t-group'));
    const { groups, ungrouped } = groupByThread(logs);

    // 1 个会话组（thread_group_a），无未归类
    expect(groups).toHaveLength(1);
    expect(ungrouped).toHaveLength(0);

    const group = groups.find((g) => g.threadId === 'thread_group_a')!;
    expect(group).toBeDefined();
    // 含 2 main + 1 sub
    expect(group.mainLogs).toHaveLength(2);
    expect(group.subLogs).toHaveLength(1);
    // 可展开：mainLogs 组内时间升序
    expect(group.mainLogs.map((l) => l.id)).toEqual(['t-group-m1', 't-group-m2']);
    // 标题取首条 user 文本
    expect(group.title).toBe('帮我分析代码');
  });

  it('sub 附属：归属时间上不晚于它的最近 main 会话', async () => {
    await seedLogsFromJsonl(testEnv, fixtureContent([
        // 两个会话组
        { id: 't-aff-m1', timestamp: '2026-06-15T12:00:00.000Z', agentType: 'main', threadId: 'thread_aff_1' },
        { id: 't-aff-m2', timestamp: '2026-06-15T12:00:30.000Z', agentType: 'main', threadId: 'thread_aff_2' },
        // sub 时间在 thread_aff_2 首条 main 之后 → 附属 thread_aff_2（最近的不晚于它的 main）
        { id: 't-aff-s1', timestamp: '2026-06-15T12:00:35.000Z', agentType: 'sub' },
      ]));

    const logs = (await fetchLogsAscending()).filter((l) => l.id.startsWith('t-aff'));
    const { groups } = groupByThread(logs);

    const g1 = groups.find((g) => g.threadId === 'thread_aff_1')!;
    const g2 = groups.find((g) => g.threadId === 'thread_aff_2')!;
    // sub 附属到 thread_aff_2，而非 thread_aff_1
    expect(g1.subLogs).toHaveLength(0);
    expect(g2.subLogs.map((l) => l.id)).toEqual(['t-aff-s1']);
  });

  it('视图切换：groupByThread 对 /api/logs 数据正确分组 vs flat 列表', async () => {
    // 复用上一条 fixture（已在磁盘上）。验证：flat 列表含全部条目，分组后结构正确。
    const logs = (await fetchLogsAscending()).filter((l) => l.id.startsWith('t-aff'));
    // 「时间线」视图：flat 列表（按时间倒序来自 /api/logs，这里转升序）
    expect(logs).toHaveLength(3);
    // 「会话」视图：groupByThread 产出分组结构
    const { groups } = groupByThread(logs);
    expect(groups).toHaveLength(2);
    const totalMain = groups.reduce((sum, g) => sum + g.mainLogs.length, 0);
    const totalSub = groups.reduce((sum, g) => sum + g.subLogs.length, 0);
    // 分组覆盖全部条目（视图切换不丢数据）
    expect(totalMain + totalSub).toBe(logs.length);
  });

  it('孤立请求：无 threadId 且无邻近 main 的 sub → 未归类组', async () => {
    await seedLogsFromJsonl(testEnv, fixtureContent([
        // 仅一条 sub，无任何 main，无 threadId → 无法附属 → ungrouped
        { id: 't-iso-s1', timestamp: '2026-06-15T13:00:00.000Z', agentType: 'sub' },
      ]));

    const logs = (await fetchLogsAscending()).filter((l) => l.id.startsWith('t-iso'));
    const { groups, ungrouped } = groupByThread(logs);
    // 无会话组，进入未归类
    expect(groups).toHaveLength(0);
    expect(ungrouped.map((l) => l.id)).toEqual(['t-iso-s1']);
  });
});
