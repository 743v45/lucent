#!/usr/bin/env tsx
/**
 * scripts/verify-body-rewrite-e2e.ts — body 重写规则引擎端到端验收
 *
 * 对应 openspec/changes/2026-07-06-body-rewrite-engine/
 *
 * 用法: npm run verify:body-rewrite
 *
 * 覆盖:
 *   用例 A — billing header 脱敏（子串替换，保留未匹配部分）
 *     ① 上游收到的 body 已脱敏（不含 cc_version） ② 含 [REDACTED] 标记
 *     ③ 保留未匹配部分（You are Claude Code + messages）
 *     ④ system[0].text 解析后已脱敏
 *     ⑤ JSONL 日志记录的是重写后 body
 *   用例 B — 零命中透明（无匹配 → 上游收到字节级原样 body，不重格式化）
 *   回归 — /api/logs 接口正常
 *
 * 隔离: 临时 config + 随机端口，不碰 ~/.lucent
 * fixture 复用: tests/e2e-helpers.ts 的 createMockUpstream（单一真相源）
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMockUpstream } from '../tests/e2e-helpers.js';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// ==================== 隔离环境 ====================

const CONFIG_DIR = mkdtempSync(join(tmpdir(), 'lucent-rewrite-verify-'));
const BASE = 48000 + Math.floor(Math.random() * 3000);
const PROXY_PORT = BASE;
const WEB_PORT = BASE + 1;

// ==================== mock 上游（复用 helpers fixture）====================

const upstream = await createMockUpstream({ name: 'rewrite-verify', format: 'anthropic' });
const UPSTREAM_BASE = `http://127.0.0.1:${upstream.port}/v1`;

// ==================== 配置（自定义供应商 hxy + bodyRewrites 脱敏规则）====================

writeFileSync(join(CONFIG_DIR, 'config.json'), JSON.stringify({
  host: '127.0.0.1',
  proxyPort: PROXY_PORT,
  webPort: WEB_PORT,
  providers: [{
    id: 'p-hxy', name: 'hxy',
    endpoints: {
      'anthropic-messages': UPSTREAM_BASE,
      'openai-chat': null, 'openai-responses': null,
    },
  }],
  bodyRewrites: [
    {
      id: 'redact-billing-header',
      name: '脱敏 billing header',
      enabled: true,
      fieldPath: 'system[0].text',
      pattern: 'x-anthropic-billing-header:[^;]*;',
      replacement: '[REDACTED];',
    },
  ],
}));

// ==================== 启动后端 ====================

const backend = spawn('npx', ['tsx', 'server/index.ts'], {
  cwd: REPO_ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    LUCENT_CONFIG_DIR: CONFIG_DIR,
    LUCENT_HOST: '127.0.0.1',
    LUCENT_PROXY_PORT: String(PROXY_PORT),
    LUCENT_WEB_PORT: String(WEB_PORT),
    LUCENT_LOG_DIR: join(CONFIG_DIR, 'logs'),
  },
});

// ==================== 工具 ====================

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, cond: any, detail = '') {
  results.push({ name, ok: !!cond, detail });
  const tag = cond ? '✓ PASS' : '✗ FAIL';
  console.log(`  ${tag}  ${name}${detail && !cond ? '  →  ' + detail : ''}`);
}

async function post(url: string, headers: Record<string, string>, body: any) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text };
  } catch (e: any) {
    return { status: 0, body: String(e) };
  }
}

function readLogEntries() {
  const logDir = join(CONFIG_DIR, 'logs');
  const files = readdirSync(logDir).filter(f => f.endsWith('.jsonl')).sort();
  if (files.length === 0) return [];
  const content = readFileSync(join(logDir, files[files.length - 1]), 'utf-8');
  return content.split('\n').filter(s => s.trim().startsWith('{')).map(s => JSON.parse(s));
}

async function waitForBackend() {
  return new Promise<void>((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('backend startup timeout')), 30000);
    let done = false;
    backend.stdout.on('data', (d: Buffer) => {
      if (!done && /Lucent|代理|listen|启动/i.test(d.toString())) {
        done = true; clearTimeout(to); resolve();
      }
    });
    backend.on('exit', (c: number) => { if (!done) reject(new Error(`backend exit ${c}`)); });
  });
}

const ANTH_HEADERS = { 'x-api-key': 'sk-x', 'anthropic-version': '2023-06-01' };

// 请求 A：system[0].text 含 billing header（应被脱敏，保留其余）
const REQ_BODY_A = {
  model: 'claude-sonnet-4-5',
  max_tokens: 1,
  system: [
    { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.199.ef3; cc_entrypoint=cli; You are Claude Code, a helpful assistant.' },
  ],
  messages: [{ role: 'user', content: 'hi' }],
};

// 请求 B：不含 billing header（零命中，应字节级透传）
const REQ_BODY_B = {
  model: 'claude-sonnet-4-5',
  max_tokens: 1,
  system: [
    { type: 'text', text: 'You are a helpful assistant.' },
  ],
  messages: [{ role: 'user', content: 'hello' }],
};

try {
  await waitForBackend();
  await new Promise(r => setTimeout(r, 800));

  console.log(`\n========== Body 重写规则引擎 端到端验收 ==========\n`);
  console.log(`  上游 mock: ${UPSTREAM_BASE}`);
  console.log(`  后端:     proxy=${PROXY_PORT} web=${WEB_PORT}\n`);

  const PROXY = `http://127.0.0.1:${PROXY_PORT}`;
  const WEB = `http://127.0.0.1:${WEB_PORT}`;

  // ============================================================
  // 用例 A：billing header 脱敏（子串替换，保留其余）
  // ============================================================
  console.log('【用例 A：billing header 脱敏】');
  upstream.reset();
  upstream.setMode('sse-text');

  const resA = await post(`${PROXY}/custom/hxy/v1/messages`, ANTH_HEADERS, REQ_BODY_A);
  check('A-① 客户端收到正常响应（status 200 + SSE）',
    resA.status === 200 && resA.body.includes('event: '), `status=${resA.status}`);

  await new Promise(r => setTimeout(r, 500));  // 等上游收完 + 日志落盘
  const receivedA = upstream.requests[0]?.body ?? '';
  let parsedA: any = null;
  try { parsedA = JSON.parse(receivedA); } catch { /* keep null */ }

  check('A-② 上游收到的 body 已脱敏（不含 cc_version=2.1.199.ef3）',
    !receivedA.includes('cc_version=2.1.199.ef3'), `body 前 120: ${receivedA.slice(0, 120)}`);
  check('A-③ 上游收到的 body 含替换标记 [REDACTED]',
    receivedA.includes('[REDACTED]'), `body 前 120: ${receivedA.slice(0, 120)}`);
  check('A-④ 上游收到的 body 保留未匹配部分（You are Claude Code + messages 完整）',
    receivedA.includes('You are Claude Code') && parsedA?.messages?.length === 1,
    `含 You are Claude Code=${receivedA.includes('You are Claude Code')}, messages.len=${parsedA?.messages?.length}`);
  check('A-⑤ 上游收到的 system[0].text 解析后已脱敏（不含 cc_version）',
    typeof parsedA?.system?.[0]?.text === 'string' && !parsedA.system[0].text.includes('cc_version'),
    `system[0].text 前 80: ${String(parsedA?.system?.[0]?.text ?? '').slice(0, 80)}`);

  // 日志记录的是重写后 body
  const entriesA = readLogEntries().filter((e: any) => e.providerName === 'hxy');
  const logA = entriesA[entriesA.length - 1];
  const logSystemText: string = logA?.body?.system?.[0]?.text ?? '';
  check('A-⑥ JSONL 日志记录的是重写后 body（system[0].text 不含 cc_version 且含 [REDACTED]）',
    !logSystemText.includes('cc_version') && logSystemText.includes('[REDACTED]'),
    `log system[0].text 前 80: ${logSystemText.slice(0, 80)}`);

  // ============================================================
  // 用例 B：零命中透明（字节级透传，无重格式化）
  // ============================================================
  console.log('\n【用例 B：零命中透明（无匹配 → 原样字节）】');
  upstream.reset();

  const resB = await post(`${PROXY}/custom/hxy/v1/messages`, ANTH_HEADERS, REQ_BODY_B);
  check('B-① 客户端收到正常响应', resB.status === 200, `status=${resB.status}`);

  await new Promise(r => setTimeout(r, 400));
  const receivedB = upstream.requests[0]?.body ?? '';
  const sentB = JSON.stringify(REQ_BODY_B);
  check('B-② 零命中时上游收到的 body 与发送字节完全一致（透明，无 JSON 重格式化）',
    receivedB === sentB,
    `received===sent? ${receivedB === sentB}; len received=${receivedB.length} sent=${sentB.length}`);

  // ============================================================
  // 回归：/api/logs 接口正常
  // ============================================================
  const apiRes = await fetch(`${WEB}/api/logs?limit=10`);
  const apiJson = await apiRes.json();
  const apiLogs = apiJson.logs || apiJson;
  check('回归：/api/logs 接口正常返回数组（≥2 条）',
    Array.isArray(apiLogs) && apiLogs.length >= 2, `len=${apiLogs?.length}`);

} finally {
  backend.kill('SIGTERM');
  await upstream.close();
  await new Promise(r => setTimeout(r, 500));
  try { rmSync(CONFIG_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ==================== 汇总 ====================

const pass = results.filter(r => r.ok).length;
const fail = results.length - pass;
console.log('');
console.log('='.repeat(56));
console.log(`  ${pass}/${results.length} 通过, ${fail} 失败`);
console.log('='.repeat(56));

if (fail > 0) {
  console.log('\n失败项:');
  results.filter(r => !r.ok).forEach(r => console.log(`  - ${r.name}${r.detail ? ' (' + r.detail + ')' : ''}`));
}

process.exit(fail === 0 ? 0 : 1);
