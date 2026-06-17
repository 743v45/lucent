#!/usr/bin/env node
/**
 * scripts/verify-custom-providers-e2e.mjs — 自定义供应商全链路端到端验收
 *
 * 对应 openspec/specs/protocol-chain-verification/spec.md
 *
 * 用法: npm run verify:custom
 *
 * 1 个 mock upstream（同时处理 anthropic-messages / openai-chat / openai-responses 三种协议）
 * × 2 个自定义供应商（hxy + hxy2，临时配齐 3 协议都指向 mock）
 * × 2 种响应模式（流式 SSE + 非流式 JSON）
 * × 5 个验收环节（请求/响应/日志/API/UI）
 * = 60 个验收点
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

const CONFIG_DIR = mkdtempSync(join(tmpdir(), 'lucent-custom-verify-'));
const BASE = 55000 + Math.floor(Math.random() * 3000);
const UPSTREAM_PORT = BASE;
const PROXY_PORT = BASE + 1;
const WEB_PORT = BASE + 2;
const VITE_PORT = BASE + 3;
const UPSTREAM_BASE = `http://127.0.0.1:${UPSTREAM_PORT}/v1`;

// ==================== Mock 上游：1 个处理 3 协议 ====================

// 记录每个请求的"协议类型", 用于断言
// 协议: 'anthropic' | 'openai-chat' | 'openai-responses'
const upstreamHits = [];
let upstreamMode = 'sse';  // 'sse' | 'json'

const upstream = createServer((req, res) => {
  let body = '';
  req.on('data', c => (body += c));
  req.on('end', () => {
    const url = req.url || '/';
    let protocol;
    if (url.includes('/messages')) protocol = 'anthropic';
    else if (url.includes('/chat/completions')) protocol = 'openai-chat';
    else if (url.includes('/responses')) protocol = 'openai-responses';
    else {
      res.writeHead(404); res.end(); return;
    }

    upstreamHits.push({ url, method: req.method, headers: req.headers, body, protocol });
    if (upstreamMode === 'sse') respondSSE(res, protocol);
    else respondJSON(res, protocol);
  });
});

function respondSSE(res, protocol) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const events = sseEventsFor(protocol);
  let i = 0;
  const iv = setInterval(() => {
    if (i < events.length) { res.write(events[i]); i++; }
    else { clearInterval(iv); res.end(); }
  }, 10);
}

function respondJSON(res, protocol) {
  const payload = jsonBodyFor(protocol);
  const data = JSON.stringify(payload);
  res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) });
  res.end(data);
}

function sseEventsFor(protocol) {
  if (protocol === 'anthropic') {
    return [
      `event: message_start\ndata: ${JSON.stringify({ type:'message_start', message:{ id:'msg_c', type:'message', role:'assistant', model:'claude-sonnet-4-5', content:[], stop_reason:null, stop_sequence:null, usage:{input_tokens:10,output_tokens:0} } })}\n\n`,
      `event: content_block_start\ndata: ${JSON.stringify({ type:'content_block_start', index:0, content_block:{ type:'text', text:'' } })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type:'content_block_delta', index:0, delta:{ type:'text_delta', text:'Hello! How can I help?' } })}\n\n`,
      `event: content_block_stop\ndata: ${JSON.stringify({ type:'content_block_stop', index:0 })}\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({ type:'message_delta', delta:{ stop_reason:'end_turn', stop_sequence:null }, usage:{output_tokens:5} })}\n\n`,
      `event: message_stop\ndata: ${JSON.stringify({ type:'message_stop' })}\n\n`,
    ];
  }
  if (protocol === 'openai-chat') {
    return [
      `data: ${JSON.stringify({ id:'cmpl_c', object:'chat.completion.chunk', model:'gpt-4o', choices:[{ index:0, delta:{ role:'assistant', content:'' } }] })}\n\n`,
      `data: ${JSON.stringify({ id:'cmpl_c', object:'chat.completion.chunk', model:'gpt-4o', choices:[{ index:0, delta:{ content:'Hello! How can I help?' } }] })}\n\n`,
      `data: ${JSON.stringify({ id:'cmpl_c', object:'chat.completion.chunk', model:'gpt-4o', choices:[{ index:0, delta:{}, finish_reason:'stop' }], usage:{ prompt_tokens:10, completion_tokens:5, total_tokens:15 } })}\n\n`,
      `data: [DONE]\n\n`,
    ];
  }
  // openai-responses
  return [
    `event: response.output_text.delta\ndata: ${JSON.stringify({ type:'response.output_text.delta', output_index:0, content_index:0, delta:'Hello! World.' })}\n\n`,
    `event: response.completed\ndata: ${JSON.stringify({ type:'response.completed', response:{ id:'resp_c', object:'response', status:'completed', output:[{ type:'message', content:[{ type:'output_text', text:'Hello! World.' }] }], usage:{ input_tokens:10, output_tokens:5, total_tokens:15 } } })}\n\n`,
  ];
}

function jsonBodyFor(protocol) {
  if (protocol === 'anthropic') {
    return { id:'msg_c_json', type:'message', role:'assistant', model:'claude-sonnet-4-5',
      content:[{ type:'text', text:'Hello! How can I help?' }],
      stop_reason:'end_turn', stop_sequence:null, usage:{ input_tokens:10, output_tokens:5 } };
  }
  if (protocol === 'openai-chat') {
    return { id:'cmpl_c_json', object:'chat.completion', model:'gpt-4o',
      choices:[{ index:0, message:{ role:'assistant', content:'Hello! How can I help?' }, finish_reason:'stop' }],
      usage:{ prompt_tokens:10, completion_tokens:5, total_tokens:15 } };
  }
  // openai-responses
  return { id:'resp_c_json', object:'response', status:'completed', model:'gpt-4o',
    output:[{ type:'message', content:[{ type:'output_text', text:'Hello! World.' }] }],
    usage:{ input_tokens:10, output_tokens:5, total_tokens:15 } };
}

await new Promise(r => upstream.listen(UPSTREAM_PORT, '127.0.0.1', r));

// ==================== 配置：hxy + hxy2 都配齐 3 协议 ====================

writeFileSync(join(CONFIG_DIR, 'config.json'), JSON.stringify({
  host: '127.0.0.1',
  proxyPort: PROXY_PORT,
  webPort: WEB_PORT,
  providers: [
    {
      id: 'p-hxy', name: 'hxy',
      endpoints: {
        'anthropic-messages': UPSTREAM_BASE,
        'openai-chat': UPSTREAM_BASE,
        'openai-responses': UPSTREAM_BASE,
      },
    },
    {
      id: 'p-hxy2', name: 'hxy2',
      endpoints: {
        'anthropic-messages': UPSTREAM_BASE,
        'openai-chat': UPSTREAM_BASE,
        'openai-responses': UPSTREAM_BASE,
      },
    },
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
  'anthropic-messages': { model: 'claude-sonnet-4-5', max_tokens: 1, messages: [{ role:'user', content:'hi' }, { role:'assistant', content:'The answer is (' }] },
  'openai-chat':       { model: 'gpt-4o', max_tokens: 1, messages: [{ role:'user', content:'hi' }, { role:'assistant', content:'The answer is (' }] },
  'openai-responses':  { model: 'gpt-4o', input: 'What is latin for Ant?' },
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

// 单个协议验收 5 环节
async function verifyOneCombo(provider, protocol, mode) {
  console.log(`\n  ┌─ ${provider} × ${protocol} × ${mode} ─┐`);
  upstreamMode = mode;
  upstreamHits.length = 0;

  const beforeCount = results.length;

  // ① 请求构造
  const res = await post(`http://127.0.0.1:${PROXY_PORT}/custom/${provider}${PATHS[protocol]}`, HEADERS[protocol], REQ_BODIES[protocol]);
  // ② 真实响应（按 mode 分别断言：SSE 查事件名, JSON 查结构）
  let respOk = false;
  let respDetail = `status=${res.status} body 前 60: ${res.body.slice(0, 60)}`;
  if (mode === 'sse') {
    if (protocol === 'anthropic-messages') {
      respOk = res.body.includes('message_start') && res.body.includes('content_block_delta') && res.body.includes('message_stop');
    } else if (protocol === 'openai-chat') {
      respOk = res.body.includes('chat.completion.chunk') && res.body.includes('[DONE]');
    } else {
      respOk = res.body.includes('response.output_text.delta') && res.body.includes('response.completed');
    }
  } else {
    // JSON 模式: 解析后断言协议特定字段
    try {
      const j = JSON.parse(res.body);
      if (protocol === 'anthropic-messages') {
        respOk = j.type === 'message' && j.role === 'assistant' && j.content?.[0]?.text === 'Hello! How can I help?';
      } else if (protocol === 'openai-chat') {
        respOk = j.object === 'chat.completion' && j.choices?.[0]?.message?.content === 'Hello! How can I help?';
      } else {
        respOk = j.object === 'response' && j.output?.[0]?.content?.[0]?.text === 'Hello! World.';
      }
      if (!respOk) respDetail = `JSON 解析成功但断言不匹配: type=${j.type} obj=${j.object} text=${j.content?.[0]?.text || j.choices?.[0]?.message?.content || j.output?.[0]?.content?.[0]?.text}`;
    } catch (e) {
      respDetail = `JSON 解析失败: ${e.message}`;
    }
  }
  check(`①② ${provider} ${protocol} ${mode}: 客户端收到正确响应`, respOk, respDetail);

  // ③ 日志
  await new Promise(r => setTimeout(r, mode === 'sse' ? 600 : 400));
  const entries = readLogEntries().filter(e => e.providerName === provider && e.endpointType === protocol);
  const log = entries[entries.length - 1];
  let logOk = false;
  let logDetail = `no log`;
  if (log) {
    if (protocol === 'openai-responses') {
      logOk = log?.body?.input === 'What is latin for Ant?' && (log?.response?.body?.type === 'sse_raw' || Array.isArray(log?.response?.body?.lines) || log?.response?.body?.output?.[0]?.content?.[0]?.text);
    } else {
      logOk = log?.body?.messages?.length === 2 && (log?.response?.body?.type === 'sse_raw' || Array.isArray(log?.response?.body?.lines) || log?.response?.body?.choices?.[0]?.message?.content || log?.response?.body?.content?.[0]?.text);
    }
    logDetail = `msgs=${log?.body?.messages?.length} input=${log?.body?.input} resp.type=${log?.response?.body?.type}`;
  }
  check(`③ ${provider} ${protocol} ${mode}: 日志 body 完整 + response 已存`, logOk, logDetail);

  if (!log) return;  // 没有日志后续无法继续

  // ④ /api/logs
  const apiRes = await fetch(`http://127.0.0.1:${WEB_PORT}/api/logs?limit=200`);
  const apiJson = await apiRes.json();
  const apiEntry = (apiJson.logs || apiJson).find(l => l.id === log.id);
  let apiOk = false;
  let apiDetail = `not found`;
  if (apiEntry) {
    if (protocol === 'openai-responses') {
      apiOk = apiEntry?.request?.body?.input === 'What is latin for Ant?';
      apiDetail = `input=${apiEntry?.request?.body?.input}`;
    } else {
      apiOk = apiEntry?.request?.body?.messages?.length === 2;
      apiDetail = `msgs=${apiEntry?.request?.body?.messages?.length}`;
    }
  }
  check(`④ ${provider} ${protocol} ${mode}: /api/logs 返回 entry`, apiOk, apiDetail);

  // ⑤ Web UI
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${VITE_PORT}/?log=${log.id}&tab=request`);
  await page.waitForTimeout(500);
  const reqVisible = await page.getByTestId('request-body').isVisible().catch(() => false);
  const reqText = reqVisible ? (await page.getByTestId('request-body').textContent()) : '';
  // 协议特定: anthropic/openai-chat 用 messages, openai-responses 用 input
  const protocolKey = protocol === 'openai-responses' ? 'input' : 'messages';
  check(`⑤ ${provider} ${protocol} ${mode}: Web UI 渲染 request-body 含 "${protocolKey}"`,
    reqVisible && reqText.includes(protocolKey), `visible=${reqVisible}`);

  // 列表 log-row 也得能看见(点开过详情就能回来)
  await page.goto(`http://127.0.0.1:${VITE_PORT}/`);
  await page.waitForTimeout(300);
  const rowCount = await page.getByTestId('log-row').count();
  check(`⑤ ${provider} ${protocol} ${mode}: 日志列表渲染 log-row`, rowCount >= 1, `rows=${rowCount}`);

  await browser.close();

  return results.length - beforeCount;
}

try {
  await waitFor(backend, /Lucent|代理|listen|启动/i, 'backend');
  await waitFor(vite, /Local:|ready in/i, 'vite');
  await waitForPort(`http://127.0.0.1:${VITE_PORT}/`, 'vite');
  await new Promise(r => setTimeout(r, 1000));

  console.log(`\n========== 自定义供应商全链路验收 ==========`);
  console.log(`  mock upstream: http://127.0.0.1:${UPSTREAM_PORT}/v1 (3 协议)`);
  console.log(`  后端: proxy=${PROXY_PORT} web=${WEB_PORT} vite=${VITE_PORT}`);
  console.log(`  供应商: hxy + hxy2 (临时配齐 3 协议)`);
  console.log(`  模式: 流式 SSE + 非流式 JSON`);
  console.log(`  验收点: 2 供应商 × 3 协议 × 2 模式 × 5 环节 = 60\n`);

  for (const provider of ['hxy', 'hxy2']) {
    for (const protocol of ['anthropic-messages', 'openai-chat', 'openai-responses']) {
      await verifyOneCombo(provider, protocol, 'sse');
      await verifyOneCombo(provider, protocol, 'json');
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
console.log(`  ${pass}/${results.length} 通过, ${fail} 失败 (目标 60/60)`);
console.log('='.repeat(56));
if (fail > 0) {
  console.log('\n失败项:');
  results.filter(r => !r.ok).forEach(r => console.log(`  - ${r.name}${r.detail ? ' (' + r.detail + ')' : ''}`));
}
process.exit(fail === 0 ? 0 : 1);
