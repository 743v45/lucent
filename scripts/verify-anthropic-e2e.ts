#!/usr/bin/env tsx
/**
 * scripts/verify-anthropic-e2e.ts — Anthropic Messages 协议全链路端到端验收
 *
 * 对应 openspec/specs/protocol-chain-verification/spec.md
 *
 * 用法: npm run verify:anthropic
 *
 * 覆盖 5 个环节 × 2 种响应模式（流式 SSE + 非流式 JSON）+ schema 校验:
 *   ① 请求构造（下游 → proxy）  ② 真实响应  ③ 日志记录  ④ /api/logs 接口  ⑤ Web UI 渲染
 *   ⑥ schema 校验（验格式完整，非关键字存在）
 *
 * 隔离: 临时 config + 随机端口，不碰 ~/.lucent
 * fixture 复用: tests/e2e-helpers.ts 的 createMockUpstream（单一真相源）
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createMockUpstream, validateAnthropicBody } from '../tests/e2e-helpers.js';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// ==================== 隔离环境 ====================

const CONFIG_DIR = mkdtempSync(join(tmpdir(), 'lucent-anth-verify-'));
const BASE = 46000 + Math.floor(Math.random() * 3000);
const PROXY_PORT = BASE;
const WEB_PORT = BASE + 1;
const VITE_PORT = BASE + 2;

// ==================== mock 上游（复用 helpers.ts fixture）====================

const upstream = await createMockUpstream({ name: 'anth-verify', format: 'anthropic' });
const UPSTREAM_BASE = `http://127.0.0.1:${upstream.port}/v1`;

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
  // 标准 JSONL：一行一条 JSON
  return content.split('\n').filter(s => s.trim().startsWith('{')).map(s => JSON.parse(s));
}

// ==================== 等待服务就绪 ====================

async function waitFor(proc: any, regex: RegExp, label: string, timeoutMs = 30000) {
  return new Promise<void>((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(`${label} startup timeout`)), timeoutMs);
    let done = false;
    proc.stdout.on('data', (d: Buffer) => {
      if (!done && regex.test(d.toString())) {
        done = true; clearTimeout(to); resolve();
      }
    });
    proc.on('exit', (c: number) => { if (!done) reject(new Error(`${label} exit ${c}`)); });
  });
}

async function waitForPort(url: string, label: string, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.status > 0) return;
    } catch {
      // Port not ready yet, retry
    }
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
  console.log(`  上游 mock: ${UPSTREAM_BASE}`);
  console.log(`  后端:     proxy=${PROXY_PORT} web=${WEB_PORT}`);
  console.log(`  vite:     ${VITE_PORT}（playwright 访问这里）`);
  console.log('');

  const PROXY = `http://127.0.0.1:${PROXY_PORT}`;
  const WEB = `http://127.0.0.1:${WEB_PORT}`;

  // ============================================================
  // 模式 1: 流式 SSE
  // ============================================================
  console.log('【模式 1: 流式 SSE】');
  upstream.reset();
  upstream.setMode('sse-text');

  // ① 请求构造 + ② 真实响应（SSE）
  const sseRes = await post(`${PROXY}/custom/hxy/v1/messages`, ANTH_HEADERS, REQ_BODY);
  // 验证完整事件链 (按 docs/protocols/01-anthropic-messages.md § 3)
  // helpers anthropicTextSSEEvents: message_start/content_block_start/2×delta/stop/message_delta/message_stop = 7 帧
  const anthEventTypes = [
    'message_start', 'content_block_start', 'content_block_delta',
    'content_block_stop', 'message_delta', 'message_stop',
  ];
  const anthAllEventsOk = anthEventTypes.every(t => sseRes.body.includes('event: ' + t));
  const anthFrameCount = (sseRes.body.match(/^event: /gm) || []).length;
  check(`SSE-①② 客户端收到完整事件链(共 ${anthFrameCount} 帧)`,
    anthAllEventsOk && anthFrameCount >= 7 && sseRes.body.includes('Hello! ') && sseRes.body.includes('How can I help?'),
    `状态=${sseRes.status}, 事件数=${anthFrameCount}, 完整链=${anthAllEventsOk ? '✓' : '✗'}`);

  // ⑥ schema 校验（验格式完整，非关键字存在）
  const sseSchema = validateAnthropicBody(sseRes.body, 'sse');
  check('SSE-⑥ schema 校验(message_start.usage 9 字段 + signature_delta)',
    sseSchema.ok,
    sseSchema.errors.slice(0, 3).join('; '));

  await new Promise(r => setTimeout(r, 600));  // 等流式日志落盘
  const sseEntries = readLogEntries().filter((e: any) => e.providerName === 'hxy');
  const sseLog = sseEntries[sseEntries.length - 1];

  // ③ 日志记录
  check('SSE-③ 日志 body.messages 完整(2 条) + response 是 sse_raw',
    sseLog?.body?.messages?.length === 2 && (sseLog?.response?.body?.type === 'sse_raw' || Array.isArray(sseLog?.response?.body?.lines)),
    `messages.len=${sseLog?.body?.messages?.length} resp.body.type=${sseLog?.response?.body?.type}`);

  // ③b TTFT 时延（stream-timing）：0 < 首 token < duration，且 tokens/s > 0
  check('SSE-③b TTFT: 0<首token<duration 且 tokens/s>0',
    typeof sseLog?.ttftFirstTokenMs === 'number' && sseLog.ttftFirstTokenMs > 0
      && sseLog.ttftFirstTokenMs < sseLog.duration
      && typeof sseLog?.tokensPerSecond === 'number' && sseLog.tokensPerSecond > 0,
    `ttftFirst=${sseLog?.ttftFirstTokenMs} thinking=${sseLog?.ttftThinkingMs} answer=${sseLog?.ttftAnswerMs} tps=${sseLog?.tokensPerSecond} dur=${sseLog?.duration}`);

  // ④ /api/logs 接口
  const apiRes1 = await fetch(`${WEB}/api/logs?limit=50`);
  const apiJson1 = await apiRes1.json();
  const apiSseEntry = (apiJson1.logs || apiJson1).find((l: any) => l.id === sseLog?.id);
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
    // 等列表渲染完成再计数，避免 goto 后日志未拉取完的竞态导致 rows=0 抖动
    await page.getByTestId('log-row').first().waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
    const rowCount = await page.getByTestId('log-row').count();
    check('SSE-⑤c 日志列表渲染 log-row',
      rowCount >= 1, `rows=${rowCount}`);

    await browser.close();
  }

  // ============================================================
  // 模式 2: 非流式 JSON
  // ============================================================
  console.log('\n【模式 2: 非流式 JSON】');
  upstream.reset();
  upstream.setMode('json');

  const jsonRes = await post(`${PROXY}/custom/hxy/v1/messages`, ANTH_HEADERS, REQ_BODY);
  check('JSON-①② 客户端收到完整 JSON 响应(含 content + text)',
    jsonRes.status === 200 && jsonRes.body.includes('"content"') && jsonRes.body.includes('Hello from JSON response.'),
    `status=${jsonRes.status} body 前 80: ${jsonRes.body.slice(0, 80)}`);

  // ⑥ schema 校验
  const jsonSchema = validateAnthropicBody(JSON.parse(jsonRes.body), 'json');
  check('JSON-⑥ schema 校验(type/role/content/usage 9 字段)',
    jsonSchema.ok,
    jsonSchema.errors.slice(0, 3).join('; '));

  await new Promise(r => setTimeout(r, 400));
  const jsonEntries = readLogEntries().filter((e: any) => e.providerName === 'hxy');
  const jsonLog = jsonEntries[jsonEntries.length - 1];

  // ③ 日志记录
  const jsonLogBody = jsonLog?.response?.body;
  check('JSON-③ 日志 response.body 是完整 JSON(含 content text)',
    jsonLogBody?.content?.[0]?.text === 'Hello from JSON response.' && jsonLogBody?.type === 'message',
    `content.text=${jsonLogBody?.content?.[0]?.text}`);

  // ④ /api/logs
  const apiRes2 = await fetch(`${WEB}/api/logs?limit=50`);
  const apiJson2 = await apiRes2.json();
  const apiJsonEntry = (apiJson2.logs || apiJson2).find((l: any) => l.id === jsonLog?.id);
  check('JSON-④ /api/logs 返回 entry.request.body.messages.length===2 + response.body.content',
    apiJsonEntry?.request?.body?.messages?.length === 2 && apiJsonEntry?.response?.body?.content?.[0]?.text === 'Hello from JSON response.',
    `msgs=${apiJsonEntry?.request?.body?.messages?.length}`);

  // ⑤ Web UI 渲染
  {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${VITE_PORT}/?log=${jsonLog.id}&tab=response`);
    // 等 Response tab 渲染完，避免 visible=false 抖动
    await page.getByTestId('response-body').waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});

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
  await upstream.close();
  await new Promise(r => setTimeout(r, 500));
  try { rmSync(CONFIG_DIR, { recursive: true, force: true }); } catch {
    // Config dir may already be cleaned up
  }
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
