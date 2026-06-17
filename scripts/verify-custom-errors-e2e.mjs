#!/usr/bin/env node
/**
 * scripts/verify-custom-errors-e2e.mjs — 自定义供应商错误路径全链路验收
 *
 * 对应 openspec/specs/protocol-chain-verification/spec.md
 *
 * 用法: npm run verify:custom-errors
 *
 * 1 个 mock upstream 同时处理 3 协议的错误格式
 * × 2 个自定义供应商（hxy + hxy2，都配齐 3 协议）
 * × 4 种状态码（200/401/429/500）
 * × 5 个验收环节（客户端 status / 错误 body 透传 / 日志 status / /api/logs / Web UI 展示）
 * = 120 个验收点
 *
 * 隔离: 临时 config + 4 个随机端口，不碰 ~/.lucent
 */

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// ==================== 隔离环境 ====================

const CONFIG_DIR = mkdtempSync(join(tmpdir(), 'lucent-custom-err-verify-'));
const BASE = 58000 + Math.floor(Math.random() * 3000);
const UPSTREAM_PORT = BASE;
const PROXY_PORT = BASE + 1;
const WEB_PORT = BASE + 2;
const VITE_PORT = BASE + 3;
const UPSTREAM_BASE = `http://127.0.0.1:${UPSTREAM_PORT}/v1`;

// ==================== Mock 上游：1 个处理 3 协议错误格式 ====================

let upstreamStatus = 200;  // 当前返回的状态码
const upstreamHits = [];

const upstream = createServer((req, res) => {
  let body = '';
  req.on('data', c => (body += c));
  req.on('end', () => {
    const url = req.url || '/';
    let protocol;
    if (url.includes('/messages')) protocol = 'anthropic';
    else if (url.includes('/chat/completions')) protocol = 'openai-chat';
    else if (url.includes('/responses')) protocol = 'openai-responses';
    else { res.writeHead(404); res.end(); return; }

    upstreamHits.push({ url, method: req.method, headers: req.headers, body, protocol, upstreamStatus });
    respondByStatus(res, protocol, upstreamStatus);
  });
});

function respondByStatus(res, protocol, status) {
  if (status === 200) {
    // 基线: 返 200 + 简短成功响应
    const ok = protocol === 'anthropic'
      ? { id: 'msg_e', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }
      : protocol === 'openai-chat'
      ? { id: 'cmpl_e', object: 'chat.completion', model: 'gpt-4o', choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }
      : { id: 'resp_e', object: 'response', status: 'completed', model: 'gpt-4o', output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
    const data = JSON.stringify(ok);
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) });
    res.end(data);
    return;
  }

  // 错误响应: 按协议特定格式
  let body;
  if (status === 401) {
    body = protocol === 'anthropic'
      ? { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }
      : { error: { message: 'Incorrect API key', type: 'invalid_request_error', code: 'invalid_api_key' } };
  } else if (status === 429) {
    body = protocol === 'anthropic'
      ? { type: 'error', error: { type: 'rate_limit_error', message: 'rate limit exceeded' } }
      : { error: { message: 'Rate limit exceeded', type: 'invalid_request_error', code: 'rate_limit_exceeded' } };
  } else if (status === 500) {
    body = protocol === 'anthropic'
      ? { type: 'error', error: { type: 'api_error', message: 'internal server error' } }
      : { error: { message: 'Internal server error', type: 'invalid_request_error', code: 'server_error' } };
  } else {
    res.writeHead(status); res.end(); return;
  }

  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) });
  res.end(data);
}

await new Promise(r => upstream.listen(UPSTREAM_PORT, '127.0.0.1', r));

// ==================== 配置 ====================

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

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond, detail });
  console.log(`  ${cond ? '✓ PASS' : '✗ FAIL'}  ${name}${detail && !cond ? '  →  ' + detail : ''}`);
}

async function post(url, headers, body) {
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
    return { status: res.status, body: await res.text() };
  } catch (e) { return { status: 0, body: String(e) }; }
}

const REQ_BODIES = {
  'anthropic-messages': { model: 'claude-sonnet-4-5', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] },
  'openai-chat':       { model: 'gpt-4o', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] },
  'openai-responses':  { model: 'gpt-4o', input: 'hi' },
};
const PATHS = {
  'anthropic-messages': '/v1/messages',
  'openai-chat':       '/v1/chat/completions',
  'openai-responses':  '/v1/responses',
};
const HEADERS = {
  'anthropic-messages': { 'x-api-key': 'sk-x', 'anthropic-version': '2023-06-01' },
  'openai-chat':       { 'authorization': 'Bearer sk-x' },
  'openai-responses':  { 'authorization': 'Bearer sk-x' },
};

function readLogEntries() {
  const files = readdirSync(join(CONFIG_DIR, 'logs')).filter(f => f.endsWith('.jsonl')).sort();
  if (!files.length) return [];
  return readFileSync(join(CONFIG_DIR, 'logs', files[files.length - 1]), 'utf-8')
    .split(/\n---\n/).filter(s => s.trim().startsWith('{')).map(s => JSON.parse(s));
}

