#!/usr/bin/env node
/**
 * scripts/verify-openai-chat-e2e.mjs — OpenAI Chat Completions 协议全链路端到端验收
 *
 * 对应 openspec/specs/protocol-chain-verification/spec.md
 *
 * 用法: npm run verify:openai-chat
 *
 * 覆盖 5 个环节 × 2 种响应模式（流式 SSE + 非流式 JSON）= 10 个断言组:
 *   ① 请求构造（下游 → proxy）  ② 真实响应  ③ 日志记录  ④ /api/logs 接口  ⑤ Web UI 渲染
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

const CONFIG_DIR = mkdtempSync(join(tmpdir(), 'lucent-oai-chat-verify-'));
const BASE = 49000 + Math.floor(Math.random() * 3000);
const UPSTREAM_PORT = BASE;
const PROXY_PORT = BASE + 1;
const WEB_PORT = BASE + 2;
const VITE_PORT = BASE + 3;
const UPSTREAM_BASE = `http://127.0.0.1:${UPSTREAM_PORT}/v1`;

// ==================== mock 上游（OpenAI Chat 格式）====================

let upstreamMode = 'sse';
const upstreamHits = [];

const upstream = createServer((req, res) => {
  let body = '';
  req.on('data', c => (body += c));
  req.on('end', () => {
    upstreamHits.push({ url: req.url, method: req.method, body });
    if (upstreamMode === 'sse') respondChatSSE(res);
    else respondChatJSON(res);
  });
});

function respondChatSSE(res) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const events = [
    `data: ${JSON.stringify({ id: 'chatcmpl-v', object: 'chat.completion.chunk', model: 'gpt-4o', choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] })}\n\n`,
    `data: ${JSON.stringify({ id: 'chatcmpl-v', object: 'chat.completion.chunk', model: 'gpt-4o', choices: [{ index: 0, delta: { content: 'Hello! ' } }] })}\n\n`,
    `data: ${JSON.stringify({ id: 'chatcmpl-v', object: 'chat.completion.chunk', model: 'gpt-4o', choices: [{ index: 0, delta: { content: 'How can I help?' } }] })}\n\n`,
    `data: ${JSON.stringify({ id: 'chatcmpl-v', object: 'chat.completion.chunk', model: 'gpt-4o', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18, prompt_tokens_details: { cached_tokens: 0, audio_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0, audio_tokens: 0 } } })}\n\n`,
    `data: [DONE]\n\n`,
  ];
  let i = 0;
  const iv = setInterval(() => {
    if (i < events.length) { res.write(events[i]); i++; }
    else { clearInterval(iv); res.end(); }
  }, 10);
}

function respondChatJSON(res) {
  // 完整 schema 按 docs/protocols/02-openai-chat-completions.md
  const payload = {
    id: 'chatcmpl-v-json', object: 'chat.completion', model: 'gpt-4o',
    service_tier: 'default', system_fingerprint: 'fp_e2e',
    choices: [{ index: 0, message: { role: 'assistant', content: 'Hello! How can I help?', refusal: null }, finish_reason: 'stop', logprobs: null }],
    usage: {
      prompt_tokens: 10, completion_tokens: 5, total_tokens: 15,
      prompt_tokens_details: { cached_tokens: 0, audio_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 0, audio_tokens: 0 },
    },
  };
  const data = JSON.stringify(payload);
  res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) });
  res.end(data);
}

await new Promise(r => upstream.listen(UPSTREAM_PORT, '127.0.0.1', r));

// ==================== 配置（预设 openai 供应商 + openai-chat 端点）====================

writeFileSync(join(CONFIG_DIR, 'config.json'), JSON.stringify({
  host: '127.0.0.1',
  proxyPort: PROXY_PORT,
  webPort: WEB_PORT,
  providers: [{
    id: 'p-openai', name: 'openai',
    endpoints: {
      'anthropic-messages': null,
      'openai-chat': UPSTREAM_BASE,
      'openai-responses': null,
    },
  }],
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

const OAI_HEADERS = { authorization: 'Bearer sk-x' };
const REQ_BODY = {
  model: 'gpt-4o',
  max_tokens: 1,
  messages: [
    { role: 'user', content: 'What is latin for Ant?' },
    { role: 'assistant', content: 'The answer is (' },
  ],
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

try {
  await waitFor(backend, /Lucent|代理|listen|启动/i, 'backend');
  await waitFor(vite, /Local:|ready in/i, 'vite');
  await waitForPort(`http://127.0.0.1:${VITE_PORT}/`, 'vite');
  await new Promise(r => setTimeout(r, 1000));

  console.log(`\n========== OpenAI Chat 协议全链路验收 ==========\n`);
  console.log(`  上游: http://127.0.0.1:${UPSTREAM_PORT}/v1  proxy=${PROXY_PORT} web=${WEB_PORT} vite=${VITE_PORT}\n`);

  const PROXY = `http://127.0.0.1:${PROXY_PORT}`;
  const WEB = `http://127.0.0.1:${WEB_PORT}`;

  // ============================================================
  console.log('【模式 1: 流式 SSE】');
  upstreamMode = 'sse';
  upstreamHits.length = 0;

  const sseRes = await post(`${PROXY}/openai/v1/chat/completions`, OAI_HEADERS, REQ_BODY);
  check('SSE-①② 客户端收到 chat.completion.chunk 流(含 [DONE])',
    sseRes.body.includes('chat.completion.chunk') && sseRes.body.includes('[DONE]'),
    `status=${sseRes.status} body 前 80: ${sseRes.body.slice(0, 80)}`);

  await new Promise(r => setTimeout(r, 600));
  const sseEntries = readLogEntries().filter(e => e.providerName === 'openai' && e.endpointType === 'openai-chat');
  const sseLog = sseEntries[sseEntries.length - 1];

  check('SSE-③ 日志 body.messages 完整(2 条) + response 是 sse_raw',
    sseLog?.body?.messages?.length === 2 && (sseLog?.response?.body?.type === 'sse_raw' || Array.isArray(sseLog?.response?.body?.lines)),
    `msgs=${sseLog?.body?.messages?.length} resp.type=${sseLog?.response?.body?.type}`);

  const apiRes1 = await fetch(`${WEB}/api/logs?limit=50`);
  const apiJson1 = await apiRes1.json();
  const apiSseEntry = (apiJson1.logs || apiJson1).find(l => l.id === sseLog?.id);
  check('SSE-④ /api/logs 返回 entry.request.body.messages.length===2',
    apiSseEntry?.request?.body?.messages?.length === 2, `len=${apiSseEntry?.request?.body?.messages?.length}`);

  {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${VITE_PORT}/?log=${sseLog.id}&tab=request`);
    await page.getByTestId('tab-request').click().catch(() => {});
    await page.waitForTimeout(300);
    const reqVisible = await page.getByTestId('request-body').isVisible().catch(() => false);
    const reqText = reqVisible ? (await page.getByTestId('request-body').textContent()) : '';
    check('SSE-⑤a Request tab 渲染 request-body 含 "messages"',
      reqVisible && reqText.includes('messages'), `visible=${reqVisible}`);

    await page.getByTestId('tab-context').click().catch(() => {});
    await page.waitForTimeout(300);
    const itemCount = await page.getByTestId('context-item').count();
    const userCount = await page.locator('[data-testid="context-item"][data-role="user"]').count();
    const asstCount = await page.locator('[data-testid="context-item"][data-role="assistant"]').count();
    check('SSE-⑤b Context tab 渲染 context-item(user=1, assistant=1)',
      itemCount >= 2 && userCount >= 1 && asstCount >= 1, `items=${itemCount} user=${userCount} asst=${asstCount}`);

    await page.goto(`http://127.0.0.1:${VITE_PORT}/`);
    await page.waitForTimeout(500);
    const rowCount = await page.getByTestId('log-row').count();
    check('SSE-⑤c 日志列表渲染 log-row', rowCount >= 1, `rows=${rowCount}`);
    await browser.close();
  }

  // ============================================================
  console.log('\n【模式 2: 非流式 JSON】');
  upstreamMode = 'json';
  upstreamHits.length = 0;

  const jsonRes = await post(`${PROXY}/openai/v1/chat/completions`, OAI_HEADERS, REQ_BODY);
  check('JSON-①② 客户端收到完整 chat.completion JSON(含 choices[0].message.content)',
    jsonRes.status === 200 && jsonRes.body.includes('"choices"') && jsonRes.body.includes('Hello! How can I help?'),
    `status=${jsonRes.status} body 前 80: ${jsonRes.body.slice(0, 80)}`);

  await new Promise(r => setTimeout(r, 400));
  const jsonEntries = readLogEntries().filter(e => e.providerName === 'openai' && e.endpointType === 'openai-chat');
  const jsonLog = jsonEntries[jsonEntries.length - 1];
  const jsonLogBody = jsonLog?.response?.body;
  check('JSON-③ 日志 response.body.choices[0].message.content 完整',
    jsonLogBody?.choices?.[0]?.message?.content === 'Hello! How can I help?' && jsonLogBody?.object === 'chat.completion',
    `content=${jsonLogBody?.choices?.[0]?.message?.content}`);

  // JSON 模式 usage 详细字段 (按 docs § 2 CompletionUsage)
  const hasCachedTokens = jsonLogBody?.usage?.prompt_tokens_details?.cached_tokens !== undefined;
  const hasReasoningTokens = jsonLogBody?.usage?.completion_tokens_details?.reasoning_tokens !== undefined;
  check('JSON-③ usage 详细字段存在(cached_tokens + reasoning_tokens)',
    hasCachedTokens && hasReasoningTokens,
    `cached=${hasCachedTokens} reasoning=${hasReasoningTokens}`);

  const apiRes2 = await fetch(`${WEB}/api/logs?limit=50`);
  const apiJson2 = await apiRes2.json();
  const apiJsonEntry = (apiJson2.logs || apiJson2).find(l => l.id === jsonLog?.id);
  check('JSON-④ /api/logs 返回 response.body.choices[0].message.content',
    apiJsonEntry?.response?.body?.choices?.[0]?.message?.content === 'Hello! How can I help?',
    `content=${apiJsonEntry?.response?.body?.choices?.[0]?.message?.content}`);

  {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${VITE_PORT}/?log=${jsonLog.id}&tab=response`);
    await page.waitForTimeout(500);
    const respVisible = await page.getByTestId('response-body').isVisible().catch(() => false);
    const respText = respVisible ? (await page.getByTestId('response-body').textContent()) : '';
    check('JSON-⑤ Response tab 渲染 response-body 含 "choices"',
      respVisible && respText.includes('choices'), `visible=${respVisible}`);
    await browser.close();
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
console.log(`  ${pass}/${results.length} 通过, ${fail} 失败`);
console.log('='.repeat(56));
if (fail > 0) {
  console.log('\n失败项:');
  results.filter(r => !r.ok).forEach(r => console.log(`  - ${r.name}${r.detail ? ' (' + r.detail + ')' : ''}`));
}
process.exit(fail === 0 ? 0 : 1);
