#!/usr/bin/env tsx
/**
 * scripts/verify-openai-responses-e2e.ts — OpenAI Responses 协议全链路端到端验收
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
import { createMockUpstream, validateOpenAIResponsesBody } from '../tests/e2e-helpers.js';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// ==================== 隔离环境 ====================

const CONFIG_DIR = mkdtempSync(join(tmpdir(), 'lucent-oai-resp-verify-'));
const BASE = 52000 + Math.floor(Math.random() * 3000);
const PROXY_PORT = BASE;
const WEB_PORT = BASE + 1;
const VITE_PORT = BASE + 2;

// ==================== mock 上游（复用 helpers.ts fixture）====================

const upstream = await createMockUpstream({ name: 'oai-resp-verify', format: 'openai' });
const UPSTREAM_BASE = `http://127.0.0.1:${upstream.port}/v1`;

// ==================== 配置（自定义供应商 openai + openai-responses 端点）====================

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

async function post(url: string, headers: Record<string, string>, body: any): Promise<{ status: number; body: string }> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    // 显式读流(res.text() 可能提前 resolve, 丢 SSE 后续帧)
    const reader = (res.body as any).getReader();
    const decoder = new TextDecoder();
    let bodyText = '';
    const start = Date.now();
    while (Date.now() - start < 10000) {  // 10s timeout 防止挂起
      const { value, done } = await reader.read();
      if (done) break;
      bodyText += decoder.decode(value, { stream: true });
    }
    return { status: res.status, body: bodyText };
  } catch (e: any) {
    return { status: 0, body: String(e) };
  }
}

const OAI_HEADERS = { authorization: 'Bearer sk-x' };
// 关键: openai-responses 用 input(string), 不是 messages
const REQ_BODY = { model: 'gpt-4o', input: 'What is latin for Ant?' };

// 读最新日志的所有 entry
function readLogEntries(): any[] {
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

  console.log(`\n========== OpenAI Responses 协议全链路验收 ==========\n`);
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
  upstream.setMode('responses-sse');

  // ① 请求构造 + ② 真实响应（SSE）
  const sseRes = await post(`${PROXY}/custom/openai/v1/responses`, OAI_HEADERS, REQ_BODY);
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
  // output_text 分两帧 delta: 'Hello!' + ' World.'，断言两帧各自存在，不期望连写
  check(`SSE-①② 客户端收到完整 8 事件链(共 ${eventCount} 帧) + output_text 分帧`,
    allEventsOk && eventCount >= 8 && sseRes.body.includes('Hello!') && sseRes.body.includes('World.'),
    `状态=${sseRes.status}, 事件数=${eventCount}, 完整链=${allEventsOk ? '✓' : '✗'}`);

  // 验证共用字段: sequence_number/output_index/item_id
  const hasSeq = /"sequence_number":\d/.test(sseRes.body);
  const hasOutIdx = /"output_index":\d/.test(sseRes.body);
  const hasItemId = /"item_id":"msg_/.test(sseRes.body);
  check(`SSE-② 事件共用字段存在(sequence_number + output_index + item_id)`,
    hasSeq && hasOutIdx && hasItemId,
    `seq=${hasSeq} outIdx=${hasOutIdx} itemId=${hasItemId}`);

  // ⑥ schema 校验（验格式完整，非关键字存在）
  const sseSchema = validateOpenAIResponsesBody(sseRes.body, 'sse');
  check('SSE-⑥ schema 校验(完整事件链 + created/completed.response 完整 Response 字段)',
    sseSchema.ok,
    sseSchema.errors.slice(0, 3).join('; '));

  // 等日志落盘: 流式响应经 extractInBackground 处理需要时间
  await new Promise(r => setTimeout(r, 2000));
  const sseEntries = readLogEntries().filter((e: any) => e.providerName === 'openai' && e.endpointType === 'openai-responses');
  const sseLog = sseEntries[sseEntries.length - 1];

  // ③ 日志记录（关键: openai-responses body 用 input, 不是 messages）
  check('SSE-③ 日志 body.input 保留(string) + response 是 sse_raw',
    sseLog?.body?.input === 'What is latin for Ant?' && (sseLog?.response?.body?.type === 'sse_raw' || Array.isArray(sseLog?.response?.body?.lines)),
    `input=${sseLog?.body?.input} resp.type=${sseLog?.response?.body?.type}`);

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
  check('SSE-④ /api/logs 返回 entry.request.body.input 保留',
    apiSseEntry?.request?.body?.input === 'What is latin for Ant?',
    `input=${apiSseEntry?.request?.body?.input}`);

  // ⑤ Web UI 渲染（playwright）
  {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${VITE_PORT}/?log=${sseLog.id}&tab=request`);
    await page.getByTestId('tab-request').click().catch(() => {});
    await page.waitForTimeout(300);
    const reqVisible = await page.getByTestId('request-body').isVisible().catch(() => false);
    const reqText = reqVisible ? (await page.getByTestId('request-body').textContent()) : '';
    check('SSE-⑤a Request tab 渲染 request-body 含 "input"',
      reqVisible && reqText.includes('input'), `visible=${reqVisible}`);

    // Context tab: input string → 1 个 user context-item
    await page.getByTestId('tab-context').click().catch(() => {});
    await page.waitForTimeout(300);
    const itemCount = await page.getByTestId('context-item').count();
    const userCount = await page.locator('[data-testid="context-item"][data-role="user"]').count();
    check('SSE-⑤b Context tab 渲染 context-item(input 转换为 user)',
      itemCount >= 1 && userCount >= 1, `items=${itemCount} user=${userCount}`);

    await page.goto(`http://127.0.0.1:${VITE_PORT}/`);
    // 等列表渲染完成再计数，避免 goto 后日志未拉取完的竞态导致 rows=0 抖动
    await page.getByTestId('log-row').first().waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
    const rowCount = await page.getByTestId('log-row').count();
    check('SSE-⑤c 日志列表渲染 log-row', rowCount >= 1, `rows=${rowCount}`);
    await browser.close();
  }

  // ============================================================
  // 模式 2: 非流式 JSON
  // ============================================================
  console.log('\n【模式 2: 非流式 JSON】');
  upstream.reset();
  upstream.setMode('responses-json');

  const jsonRes = await post(`${PROXY}/custom/openai/v1/responses`, OAI_HEADERS, REQ_BODY);
  check('JSON-①② 客户端收到完整 Responses JSON(含 output + output_text)',
    jsonRes.status === 200 && jsonRes.body.includes('"output"') && jsonRes.body.includes('Hello from JSON.'),
    `status=${jsonRes.status} body 前 80: ${jsonRes.body.slice(0, 80)}`);

  // ⑥ schema 校验
  const jsonSchema = validateOpenAIResponsesBody(JSON.parse(jsonRes.body), 'json');
  check('JSON-⑥ schema 校验(object=response + 完整 Response 字段集)',
    jsonSchema.ok,
    jsonSchema.errors.slice(0, 3).join('; '));

  await new Promise(r => setTimeout(r, 2000));
  const jsonEntries = readLogEntries().filter((e: any) => e.providerName === 'openai' && e.endpointType === 'openai-responses');
  const jsonLog = jsonEntries[jsonEntries.length - 1];

  // ③ 日志记录
  const jsonLogBody = jsonLog?.response?.body;
  check('JSON-③ 日志 response.body.output[0].content[0].text 完整',
    jsonLogBody?.output?.[0]?.content?.[0]?.text === 'Hello from JSON.' && jsonLogBody?.object === 'response',
    `text=${jsonLogBody?.output?.[0]?.content?.[0]?.text}`);

  // ④ /api/logs
  const apiRes2 = await fetch(`${WEB}/api/logs?limit=50`);
  const apiJson2 = await apiRes2.json();
  const apiJsonEntry = (apiJson2.logs || apiJson2).find((l: any) => l.id === jsonLog?.id);
  check('JSON-④ /api/logs 返回 response.body.output[0].content[0].text',
    apiJsonEntry?.response?.body?.output?.[0]?.content?.[0]?.text === 'Hello from JSON.',
    `text=${apiJsonEntry?.response?.body?.output?.[0]?.content?.[0]?.text}`);

  // ⑤ Web UI 渲染
  {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${VITE_PORT}/?log=${jsonLog.id}&tab=response`);
    // 等 Response tab 渲染完，避免 visible=false 抖动
    await page.getByTestId('response-body').waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
    const respVisible = await page.getByTestId('response-body').isVisible().catch(() => false);
    const respText = respVisible ? (await page.getByTestId('response-body').textContent()) : '';
    check('JSON-⑤ Response tab 渲染 response-body 含 "output"',
      respVisible && respText.includes('output'), `visible=${respVisible}`);

    // JSON 模式 usage 详细字段 (按 docs § 2 ResponseUsage)
    const hasCachedTokens = jsonLogBody?.usage?.input_tokens_details?.cached_tokens !== undefined;
    const hasReasoningTokens = jsonLogBody?.usage?.output_tokens_details?.reasoning_tokens !== undefined;
    check('JSON-⑤ usage 详细字段存在(cached_tokens + reasoning_tokens)',
      hasCachedTokens && hasReasoningTokens,
      `cached=${hasCachedTokens} reasoning=${hasReasoningTokens}`);
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
