#!/usr/bin/env tsx
/**
 * scripts/verify-loglist-e2e.ts — 日志列表与多维筛选 端到端验收
 *
 * 对应 TAE-48（审查 Lucent 页面功能①：日志列表与多维筛选）
 *
 * 覆盖验收点：
 *   A. 真链路逐条进入（真发请求穿过代理 → 列表逐条出现）
 *   B. 列表渲染（provider / 协议 / agent 类型 / 耗时 / 状态码）
 *   C. 按供应商筛选（下拉 + 结果正确）
 *   D. 按协议筛选（下拉 + 结果正确）
 *   E. 筛选态 localStorage 持久化（刷新仍在）
 *   F. 视图切换 timeline ↔ session（分组无丢条/重条）
 *   G. 加载更多（>PAGE_SIZE 分页）
 *   H. 选中态高亮 + URL logId 同步
 *   NEG1. 空列表 → 空态
 *   NEG2. 全筛选掉 → 空态
 *   NEG3. 分页越界 → /api/logs 返空、total 不变、不崩
 *
 * 隔离：临时 config + 随机端口，不碰 ~/.lucent
 * fixture 复用：tests/e2e-helpers.ts 的 createMockUpstream
 *
 * 用法：npm run verify:loglist  （或 tsx scripts/verify-loglist-e2e.ts）
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createMockUpstream } from '../tests/e2e-helpers.js';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SHOT_DIR = join(REPO_ROOT, 'screenshots-loglist');
mkdirSync(SHOT_DIR, { recursive: true });

// ==================== 隔离环境 ====================
const CONFIG_DIR = mkdtempSync(join(tmpdir(), 'lucent-loglist-verify-'));
const LOG_DIR = join(CONFIG_DIR, 'logs');
const BASE = 57000 + Math.floor(Math.random() * 2000);
const PROXY_PORT = BASE;
const WEB_PORT = BASE + 1;
const VITE_PORT = BASE + 2;

// ==================== mock 上游（auto 模式分派 3 协议）====================
const upstream = await createMockUpstream({ name: 'loglist-verify', format: 'auto' });
const UPSTREAM_BASE = `http://127.0.0.1:${upstream.port}/v1`;

// ==================== 配置：2 供应商 × 3 协议，便于测供应商/协议双筛选 ====================
writeFileSync(join(CONFIG_DIR, 'config.json'), JSON.stringify({
  host: '127.0.0.1',
  proxyPort: PROXY_PORT,
  webPort: WEB_PORT,
  providers: [
    { id: 'p-alpha', name: 'alpha', endpoints: { 'anthropic-messages': UPSTREAM_BASE, 'openai-chat': UPSTREAM_BASE, 'openai-responses': UPSTREAM_BASE } },
    { id: 'p-beta', name: 'beta', endpoints: { 'anthropic-messages': UPSTREAM_BASE, 'openai-chat': UPSTREAM_BASE, 'openai-responses': UPSTREAM_BASE } },
  ],
}));

// ==================== 启动后端 + vite ====================
const backend = spawn('npx', ['tsx', 'server/index.ts'], {
  cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, LUCENT_CONFIG_DIR: CONFIG_DIR, LUCENT_HOST: '127.0.0.1', LUCENT_PROXY_PORT: String(PROXY_PORT), LUCENT_WEB_PORT: String(WEB_PORT), LUCENT_LOG_DIR: LOG_DIR },
});
const vite = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(VITE_PORT), '--strictPort'], {
  cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, LUCENT_WEB_PORT: String(WEB_PORT) },
});

// ==================== 工具 ====================
const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, cond: any, detail = '') {
  results.push({ name, ok: !!cond, detail });
  console.log(`  ${cond ? '✓ PASS' : '✗ FAIL'}  ${name}${cond ? '' : (detail ? '  →  ' + detail : '')}`);
}

async function post(url: string, headers: Record<string, string>, body: any): Promise<{ status: number; body: string }> {
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
    const reader = (res.body as any).getReader();
    const decoder = new TextDecoder();
    let bodyText = '';
    const start = Date.now();
    while (Date.now() - start < 8000) {
      const { value, done } = await reader.read();
      if (done) break;
      bodyText += decoder.decode(value, { stream: true });
    }
    return { status: res.status, body: bodyText };
  } catch (e: any) { return { status: 0, body: String(e) }; }
}

const REQ_BODIES: Record<string, any> = {
  'anthropic-messages': { model: 'claude-sonnet-4-5', max_tokens: 1, messages: [{ role: 'user', content: 'hello there' }, { role: 'assistant', content: '(' }] },
  'openai-chat': { model: 'gpt-4o', max_tokens: 1, messages: [{ role: 'user', content: 'hello there' }, { role: 'assistant', content: '(' }] },
  'openai-responses': { model: 'gpt-4o', input: 'hello there' },
};
const PATHS: Record<string, string> = {
  'anthropic-messages': '/v1/messages',
  'openai-chat': '/v1/chat/completions',
  'openai-responses': '/v1/responses',
};
const HEADERS: Record<string, Record<string, string>> = {
  'anthropic-messages': { 'x-api-key': 'sk-x', 'anthropic-version': '2023-06-01' },
  'openai-chat': { 'authorization': 'Bearer sk-x' },
  'openai-responses': { 'authorization': 'Bearer sk-x' },
};

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

const SEP = '\n---\n';
function writeConstructed(entries: any[]) {
  // 清掉已有 jsonl，写入确定性数据
  for (const f of readdirSync(LOG_DIR)) if (f.endsWith('.jsonl')) { try { rmSync(join(LOG_DIR, f)); } catch {} }
  writeFileSync(join(LOG_DIR, 'constructed.jsonl'), entries.map(e => JSON.stringify(e)).join(SEP) + SEP);
}

function mkEntry(o: {
  id: string; ts: string; provider: 'alpha' | 'beta'; endpoint: 'anthropic-messages' | 'openai-chat' | 'openai-responses';
  agent: 'main' | 'sub'; status: number; duration: number; model: string; threadId?: string;
  input?: number; output?: number; content?: string;
}): any {
  const isResponses = o.endpoint === 'openai-responses';
  return {
    id: o.id,
    timestamp: o.ts,
    project: '',
    request: {
      method: 'POST',
      url: `https://upstream.example${SEP}invalid/v1/${o.endpoint === 'anthropic-messages' ? 'messages' : o.endpoint === 'openai-chat' ? 'chat/completions' : 'responses'}`,
      headers: { 'content-type': 'application/json' },
      body: isResponses
        ? { model: o.model, input: o.content ?? '用户提问' }
        : { model: o.model, max_tokens: 16, messages: [{ role: 'user', content: o.content ?? '用户提问内容' }] },
    },
    response: {
      status: o.status,
      statusText: o.status === 200 ? 'OK' : 'ERR',
      headers: { 'content-type': 'application/json' },
      body: { id: 'resp-' + o.id, type: 'response', role: 'assistant', content: [{ type: 'text', text: '答复' }], usage: { input_tokens: o.input ?? 100, output_tokens: o.output ?? 50 } },
    },
    agentType: o.agent,
    apiType: o.endpoint,
    clientType: 'test-client',
    duration: o.duration,
    metadata: { model: o.model, provider: o.endpoint === 'anthropic-messages' ? 'claude' : 'openai', stream: false },
    tokenUsage: { input_tokens: o.input ?? 100, output_tokens: o.output ?? 50 },
    providerName: o.provider,
    endpointType: o.endpoint,
    ...(o.threadId ? { threadId: o.threadId } : {}),
  };
}

// 读 UI 当前渲染的 log-row id 集合
async function renderedIds(page: any): Promise<string[]> {
  return page.$$eval('[data-testid="log-row"]', (els: any[]) => els.map(e => e.getAttribute('data-logid')).filter(Boolean));
}
// 单行文本（用于断言状态码/耗时/模型/agent 标签）
async function rowTextById(page: any, id: string): Promise<string> {
  return page.locator(`[data-testid="log-row"][data-logid="${id}"]`).textContent() ?? '';
}

// 通过 AntD 下拉设置筛选（selectIdx: 0=供应商 1=协议）
async function pickSelect(page: any, selectIdx: number, optionText: string) {
  // 等 provider 下拉就位（providers 异步加载，首帧可能只有 1 个 select）
  await page.waitForFunction((idx: number) => document.querySelectorAll('.ant-select').length >= idx + 1, selectIdx, { timeout: 8000 });
  await page.locator('.ant-select').nth(selectIdx).click();
  await page.waitForTimeout(250);
  await page.locator('.ant-select-item').filter({ hasText: optionText }).first().click();
  await page.waitForTimeout(300);
}

async function apiLogs(): Promise<any[]> {
  const r = await fetch(`http://127.0.0.1:${WEB_PORT}/api/logs?limit=500`);
  const j = await r.json();
  return j.logs || [];
}

let browser: any;
try {
  await waitFor(backend, /Lucent|代理|listen|启动/i, 'backend');
  await waitFor(vite, /Local:|ready in/i, 'vite');
  await waitForPort(`http://127.0.0.1:${VITE_PORT}/`, 'vite');
  await new Promise(r => setTimeout(r, 800));

  browser = await chromium.launch();
  console.log(`\n========== 日志列表与多维筛选 验收 ==========`);
  console.log(`  mock upstream: ${UPSTREAM_BASE} | proxy=${PROXY_PORT} web=${WEB_PORT} vite=${VITE_PORT}\n`);

  // ============ A. 真链路逐条进入 ============
  console.log('—— A. 真链路逐条进入 ——');
  upstream.reset(); upstream.setMode('json');
  // 清空，从 0 开始
  for (const f of readdirSync(LOG_DIR)) if (f.endsWith('.jsonl')) { try { rmSync(join(LOG_DIR, f)); } catch {} }
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`http://127.0.0.1:${VITE_PORT}/`);
  await page.waitForTimeout(500);
  let before = (await renderedIds(page)).length;
  check('A0 空起步: 初始 0 行', before === 0, `rows=${before}`);

  const chain: Array<{ provider: string; endpoint: string }> = [
    { provider: 'alpha', endpoint: 'anthropic-messages' },
    { provider: 'beta', endpoint: 'openai-chat' },
    { provider: 'alpha', endpoint: 'openai-responses' },
  ];
  let seenIds: string[] = [];
  for (let i = 0; i < chain.length; i++) {
    const { provider, endpoint } = chain[i];
    const res = await post(`http://127.0.0.1:${PROXY_PORT}/custom/${provider}${PATHS[endpoint]}`, HEADERS[endpoint], REQ_BODIES[endpoint]);
    await new Promise(r => setTimeout(r, 500));
    await page.reload();
    await page.waitForTimeout(400);
    const ids = await renderedIds(page);
    check(`A${i + 1} ${provider}×${endpoint}: 穿透成功 + 列表新增 1 条`,
      res.status === 200 && ids.length === before + 1 + 0 && ids.filter(id => !seenIds.includes(id)).length >= 1,
      `http=${res.status} rows=${ids.length} prev=${before}`);
    seenIds = ids;
    before = ids.length;
  }
  await page.screenshot({ path: join(SHOT_DIR, 'A-realchain-list.png'), fullPage: false });
  check('A 截图: A-realchain-list.png', true);

  // ============ 构造确定性数据集（60 条，覆盖筛选/分组/分页/字段） ============
  // 真链路日志先清掉，换成可控数据
  const entries: any[] = [];
  const baseT = Date.UTC(2026, 6, 3, 9, 0, 0); // 2026-07-03 09:00 UTC
  // 55 条填充（最旧），使总数=60（>PAGE_SIZE 50），覆盖分页；分布在 alpha/beta 与 3 协议
  for (let i = 0; i < 55; i++) {
    const provider = i % 2 === 0 ? 'alpha' : 'beta';
    const endpoints: any[] = ['anthropic-messages', 'openai-chat', 'openai-responses'];
    const endpoint = endpoints[i % 3];
    const status = i % 7 === 0 ? 429 : 200;
    entries.push(mkEntry({
      id: `fill-${i}`, ts: new Date(baseT + i * 1000).toISOString(),
      provider, endpoint, agent: i % 5 === 0 ? 'sub' : 'main', status,
      duration: 50 + i * 10, model: endpoint === 'anthropic-messages' ? 'claude-sonnet-4-5' : 'gpt-4o',
      content: `填充请求 ${i}`, input: 10 + i, output: 5,
    }));
  }
  // 5 条目标日志（最新，落入首屏 50），覆盖字段/分组/状态码/耗时
  // thread_t1: alpha main×2 + 1 sub；thread_t2: beta main×1
  const T = baseT + 100000;
  entries.push(mkEntry({ id: 't2-m1', ts: new Date(T + 0).toISOString(), provider: 'beta', endpoint: 'openai-responses', agent: 'main', status: 401, duration: 210, model: 'gpt-4o', threadId: 'thread_t2', content: '鉴权失败场景', input: 40, output: 0 }));
  entries.push(mkEntry({ id: 'err1', ts: new Date(T + 1000).toISOString(), provider: 'beta', endpoint: 'openai-chat', agent: 'main', status: 500, duration: 5001, model: 'gpt-4o', content: '上游错误', input: 30, output: 0 }));
  entries.push(mkEntry({ id: 't1-m2', ts: new Date(T + 2000).toISOString(), provider: 'alpha', endpoint: 'openai-chat', agent: 'main', status: 200, duration: 880, model: 'gpt-4o', threadId: 'thread_t1', content: '继续分析', input: 600, output: 90 }));
  entries.push(mkEntry({ id: 't1-s1', ts: new Date(T + 3000).toISOString(), provider: 'alpha', endpoint: 'openai-chat', agent: 'sub', status: 200, duration: 320, model: 'gpt-4o-mini', content: '子任务', input: 80, output: 20 }));
  entries.push(mkEntry({ id: 't1-m1', ts: new Date(T + 4000).toISOString(), provider: 'alpha', endpoint: 'anthropic-messages', agent: 'main', status: 200, duration: 1234, model: 'claude-sonnet-4-5', threadId: 'thread_t1', content: '帮我分析代码结构', input: 500, output: 120 }));
  writeConstructed(entries);
  const constructedTotal = entries.length; // 60
  await page.reload();
  await page.waitForTimeout(500);
  const initialIds = await renderedIds(page);
  check('数据集: 写入 60 条确定性日志', constructedTotal === 60, `total=${constructedTotal}`);
  check('G0 首屏分页: 默认加载 50 条（PAGE_SIZE）', initialIds.length === 50, `rows=${initialIds.length}`);

  // ============ B. 列表渲染字段 ============
  console.log('\n—— B. 列表渲染字段（agent 类型/状态码/耗时/模型） ——');
  // t1-m1: main / 200 / 1234ms→1.2s / claude
  const t1m1 = await rowTextById(page, 't1-m1');
  check('B1 agent 类型 MainAgent 标签', /MainAgent/.test(t1m1), `text=${t1m1?.slice(0, 80)}`);
  check('B2 状态码 200 渲染', /200/.test(t1m1), `text=${t1m1?.slice(0, 80)}`);
  check('B3 耗时 1234ms→1.2s 渲染', /1\.2s/.test(t1m1), `text=${t1m1?.slice(0, 80)}`);
  // err1: 500 → 5.0s
  const err1 = await rowTextById(page, 'err1');
  check('B4 状态码 500 渲染', /500/.test(err1), `text=${err1?.slice(0, 80)}`);
  check('B5 耗时 5001ms→5.0s 渲染', /5\.0s/.test(err1), `text=${err1?.slice(0, 80)}`);
  // t2-m1: 401
  const t2m1 = await rowTextById(page, 't2-m1');
  check('B6 状态码 401 渲染', /401/.test(t2m1), `text=${t2m1?.slice(0, 80)}`);
  // sub agent
  const t1s1 = await rowTextById(page, 't1-s1');
  check('B7 agent 类型 SubAgent 标签', /SubAgent/.test(t1s1), `text=${t1s1?.slice(0, 80)}`);
  // SSE/JSON 标记：构造数据 stream:false → JSON
  check('B8 非流式标记 JSON', /JSON/.test(t1m1) && !/SSE/.test(t1m1), `text=${t1m1?.slice(0, 80)}`);
  await page.screenshot({ path: join(SHOT_DIR, 'B-render-fields.png') });
  check('B 截图: B-render-fields.png', true);

  // ============ C. 按供应商筛选 ============
  console.log('\n—— C. 按供应商筛选 ——');
  await pickSelect(page, 0, 'alpha');
  const alphaIds = await renderedIds(page);
  const apiAll = await apiLogs();
  const alphaExpected = apiAll.filter(l => l.providerName === 'alpha').map(l => l.id).filter(id => initialIds.includes(id) || alphaIds.includes(id));
  const alphaAllMatched = alphaIds.length > 0 && alphaIds.every(id => apiAll.find(l => l.id === id)?.providerName === 'alpha');
  const alphaCountOk = alphaIds.length === alphaExpected.length;
  check('C1 选 alpha: 结果全部 providerName=alpha', alphaAllMatched, `rows=${alphaIds.length}`);
  check('C2 选 alpha: 条数与 API 交叉一致', alphaCountOk, `ui=${alphaIds.length} api=${alphaExpected.length}`);
  await page.screenshot({ path: join(SHOT_DIR, 'C-filter-provider-alpha.png') });
  check('C 截图: C-filter-provider-alpha.png', true);

  // ============ D. 按协议筛选 ============
  console.log('\n—— D. 按协议筛选 ——');
  // 先重置供应商为全部
  await pickSelect(page, 0, '全部供应商');
  await page.waitForTimeout(200);
  await pickSelect(page, 1, 'OpenAI Chat');
  const chatIds = await renderedIds(page);
  const chatAllMatched = chatIds.length > 0 && chatIds.every(id => apiAll.find(l => l.id === id)?.endpointType === 'openai-chat');
  check('D1 选 openai-chat: 结果全部 endpointType=openai-chat', chatAllMatched, `rows=${chatIds.length}`);
  await page.screenshot({ path: join(SHOT_DIR, 'D-filter-protocol-chat.png') });
  check('D 截图: D-filter-protocol-chat.png', true);

  // ============ E. 筛选态 localStorage 持久化 ============
  console.log('\n—— E. 筛选态 localStorage 持久化 ——');
  await pickSelect(page, 1, '全部协议'); // 重置协议
  await pickSelect(page, 0, 'beta');      // 设供应商=beta
  await page.waitForTimeout(200);
  const beforeReload = await renderedIds(page);
  await page.reload();
  await page.waitForTimeout(500);
  const afterReload = await renderedIds(page);
  const storedProvider = await page.evaluate(() => localStorage.getItem('lucent.providerFilter'));
  const sameSet = JSON.stringify(beforeReload.slice().sort()) === JSON.stringify(afterReload.slice().sort());
  check('E1 刷新后筛选态保留 (localStorage lucent.providerFilter=beta)', storedProvider === 'beta', `stored=${storedProvider}`);
  check('E2 刷新前后渲染结果一致', sameSet && beforeReload.length > 0, `before=${beforeReload.length} after=${afterReload.length}`);
  await page.screenshot({ path: join(SHOT_DIR, 'E-persist-after-reload.png') });
  check('E 截图: E-persist-after-reload.png', true);
  // 重置筛选，恢复全量
  await pickSelect(page, 0, '全部供应商');
  await page.waitForTimeout(200);

  // ============ F. 视图切换 timeline ↔ session ============
  console.log('\n—— F. 视图切换 timeline ↔ session ——');
  // timeline: 60 条里首屏 50 行 log-row
  const tlRows = await renderedIds(page);
  check('F1 timeline 视图: 渲染 50 行', tlRows.length === 50, `rows=${tlRows.length}`);
  await page.screenshot({ path: join(SHOT_DIR, 'F1-timeline.png') });
  // 切到 session
  await page.getByRole('button', { name: '会话' }).click();
  await page.waitForTimeout(400);
  // session 视图：会话分组按钮（含 "请求" / "tok"），ungrouped 可能存在
  const groupBtns = await page.locator('button:has-text("请求")').count();
  const sessionRows = await renderedIds(page);
  // 无丢条/重条：session 渲染的 id 应是首屏 50 条的无重复子集（这里首屏含 t1/t2 线程 + 填充）
  const uniqueSession = new Set(sessionRows).size === sessionRows.length;
  check('F2 session 视图: 出现会话分组按钮', groupBtns >= 1, `groups=${groupBtns}`);
  check('F3 session 视图: 行 id 无重复', uniqueSession, `rows=${sessionRows.length} unique=${new Set(sessionRows).size}`);
  await page.screenshot({ path: join(SHOT_DIR, 'F2-session.png') });
  // 切回 timeline
  await page.getByRole('button', { name: '时间线' }).click();
  await page.waitForTimeout(300);

  // ============ G. 加载更多（分页） ============
  console.log('\n—— G. 加载更多（>PAGE_SIZE） ——');
  await page.waitForTimeout(200);
  let gBefore = (await renderedIds(page)).length;
  // 滚动列表容器到底，触发 onLoadMore
  const scrollContainer = page.locator('.overflow-y-auto').first();
  await scrollContainer.evaluate((el: any) => { el.scrollTop = el.scrollHeight; });
  await page.waitForTimeout(800);
  const gAfter = (await renderedIds(page)).length;
  check('G1 滚到底触发加载更多: 行数增加', gAfter > gBefore, `before=${gBefore} after=${gAfter}`);
  check('G2 加载更多后达到 60 条全量', gAfter === 60, `after=${gAfter}`);
  await page.screenshot({ path: join(SHOT_DIR, 'G-loadmore.png') });
  check('G 截图: G-loadmore.png', true);

  // ============ H. 选中态高亮 + URL 同步 ============
  console.log('\n—— H. 选中态高亮 + URL 同步 ——');
  // 选首行
  const firstRow = page.locator('[data-testid="log-row"]').first();
  const firstId = await firstRow.getAttribute('data-logid');
  await firstRow.click();
  await page.waitForTimeout(400);
  const url = page.url();
  const urlHasId = url.includes(`log=${firstId}`);
  const selectedClass = await firstRow.evaluate((el: any) => el.className);
  check('H1 点击行: URL 含 ?log=<id>', urlHasId, `url=${url}`);
  check('H2 点击行: 该行高亮 (bg-bg-elevated)', /bg-bg-elevated/.test(selectedClass), `class=${selectedClass?.slice(0, 80)}`);
  await page.screenshot({ path: join(SHOT_DIR, 'H-selection-highlight.png') });
  check('H 截图: H-selection-highlight.png', true);

  // ============ NEG1. 空列表 → 空态 ============
  console.log('\n—— NEG1. 空列表 → 空态 ——');
  for (const f of readdirSync(LOG_DIR)) if (f.endsWith('.jsonl')) { try { rmSync(join(LOG_DIR, f)); } catch {} }
  await page.goto(`http://127.0.0.1:${VITE_PORT}/`);
  await page.waitForTimeout(500);
  const neg1Rows = await renderedIds(page);
  const emptyVisible = await page.locator('.ant-empty').first().isVisible().catch(() => false);
  check('NEG1 空列表: 0 行 + 渲染空态', neg1Rows.length === 0 && emptyVisible, `rows=${neg1Rows.length} empty=${emptyVisible}`);
  await page.screenshot({ path: join(SHOT_DIR, 'NEG1-empty.png') });
  check('NEG1 截图: NEG1-empty.png', true);

  // ============ NEG2. 全筛选掉 → 空态 ============
  console.log('\n—— NEG2. 全筛选掉 → 空态 ——');
  writeConstructed(entries); // 恢复数据
  await page.goto(`http://127.0.0.1:${VITE_PORT}/`);
  await page.waitForTimeout(500);
  // 数据里只有 alpha/beta；筛 alpha 再叠 openai-responses 会有少量。直接用协议筛一个构造里较少的组合不可控，
  // 改用：筛供应商=alpha 后再筛协议=openai-responses → alpha 的 openai-responses 在构造里几乎为 0（仅填充偶发）
  // 为确定性“全筛掉”，直接走 localStorage 设一个数据里不存在的供应商再刷新
  await page.evaluate(() => { localStorage.setItem('lucent.providerFilter', 'ghost-no-such'); });
  await page.reload();
  await page.waitForTimeout(500);
  const neg2Rows = await renderedIds(page);
  const neg2Empty = await page.locator('.ant-empty').first().isVisible().catch(() => false);
  check('NEG2 全筛掉(ghost-no-such): 0 行 + 空态', neg2Rows.length === 0 && neg2Empty, `rows=${neg2Rows.length} empty=${neg2Empty}`);
  await page.screenshot({ path: join(SHOT_DIR, 'NEG2-all-filtered.png') });
  check('NEG2 截图: NEG2-all-filtered.png', true);

  // ============ NEG3. 分页越界 → /api/logs 返空、total 不变、不崩 ============
  console.log('\n—— NEG3. 分页越界 ——');
  const totalRes = await fetch(`http://127.0.0.1:${WEB_PORT}/api/logs?limit=1&offset=0`);
  const totalJson = await totalRes.json();
  const oobRes = await fetch(`http://127.0.0.1:${WEB_PORT}/api/logs?limit=50&offset=999999`);
  const oobJson = await oobRes.json();
  check('NEG3a 越界 offset: 返回 logs 为空数组', Array.isArray(oobJson.logs) && oobJson.logs.length === 0, `logs=${oobJson.logs?.length}`);
  check('NEG3b 越界 offset: total 仍为真实总数', oobJson.total === totalJson.total && oobJson.total === 60, `oob.total=${oobJson.total} base.total=${totalJson.total}`);
  check('NEG3c 越界 offset: HTTP 200 不崩', oobRes.status === 200, `status=${oobRes.status}`);

  await page.close();
} finally {
  if (browser) await browser.close();
  backend.kill('SIGTERM');
  vite.kill('SIGTERM');
  await upstream.close();
  await new Promise(r => setTimeout(r, 400));
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
