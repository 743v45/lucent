#!/usr/bin/env tsx
/**
 * scripts/verify-custom-errors-e2e.ts — 自定义供应商错误路径全链路验收
 *
 * 对应 openspec/specs/protocol-chain-verification/spec.md
 *
 * 用法: npm run verify:custom-errors
 *
 * 1 个 mock upstream（createMockUpstream format:'auto'）同时处理 3 协议
 * × 2 个自定义供应商（hxy + hxy2，都配齐 3 协议）
 * × 4 种状态码（200/401/429/500）
 * × 6 个验收环节（客户端 status / 错误 body 透传 / 日志 status / /api/logs / Web UI / schema 校验）
 *
 * 隔离: 临时 config + 随机端口，不碰 ~/.lucent
 * fixture 复用: tests/e2e-helpers.ts 的 createMockUpstream（单一真相源）
 *   → openai 错误体 type 按 status 映射(401→authentication_error 等)自动正确
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import {
  createMockUpstream,
  validateAnthropicBody,
  validateOpenAIChatBody,
  validateOpenAIResponsesBody,
} from '../tests/e2e-helpers.js';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// ==================== 隔离环境 ====================

const CONFIG_DIR = mkdtempSync(join(tmpdir(), 'lucent-custom-err-verify-'));
const BASE = 58000 + Math.floor(Math.random() * 3000);
const PROXY_PORT = BASE;
const WEB_PORT = BASE + 1;
const VITE_PORT = BASE + 2;

// ==================== mock 上游（复用 helpers.ts fixture, auto 模式分派 3 协议）====================

const upstream = await createMockUpstream({ name: 'custom-errors-verify', format: 'auto' });
const UPSTREAM_BASE = `http://127.0.0.1:${upstream.port}/v1`;

// ==================== 配置（2 个供应商各指向 UPSTREAM_BASE，3 协议）====================

writeFileSync(join(CONFIG_DIR, 'config.json'), JSON.stringify({
  host: '127.0.0.1',
  proxyPort: PROXY_PORT,
  webPort: WEB_PORT,
  providers: [
    { id: 'p-hxy', name: 'hxy', endpoints: { 'anthropic-messages': UPSTREAM_BASE, 'openai-chat': UPSTREAM_BASE, 'openai-responses': UPSTREAM_BASE } },
    { id: 'p-hxy2', name: 'hxy2', endpoints: { 'anthropic-messages': UPSTREAM_BASE, 'openai-chat': UPSTREAM_BASE, 'openai-responses': UPSTREAM_BASE } },
  ],
}));

// ==================== 启动后端 + vite ====================

const backend = spawn('npx', ['tsx', 'server/index.ts'], {
  cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, LUCENT_CONFIG_DIR: CONFIG_DIR, LUCENT_HOST: '127.0.0.1', LUCENT_PROXY_PORT: String(PROXY_PORT), LUCENT_WEB_PORT: String(WEB_PORT), LUCENT_LOG_DIR: join(CONFIG_DIR, 'logs') },
});

const vite = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(VITE_PORT), '--strictPort'], {
  cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, LUCENT_WEB_PORT: String(WEB_PORT) },
});

// ==================== 工具 ====================

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, cond: any, detail = '') {
  results.push({ name, ok: !!cond, detail });
  console.log(`  ${cond ? '✓ PASS' : '✗ FAIL'}  ${name}${detail && !cond ? '  →  ' + detail : ''}`);
}

async function post(url: string, headers: Record<string, string>, body: any) {
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
    return { status: res.status, body: await res.text() };
  } catch (e: any) { return { status: 0, body: String(e) }; }
}

const REQ_BODIES: Record<string, any> = {
  'anthropic-messages': { model: 'claude-sonnet-4-5', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] },
  'openai-chat':        { model: 'gpt-4o', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] },
  'openai-responses':   { model: 'gpt-4o', input: 'hi' },
};
const PATHS: Record<string, string> = {
  'anthropic-messages': '/v1/messages',
  'openai-chat':        '/v1/chat/completions',
  'openai-responses':   '/v1/responses',
};
const HEADERS: Record<string, Record<string, string>> = {
  'anthropic-messages': { 'x-api-key': 'sk-x', 'anthropic-version': '2023-06-01' },
  'openai-chat':        { 'authorization': 'Bearer sk-x' },
  'openai-responses':   { 'authorization': 'Bearer sk-x' },
};

// 各协议 200 基线（auto 模式 json mode）的文本断言（对齐 helpers fixture）
const OK_TEXT: Record<string, (j: any) => boolean> = {
  'anthropic-messages': (j) => j?.content?.[0]?.text === 'Hello from JSON response.',
  'openai-chat':        (j) => j?.choices?.[0]?.message?.content === 'Hello from JSON.',
  'openai-responses':   (j) => j?.output?.[0]?.content?.[0]?.text === 'Hello from JSON.',
};

function readLogEntries(): any[] {
  const files = readdirSync(join(CONFIG_DIR, 'logs')).filter(f => f.endsWith('.jsonl')).sort();
  if (!files.length) return [];
  return readFileSync(join(CONFIG_DIR, 'logs', files[files.length - 1]), 'utf-8')
    .split(/\n---\n/).filter(s => s.trim().startsWith('{')).map(s => JSON.parse(s));
}

async function waitFor(proc: any, regex: RegExp, label: string, timeoutMs = 30000) {
  return new Promise<void>((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(`${label} timeout`)), timeoutMs);
    let done = false;
    proc.stdout.on('data', (d: Buffer) => { if (!done && regex.test(d.toString())) { done = true; clearTimeout(to); resolve(); } });
    proc.on('exit', (c: number) => { if (!done) reject(new Error(`${label} exit ${c}`)); });
  });
}

async function waitForPort(url: string, label: string, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { const r = await fetch(url); if (r.status > 0) return; } catch {}
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error(`${label} port never accepted`);
}

// status → auto mode 映射
function modeFor(status: number): 'json' | 'error-401' | 'error-429' | 'error-500' {
  if (status === 200) return 'json';
  return `error-${status}` as 'error-401' | 'error-429' | 'error-500';
}

// 单个错误码 × 协议 × 供应商 的 6 环节验收
async function verifyOneCombo(provider: string, protocol: string, status: number) {
  console.log(`\n  ┌─ ${provider} × ${protocol} × ${status} ─┐`);
  upstream.reset();
  upstream.setMode(modeFor(status));

  // ① 客户端收到对应 status 码
  const res = await post(`http://127.0.0.1:${PROXY_PORT}/custom/${provider}${PATHS[protocol]}`, HEADERS[protocol], REQ_BODIES[protocol]);
  check(`① ${provider} ${protocol} ${status}: 客户端收到 status=${status}`,
    res.status === status, `实际 status=${res.status} body 前 80: ${res.body.slice(0, 80)}`);

  // ② 错误/成功 body 原样透传
  let parsed: any = null;
  try { parsed = JSON.parse(res.body); } catch {}

  let bodyOk = false;
  let bodyDetail = '';
  if (status === 200) {
    bodyOk = !!parsed && OK_TEXT[protocol](parsed);
    bodyDetail = `body type=${parsed?.type || parsed?.object}`;
  } else {
    if (parsed) {
      if (protocol === 'anthropic-messages') {
        bodyOk = parsed.type === 'error' && parsed.error && typeof parsed.error.type === 'string' && typeof parsed.error.message === 'string';
        bodyDetail = `error.type=${parsed.error?.type}`;
      } else {
        bodyOk = parsed.error && typeof parsed.error.message === 'string' && typeof parsed.error.code === 'string';
        bodyDetail = `error.code=${parsed.error?.code}`;
      }
    } else {
      bodyDetail = 'JSON parse 失败';
    }
  }
  check(`② ${provider} ${protocol} ${status}: 错误/成功 body 原样透传`, bodyOk, bodyDetail);

  // ⑥ schema 校验（error.type 按 status 映射在此函数内部检查）
  let schemaOk = false;
  let schemaDetail = '';
  try {
    if (status === 200) {
      let r;
      if (protocol === 'anthropic-messages') r = validateAnthropicBody(parsed, 'json');
      else if (protocol === 'openai-chat') r = validateOpenAIChatBody(parsed, 'json');
      else r = validateOpenAIResponsesBody(parsed, 'json');
      schemaOk = r.ok;
      schemaDetail = r.errors.slice(0, 3).join('; ');
    } else {
      let r;
      if (protocol === 'anthropic-messages') r = validateAnthropicBody(parsed, 'error');
      else r = validateOpenAIChatBody(parsed, 'error'); // chat + responses 错误 schema 相同
      schemaOk = r.ok;
      schemaDetail = r.errors.slice(0, 3).join('; ');
    }
  } catch (e: any) { schemaDetail = `schema 异常: ${e.message}`; }
  check(`⑥ ${provider} ${protocol} ${status}: schema 校验${status === 200 ? '(完整响应)' : '(error.type 按 status 映射)'}`,
    schemaOk, schemaDetail);

  // ③ 日志记录 status
  await new Promise(r => setTimeout(r, 400));
  const entries = readLogEntries().filter((e: any) => e.providerName === provider && e.endpointType === protocol);
  const log = entries[entries.length - 1];
  let logOk = false;
  let logDetail = `no log`;
  if (log) {
    const logStatus = log?.response?.status ?? log?.status;
    logOk = logStatus === status;
    logDetail = `log.response.status=${logStatus}`;
  }
  check(`③ ${provider} ${protocol} ${status}: 日志 response.status=${status}`, logOk, logDetail);

  if (!log) return;

  // ④ /api/logs 返 status
  const apiRes = await fetch(`http://127.0.0.1:${WEB_PORT}/api/logs?limit=200`);
  const apiJson = await apiRes.json();
  const apiEntry = (apiJson.logs || apiJson).find((l: any) => l.id === log.id);
  let apiOk = false;
  let apiDetail = `not found`;
  if (apiEntry) {
    const apiStatus = apiEntry?.response?.status;
    apiOk = apiStatus === status;
    apiDetail = `api response.status=${apiStatus}`;
  }
  check(`④ ${provider} ${protocol} ${status}: /api/logs 返 response.status=${status}`, apiOk, apiDetail);

  // ⑤ Web UI 展示 status code
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`http://127.0.0.1:${VITE_PORT}/`);
    await page.waitForTimeout(300);
    const rowLocator = page.locator(`[data-testid="log-row"][data-logid="${log.id}"]`);
    const rowText = await rowLocator.textContent().catch(() => '');
    const statusTextOk = rowText.includes(String(status));
    check(`⑤ ${provider} ${protocol} ${status}: Web UI 日志列表展示 status=${status}`,
      statusTextOk, `row text 前 80: ${rowText.slice(0, 80)}`);
  } finally {
    await browser.close();
  }
}

try {
  await waitFor(backend, /Lucent|代理|listen|启动/i, 'backend');
  await waitFor(vite, /Local:|ready in/i, 'vite');
  await waitForPort(`http://127.0.0.1:${VITE_PORT}/`, 'vite');
  await new Promise(r => setTimeout(r, 1000));

  console.log(`\n========== 自定义供应商错误路径全链路验收 ==========`);
  console.log(`  mock upstream: ${UPSTREAM_BASE} (auto 模式, 3 协议)`);
  console.log(`  后端: proxy=${PROXY_PORT} web=${WEB_PORT} vite=${VITE_PORT}`);
  console.log(`  供应商: hxy + hxy2 × 协议: 3 × 状态码: 200/401/429/500`);
  console.log(`  每组合 6 个验收点 (status/body/schema/log/api/ui)\n`);

  for (const provider of ['hxy', 'hxy2']) {
    for (const protocol of ['anthropic-messages', 'openai-chat', 'openai-responses']) {
      for (const status of [200, 401, 429, 500]) {
        await verifyOneCombo(provider, protocol, status);
      }
    }
  }

} finally {
  backend.kill('SIGTERM');
  vite.kill('SIGTERM');
  await upstream.close();
  await new Promise(r => setTimeout(r, 500));
  try { rmSync(CONFIG_DIR, { recursive: true, force: true }); } catch {}
}

// ==================== 汇总 ====================

const pass = results.filter(r => r.ok).length;
const fail = results.length - pass;
console.log('');
console.log('='.repeat(56));
console.log(`  ${pass}/${results.length} 通过, ${fail} 失败 (目标 144/144)`);
console.log('='.repeat(56));
if (fail > 0) {
  console.log('\n失败项:');
  results.filter(r => !r.ok).forEach(r => console.log(`  - ${r.name}${r.detail ? ' (' + r.detail + ')' : ''}`));
}

process.exit(fail === 0 ? 0 : 1);
