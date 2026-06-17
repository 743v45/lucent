#!/usr/bin/env node
/**
 * scripts/verify-anthropic-e2e.mjs — Anthropic 协议全链路端到端验收
 *
 * 对应 openspec/specs/protocol-chain-verification/spec.md
 *
 * 用法: npm run verify:anthropic
 *
 * 覆盖 5 个环节 × 2 种响应模式（流式 SSE + 非流式 JSON）= 10 个断言组:
 *   ① 请求构造（下游 → proxy）
 *   ② 真实响应（mock 上游 → 客户端收到的字节流）
 *   ③ 日志记录（.jsonl 文件内容）
 *   ④ /api/logs 接口返回
 *   ⑤ Web UI 渲染（playwright + data-testid）
 *
 * 隔离: 临时 config + 4 个随机端口（upstream/proxy/web/vite），不碰 ~/.lucent
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

const CONFIG_DIR = mkdtempSync(join(tmpdir(), 'lucent-anthropic-verify-'));
const BASE = 46000 + Math.floor(Math.random() * 3000);
const UPSTREAM_PORT = BASE;
const PROXY_PORT = BASE + 1;
const WEB_PORT = BASE + 2;
const VITE_PORT = BASE + 3;
const UPSTREAM_BASE = `http://127.0.0.1:${UPSTREAM_PORT}/v1`;

// ==================== mock 上游（Anthropic 格式）====================

let upstreamMode = 'sse';  // 'sse' | 'json'
const upstreamHits = [];

const upstream = createServer((req, res) => {
  let body = '';
  req.on('data', c => (body += c));
  req.on('end', () => {
    upstreamHits.push({ url: req.url, method: req.method, body });
    if (upstreamMode === 'sse') {
      respondAnthropicSSE(res);
    } else {
      respondAnthropicJSON(res);
    }
  });
});

function respondAnthropicSSE(res) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const events = [
    `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_v', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } })}\n\n`,
    `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello! How can I help?' } })}\n\n`,
    `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`,
    `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } })}\n\n`,
    `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
  ];
  let i = 0;
  const iv = setInterval(() => {
    if (i < events.length) { res.write(events[i]); i++; }
    else { clearInterval(iv); res.end(); }
  }, 10);
}

function respondAnthropicJSON(res) {
  const payload = {
    id: 'msg_v_json', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5',
    content: [{ type: 'text', text: 'Hello! How can I help?' }],
    stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  };
  const data = JSON.stringify(payload);
  res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) });
  res.end(data);
}

await new Promise(r => upstream.listen(UPSTREAM_PORT, '127.0.0.1', r));

// ==================== 配置（自定义供应商 hxy + anthropic-messages 端点）====================

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

// ==================== 启动 vite dev（SPA + /api 代理到 WEB_PORT）====================

const vite = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(VITE_PORT), '--strictPort'], {
  cwd: REPO_ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    LUCENT_WEB_PORT: String(WEB_PORT),
  },
});

// ==================== 工具 ====================

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond, detail });
  const tag = cond ? '✓ PASS' : '✗ FAIL';
  console.log(`  ${tag}  ${name}${detail && !cond ? '  →  ' + detail : ''}`);
}

async function post(url, headers, body) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text };
  } catch (e) {
    return { status: 0, body: String(e) };
  }
}

const ANTH_HEADERS = { 'x-api-key': 'sk-x', 'anthropic-version': '2023-06-01' };
const REQ_BODY = {
  model: 'claude-sonnet-4-5',
  max_tokens: 1,
  messages: [
    { role: 'user', content: 'What is latin for Ant?' },
    { role: 'assistant', content: 'The answer is (' },
  ],
};

// 读最新日志的所有 entry
function readLogEntries() {
  const logDir = join(CONFIG_DIR, 'logs');
  const files = readdirSync(logDir).filter(f => f.endsWith('.jsonl')).sort();
  if (files.length === 0) return [];
  const content = readFileSync(join(logDir, files[files.length - 1]), 'utf-8');
  return content.split(/\n---\n/).filter(s => s.trim().startsWith('{')).map(s => JSON.parse(s));
}

// ==================== 等待服务就绪 ====================

async function waitFor(proc, regex, label, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(`${label} startup timeout`)), timeoutMs);
    let done = false;
    proc.stdout.on('data', d => {
      if (!done && regex.test(d.toString())) {
        done = true; clearTimeout(to); resolve();
      }
    });
    proc.on('exit', c => { if (!done) reject(new Error(`${label} exit ${c}`)); });
  });
}

// 等待端口可连(vite ready 后可能还有几百毫秒才真正 accept)
async function waitForPort(url, label, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.status > 0) return;
    } catch {}
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error(`${label} port never accepted: ${url}`);
}

try {
  await waitFor(backend, /Lucent|代理|listen|启动/i, 'backend');
  await waitFor(vite, /Local:|ready in/i, 'vite');
  await waitForPort(`http://127.0.0.1:${VITE_PORT}/`, 'vite');
  await new Promise(r => setTimeout(r, 1000));

  console.log(`\n========== Anthropic 协议全链路验收 ==========\n`);
  console.log(`  上游 mock: http://127.0.0.1:${UPSTREAM_PORT}/v1`);
  console.log(`  后端:     proxy=${PROXY_PORT} web=${WEB_PORT}`);
  console.log(`  vite:     ${VITE_PORT}（playwright 访问这里）`);
  console.log('');

  const PROXY = `http://127.0.0.1:${PROXY_PORT}`;
  const WEB = `http://127.0.0.1:${WEB_PORT}`;

  // ============================================================
  // 模式 1: 流式 SSE
  // ============================================================
  console.log('【模式 1: 流式 SSE】');
  upstreamMode = 'sse';
  upstreamHits.length = 0;

  // ① 请求构造 + ② 真实响应（SSE）
  const sseRes = await post(`${PROXY}/custom/hxy/v1/messages`, ANTH_HEADERS, REQ_BODY);
  check('SSE-①② 客户端收到 SSE 流(含 message_start/content_block_delta/message_stop)',
    sseRes.body.includes('message_start') && sseRes.body.includes('content_block_delta') && sseRes.body.includes('message_stop'),
    `status=${sseRes.status} body 前 80: ${sseRes.body.slice(0, 80)}`);

  await new Promise(r => setTimeout(r, 600));  // 等流式日志落盘
  const sseEntries = readLogEntries().filter(e => e.providerName === 'hxy');
  const sseLog = sseEntries[sseEntries.length - 1];

  // ③ 日志记录
  check('SSE-③ 日志 body.messages 完整(2 条) + response 是 sse_raw',
    sseLog?.body?.messages?.length === 2 && (sseLog?.response?.body?.type === 'sse_raw' || Array.isArray(sseLog?.response?.body?.lines)),
    `messages.len=${sseLog?.body?.messages?.length} resp.body.type=${sseLog?.response?.body?.type}`);

  // ④ /api/logs 接口
  const apiRes1 = await fetch(`${WEB}/api/logs?limit=50`);
  const apiJson1 = await apiRes1.json();
  const apiSseEntry = (apiJson1.logs || apiJson1).find(l => l.id === sseLog?.id);
  check('SSE-④ /api/logs 返回 entry.request.body.messages.length===2',
    apiSseEntry?.request?.body?.messages?.length === 2,
    `len=${apiSseEntry?.request?.body?.messages?.length}`);

  // ⑤ Web UI 渲染（playwright）
  {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${VITE_PORT}/?log=${sseLog.id}&tab=request`);

    // Request tab: request-body 容器可见且文本含 messages
    await page.getByTestId('tab-request').click().catch(() => {});
    await page.waitForTimeout(300);
    const reqBodyVisible = await page.getByTestId('request-body').isVisible().catch(() => false);
    const reqBodyText = reqBodyVisible ? (await page.getByTestId('request-body').textContent()) : '';
    check('SSE-⑤a Request tab 渲染 request-body 且含 "messages"',
      reqBodyVisible && reqBodyText.includes('messages'),
      `visible=${reqBodyVisible}`);

    // Context tab: context-item 数量 === 2，user/assistant 各 1
    await page.getByTestId('tab-context').click().catch(() => {});
    await page.waitForTimeout(300);
    const contextItems = page.getByTestId('context-item');
    const itemCount = await contextItems.count();
    const userCount = await page.locator('[data-testid="context-item"][data-role="user"]').count();
    const asstCount = await page.locator('[data-testid="context-item"][data-role="assistant"]').count();
    check('SSE-⑤b Context tab 渲染 2 个 context-item(user=1, assistant=1)',
      itemCount >= 2 && userCount >= 1 && asstCount >= 1,
      `items=${itemCount} user=${userCount} assistant=${asstCount}`);

    // 列表 log-row 可见
    await page.goto(`http://127.0.0.1:${VITE_PORT}/`);
    await page.waitForTimeout(500);
    const rowCount = await page.getByTestId('log-row').count();
    check('SSE-⑤c 日志列表渲染 log-row',
      rowCount >= 1, `rows=${rowCount}`);

    await browser.close();
  }

  // ============================================================
  // 模式 2: 非流式 JSON
  // ============================================================
  console.log('\n【模式 2: 非流式 JSON】');
  upstreamMode = 'json';
  upstreamHits.length = 0;

  const jsonRes = await post(`${PROXY}/custom/hxy/v1/messages`, ANTH_HEADERS, REQ_BODY);
  check('JSON-①② 客户端收到完整 JSON 响应(含 content + text)',
    jsonRes.status === 200 && jsonRes.body.includes('"content"') && jsonRes.body.includes('Hello! How can I help?'),
    `status=${jsonRes.status} body 前 80: ${jsonRes.body.slice(0, 80)}`);

  await new Promise(r => setTimeout(r, 400));
  const jsonEntries = readLogEntries().filter(e => e.providerName === 'hxy');
  const jsonLog = jsonEntries[jsonEntries.length - 1];

  // ③ 日志记录
  const jsonLogBody = jsonLog?.response?.body;
  check('JSON-③ 日志 response.body 是完整 JSON(含 content text)',
    jsonLogBody?.content?.[0]?.text === 'Hello! How can I help?' && jsonLogBody?.type === 'message',
    `content.text=${jsonLogBody?.content?.[0]?.text}`);

  // ④ /api/logs
  const apiRes2 = await fetch(`${WEB}/api/logs?limit=50`);
  const apiJson2 = await apiRes2.json();
  const apiJsonEntry = (apiJson2.logs || apiJson2).find(l => l.id === jsonLog?.id);
  check('JSON-④ /api/logs 返回 entry.request.body.messages.length===2 + response.body.content',
    apiJsonEntry?.request?.body?.messages?.length === 2 && apiJsonEntry?.response?.body?.content?.[0]?.text === 'Hello! How can I help?',
    `msgs=${apiJsonEntry?.request?.body?.messages?.length}`);

  // ⑤ Web UI 渲染
  {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${VITE_PORT}/?log=${jsonLog.id}&tab=response`);
    await page.waitForTimeout(500);

    const respBodyVisible = await page.getByTestId('response-body').isVisible().catch(() => false);
    const respText = respBodyVisible ? (await page.getByTestId('response-body').textContent()) : '';
    check('JSON-⑤ Response tab 渲染 response-body 且含 "content"',
      respBodyVisible && respText.includes('content'),
      `visible=${respBodyVisible}`);

    await browser.close();
  }

} finally {
  backend.kill('SIGTERM');
  vite.kill('SIGTERM');
  upstream.close();
  await new Promise(r => setTimeout(r, 500));
  try { rmSync(CONFIG_DIR, { recursive: true, force: true }); } catch {}
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