async function waitFor(proc, regex, label, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(`${label} timeout`)), timeoutMs);
    let done = false;
    proc.stdout.on('data', d => { if (!done && regex.test(d.toString())) { done = true; clearTimeout(to); resolve(); } });
    proc.on('exit', c => { if (!done) reject(new Error(`${label} exit ${c}`)); });
  });
}

async function waitForPort(url, label, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { const r = await fetch(url); if (r.status > 0) return; } catch {}
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error(`${label} port never accepted`);
}

// 单个错误码 × 协议 × 供应商 的 5 环节验收
async function verifyOneCombo(provider, protocol, status) {
  console.log(`\n  ┌─ ${provider} × ${protocol} × ${status} ─┐`);
  upstreamStatus = status;
  upstreamHits.length = 0;

  const beforeCount = results.length;

  // ① 客户端收到对应 status 码
  const res = await post(`http://127.0.0.1:${PROXY_PORT}/custom/${provider}${PATHS[protocol]}`, HEADERS[protocol], REQ_BODIES[protocol]);
  check(`① ${provider} ${protocol} ${status}: 客户端收到 status=${status}`,
    res.status === status, `实际 status=${res.status} body 前 80: ${res.body.slice(0, 80)}`);

  // ② 错误 body 原样透传(协议特定字段)
  let bodyOk = false;
  let bodyDetail = '';
  try {
    const j = JSON.parse(res.body);
    if (status === 200) {
      // 200: 简单断言有内容
      bodyOk = (protocol === 'anthropic-messages' && j.content?.[0]?.text === 'OK')
        || (protocol === 'openai-chat' && j.choices?.[0]?.message?.content === 'OK')
        || (protocol === 'openai-responses' && j.output?.[0]?.content?.[0]?.text === 'OK');
      bodyDetail = `body type=${j.type || j.object}`;
    } else {
      // 4xx/5xx: 错误体按协议特定格式原样透传
      if (protocol === 'anthropic-messages') {
        bodyOk = j.type === 'error' && j.error && typeof j.error.type === 'string' && typeof j.error.message === 'string';
        bodyDetail = `error.type=${j.error?.type}`;
      } else {
        // openai-chat + openai-responses 错误格式相同
        bodyOk = j.error && typeof j.error.message === 'string' && typeof j.error.code === 'string';
        bodyDetail = `error.code=${j.error?.code}`;
      }
    }
  } catch (e) {
    bodyDetail = `JSON parse 失败: ${e.message}`;
  }
  check(`② ${provider} ${protocol} ${status}: 错误/成功 body 原样透传`, bodyOk, bodyDetail);

  // ③ 日志记录 status
  await new Promise(r => setTimeout(r, 400));
  const entries = readLogEntries().filter(e => e.providerName === provider && e.endpointType === protocol);
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
  const apiEntry = (apiJson.logs || apiJson).find(l => l.id === log.id);
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
  await page.goto(`http://127.0.0.1:${VITE_PORT}/?log=${log.id}&tab=response`);
  await page.waitForTimeout(500);
  // 列表行里的状态码文本(数字)
  await page.goto(`http://127.0.0.1:${VITE_PORT}/`);
  await page.waitForTimeout(300);
  const rowLocator = page.locator(`[data-testid="log-row"][data-logid="${log.id}"]`);
  const rowText = await rowLocator.textContent().catch(() => '');
  const statusTextOk = rowText.includes(String(status));
  check(`⑤ ${provider} ${protocol} ${status}: Web UI 日志列表展示 status=${status}`, statusTextOk, `row text 前 80: ${rowText.slice(0, 80)}`);
  await browser.close();

  return results.length - beforeCount;
}

try {
  await waitFor(backend, /Lucent|代理|listen|启动/i, 'backend');
  await waitFor(vite, /Local:|ready in/i, 'vite');
  await waitForPort(`http://127.0.0.1:${VITE_PORT}/`, 'vite');
  await new Promise(r => setTimeout(r, 1000));

  console.log(`\n========== 自定义供应商错误路径全链路验收 ==========`);
  console.log(`  mock upstream: http://127.0.0.1:${UPSTREAM_PORT}/v1 (3 协议错误格式)`);
  console.log(`  后端: proxy=${PROXY_PORT} web=${WEB_PORT} vite=${VITE_PORT}`);
  console.log(`  供应商: hxy + hxy2 × 状态码: 200/401/429/500`);
  console.log(`  验收点: 2 × 3 × 4 × 5 = 120\n`);

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
  upstream.close();
  await new Promise(r => setTimeout(r, 500));
  try { rmSync(CONFIG_DIR, { recursive: true, force: true }); } catch {}
}

const pass = results.filter(r => r.ok).length;
const fail = results.length - pass;
console.log('');
console.log('='.repeat(56));
console.log(`  ${pass}/${results.length} 通过, ${fail} 失败 (目标 120/120)`);
console.log('='.repeat(56));
if (fail > 0) {
  console.log('\n失败项:');
  results.filter(r => !r.ok).forEach(r => console.log(`  - ${r.name}${r.detail ? ' (' + r.detail + ')' : ''}`));
}
process.exit(fail === 0 ? 0 : 1);
