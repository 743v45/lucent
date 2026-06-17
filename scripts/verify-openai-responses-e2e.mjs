#!/usr/bin/env node
/**
 * scripts/verify-openai-responses-e2e.mjs — OpenAI Responses 协议全链路端到端验收
 *
 * 对应 openspec/specs/protocol-chain-verification/spec.md
 *
 * 用法: npm run verify:openai-responses
 *
 * 关键差异(与 anthropic/openai-chat):
 *   - 请求 body 用 `input`(string 或 array), 不是 `messages`
 *   - 响应流事件: response.output_text.delta / response.completed
 *   - Context tab: input string 被转成 1 个 user context-item
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

const CONFIG_DIR = mkdtempSync(join(tmpdir(), 'lucent-oai-resp-verify-'));
const BASE = 52000 + Math.floor(Math.random() * 3000);
const UPSTREAM_PORT = BASE;
const PROXY_PORT = BASE + 1;
const WEB_PORT = BASE + 2;
const VITE_PORT = BASE + 3;
const UPSTREAM_BASE = `http://127.0.0.1:${UPSTREAM_PORT}/v1`;

// ==================== mock 上游（OpenAI Responses 格式）====================

let upstreamMode = 'sse';
const upstreamHits = [];

const upstream = createServer((req, res) => {
  let body = '';
  req.on('data', c => (body += c));
  req.on('end', () => {
    upstreamHits.push({ url: req.url, method: req.method, body });
    if (upstreamMode === 'sse') respondResponsesSSE(res);
    else respondResponsesJSON(res);
  });
});

function respondResponsesSSE(res) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  // 完整 8 事件链 (按 docs/protocols/03-openai-responses.md § 3)
  // created → output_item.added → content_part.added → output_text.delta × 2 →
  // output_text.done → content_part.done → output_item.done → response.completed
  const events = [
    `event: response.created\ndata: ${JSON.stringify({ type: 'response.created', sequence_number: 0, response: { id: 'resp-v', object: 'response', status: 'in_progress', model: 'gpt-4o' } })}\n\n`,
    `event: response.output_item.added\ndata: ${JSON.stringify({ type: 'response.output_item.added', output_index: 0, sequence_number: 1, item: { id: 'msg_e2e', type: 'message', role: 'assistant', status: 'in_progress', content: [] } })}\n\n`,
    `event: response.content_part.added\ndata: ${JSON.stringify({ type: 'response.content_part.added', content_index: 0, item_id: 'msg_e2e', output_index: 0, sequence_number: 2, part: { type: 'output_text', text: '', annotations: [] } })}\n\n`,
    `event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', content_index: 0, delta: 'Hello!', item_id: 'msg_e2e', output_index: 0, sequence_number: 3, logprobs: [] })}\n\n`,
    `event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', content_index: 0, delta: ' World.', item_id: 'msg_e2e', output_index: 0, sequence_number: 4, logprobs: [] })}\n\n`,
    `event: response.output_text.done\ndata: ${JSON.stringify({ type: 'response.output_text.done', content_index: 0, text: 'Hello! World.', item_id: 'msg_e2e', output_index: 0, sequence_number: 5, logprobs: [] })}\n\n`,
    `event: response.content_part.done\ndata: ${JSON.stringify({ type: 'response.content_part.done', content_index: 0, item_id: 'msg_e2e', output_index: 0, sequence_number: 6, part: { type: 'output_text', text: 'Hello! World.', annotations: [] } })}\n\n`,
    `event: response.output_item.done\ndata: ${JSON.stringify({ type: 'response.output_item.done', output_index: 0, sequence_number: 7, item: { id: 'msg_e2e', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Hello! World.', annotations: [] }] } })}\n\n`,
    `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', sequence_number: 8, response: { id: 'resp-v', object: 'response', status: 'completed', model: 'gpt-4o', output: [{ id: 'msg_e2e', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Hello! World.', annotations: [] }] }], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } })}\n\n`,
  ];
  let i = 0;
  const iv = setInterval(() => {
    if (i < events.length) { res.write(events[i]); i++; }
    else { clearInterval(iv); res.end(); }
  }, 10);
}

function respondResponsesJSON(res) {
  const payload = {
    id: 'resp-v-json', object: 'response', status: 'completed', model: 'gpt-4o',
    created_at: 1700000000, completed_at: 1700000005,
    parallel_tool_calls: true, temperature: 1, top_p: 1, tools: [],
    instructions: null, max_output_tokens: null, metadata: null, store: false, background: false,
    output_text: 'Hello! World.',
    output: [{ id: 'msg_e2e', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Hello! World.', annotations: [] }] }],
    usage: {
      input_tokens: 10, output_tokens: 5, total_tokens: 15,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
    error: null, incomplete_details: null,
  };
  const data = JSON.stringify(payload);
  res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) });
  res.end(data);
}

await new Promise(r => upstream.listen(UPSTREAM_PORT, '127.0.0.1', r));

// ==================== 配置 ====================

writeFileSync(join(CONFIG_DIR, 'config.json'), JSON.stringify({
  host: '127.0.0.1',
  proxyPort: PROXY_PORT,
  webPort: WEB_PORT,
  providers: [{
    id: 'p-openai', name: 'openai',
    endpoints: {
      'anthropic-messages': null,
      'openai-chat': null,
      'openai-responses': UPSTREAM_BASE,
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
    // 显式读流(res.text() 可能提前 resolve, 丢 SSE 后续帧)
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let bodyText = '';
    const start = Date.now();
    while (Date.now() - start < 10000) {  // 10s timeout 防止挂起
      const { value, done } = await reader.read();
      if (done) break;
      bodyText += decoder.decode(value, { stream: true });
    }
    return { status: res.status, body: bodyText };
  } catch (e) { return { status: 0, body: String(e) }; }
}

const OAI_HEADERS = { authorization: 'Bearer sk-x' };
// 关键: openai-responses 用 input(string), 不是 messages
const REQ_BODY = { model: 'gpt-4o', input: 'What is latin for Ant?' };

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

  console.log(`\n========== OpenAI Responses 协议全链路验收 ==========\n`);
  console.log(`  上游: http://127.0.0.1:${UPSTREAM_PORT}/v1  proxy=${PROXY_PORT} web=${WEB_PORT} vite=${VITE_PORT}\n`);

  const PROXY = `http://127.0.0.1:${PROXY_PORT}`;
  const WEB = `http://127.0.0.1:${WEB_PORT}`;

  // ============================================================
  console.log('【模式 1: 流式 SSE】');
  upstreamMode = 'sse';
  upstreamHits.length = 0;

  const sseRes = await post(`${PROXY}/custom/openai/v1/responses`, OAI_HEADERS, REQ_BODY);
  // 验证完整事件链 8 事件 (按 docs/protocols/03-openai-responses.md)
  // response.created → output_item.added → content_part.added →
  // output_text.delta × 多 → output_text.done →
  // content_part.done → output_item.done → response.completed
  const eventTypesExpected = [
    'response.created',
    'response.output_item.added',
    'response.content_part.added',
    'response.output_text.delta',
    'response.output_text.done',
    'response.content_part.done',
    'response.output_item.done',
    'response.completed',
  ];
  const allEventsOk = eventTypesExpected.every(t => sseRes.body.includes(t));
  const eventCount = (sseRes.body.match(/^event: /gm) || []).length;
  check(`SSE-①② 客户端收到完整 8 事件链(共 ${eventCount} 帧)`,
    allEventsOk && eventCount >= 8,
    `状态=${sseRes.status}, 事件数=${eventCount}, 完整链=${allEventsOk ? '✓' : '✗'}`);

  // 验证共用字段: type/sequence_number/output_index/item_id
  const hasSeq = /"sequence_number":\d/.test(sseRes.body);
  const hasOutIdx = /"output_index":\d/.test(sseRes.body);
  const hasItemId = /"item_id":"msg_/.test(sseRes.body);
  check(`SSE-② 事件共用字段存在(sequence_number + output_index + item_id)`,
    hasSeq && hasOutIdx && hasItemId,
    `seq=${hasSeq} outIdx=${hasOutIdx} itemId=${hasItemId}`);

  // 等日志落盘: 流式响应经 extractInBackground 处理需要时间
  await new Promise(r => setTimeout(r, 2000));
  const sseEntries = readLogEntries().filter(e => e.providerName === 'openai' && e.endpointType === 'openai-responses');
  const sseLog = sseEntries[sseEntries.length - 1];
  if (!sseLog) { console.log('  [WARN] sseLog 未找到, entries count:', sseEntries.length); }

  // 关键: openai-responses body 用 input, 不是 messages
  check('SSE-③ 日志 body.input 保留(string) + response 是 sse_raw',
    sseLog?.body?.input === 'What is latin for Ant?' && (sseLog?.response?.body?.type === 'sse_raw' || Array.isArray(sseLog?.response?.body?.lines)),
    `input=${sseLog?.body?.input} resp.type=${sseLog?.response?.body?.type}`);

  const apiRes1 = await fetch(`${WEB}/api/logs?limit=50`);
  const apiJson1 = await apiRes1.json();
  const apiSseEntry = (apiJson1.logs || apiJson1).find(l => l.id === sseLog?.id);
  check('SSE-④ /api/logs 返回 entry.request.body.input 保留',
    apiSseEntry?.request?.body?.input === 'What is latin for Ant?', `input=${apiSseEntry?.request?.body?.input}`);

  {
    if (!sseLog) {
      // 落盘失败时无法做 UI 验证
      check('SSE-⑤a Request tab 渲染(跳过: 无 log)', false, 'sseLog 为 undefined');
    } else {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${VITE_PORT}/?log=${sseLog.id}&tab=request`);
    await page.getByTestId('tab-request').click().catch(() => {});
    await page.waitForTimeout(300);
    const reqVisible = await page.getByTestId('request-body').isVisible().catch(() => false);
    const reqText = reqVisible ? (await page.getByTestId('request-body').textContent()) : '';
    check('SSE-⑤a Request tab 渲染 request-body 含 "input"',
      reqVisible && reqText.includes('input'), `visible=${reqVisible}`);

    // Context tab: input string → 1 个 user context-item(extractOpenAIResponses 转换)
    await page.getByTestId('tab-context').click().catch(() => {});
    await page.waitForTimeout(300);
    const itemCount = await page.getByTestId('context-item').count();
    const userCount = await page.locator('[data-testid="context-item"][data-role="user"]').count();
    check('SSE-⑤b Context tab 渲染 context-item(input 转换为 user)',
      itemCount >= 1 && userCount >= 1, `items=${itemCount} user=${userCount}`);

    await page.goto(`http://127.0.0.1:${VITE_PORT}/`);
    await page.waitForTimeout(500);
    const rowCount = await page.getByTestId('log-row').count();
    check('SSE-⑤c 日志列表渲染 log-row', rowCount >= 1, `rows=${rowCount}`);
    await browser.close();
    }
  }

  // ============================================================
  console.log('\n【模式 2: 非流式 JSON】');
  upstreamMode = 'json';
  upstreamHits.length = 0;

  const jsonRes = await post(`${PROXY}/custom/openai/v1/responses`, OAI_HEADERS, REQ_BODY);
  check('JSON-①② 客户端收到完整 Responses JSON(含 output + output_text)',
    jsonRes.status === 200 && jsonRes.body.includes('"output"') && jsonRes.body.includes('Hello! World.'),
    `status=${jsonRes.status} body 前 80: ${jsonRes.body.slice(0, 80)}`);

  await new Promise(r => setTimeout(r, 2000));
  const jsonEntries = readLogEntries().filter(e => e.providerName === 'openai' && e.endpointType === 'openai-responses');
  const jsonLog = jsonEntries[jsonEntries.length - 1];
  if (!jsonLog) { console.log('  [WARN] jsonLog 未找到'); }
  const jsonLogBody = jsonLog?.response?.body;
  check('JSON-③ 日志 response.body.output[0].content[0].text 完整',
    jsonLogBody?.output?.[0]?.content?.[0]?.text === 'Hello! World.' && jsonLogBody?.object === 'response',
    `text=${jsonLogBody?.output?.[0]?.content?.[0]?.text}`);

  const apiRes2 = await fetch(`${WEB}/api/logs?limit=50`);
  const apiJson2 = await apiRes2.json();
  const apiJsonEntry = (apiJson2.logs || apiJson2).find(l => l.id === jsonLog?.id);
  check('JSON-④ /api/logs 返回 response.body.output[0].content[0].text',
    apiJsonEntry?.response?.body?.output?.[0]?.content?.[0]?.text === 'Hello! World.',
    `text=${apiJsonEntry?.response?.body?.output?.[0]?.content?.[0]?.text}`);

  {
    if (!jsonLog) {
      check('JSON-⑤ Response tab 渲染(跳过: 无 log)', false, 'jsonLog 为 undefined');
    } else {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${VITE_PORT}/?log=${jsonLog.id}&tab=response`);
    await page.waitForTimeout(500);
    const respVisible = await page.getByTestId('response-body').isVisible().catch(() => false);
    const respText = respVisible ? (await page.getByTestId('response-body').textContent()) : '';
    check('JSON-⑤ Response tab 渲染 response-body 含 "output"',
      respVisible && respText.includes('output'), `visible=${respVisible}`);

    // 新增断言: JSON 模式 usage 详细字段 (按 docs § 2 ResponseUsage)
    // 含 input_tokens_details.cached_tokens + output_tokens_details.reasoning_tokens
    const hasCachedTokens = jsonLog?.response?.body?.usage?.input_tokens_details?.cached_tokens !== undefined;
    const hasReasoningTokens = jsonLog?.response?.body?.usage?.output_tokens_details?.reasoning_tokens !== undefined;
    check('JSON-⑤ usage 详细字段存在(cached_tokens + reasoning_tokens)',
      hasCachedTokens && hasReasoningTokens,
      `cached=${hasCachedTokens} reasoning=${hasReasoningTokens}`);
    await browser.close();
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
console.log(`  ${pass}/${results.length} 通过, ${fail} 失败`);
console.log('='.repeat(56));
if (fail > 0) {
  console.log('\n失败项:');
  results.filter(r => !r.ok).forEach(r => console.log(`  - ${r.name}${r.detail ? ' (' + r.detail + ')' : ''}`));
}
process.exit(fail === 0 ? 0 : 1);
