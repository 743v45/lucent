#!/usr/bin/env tsx
/**
 * scripts/verify-detailpanel-probe.ts — 详情面板 Request/Response Tab 行为探针 + 截图
 *
 * 对应 TAE-49 审查点：
 *  - Request 折叠态/展开态 渲染 + 复制
 *  - Response SSE 原始视图 / 结构化(JSON)视图 渲染 + 复制
 *  - 切日志时内部 state（折叠态 / SSE 视图模式）是否重置（key={log.id} 重建子树）
 *
 * 复用 tests/e2e-helpers.ts 的 createMockUpstream（单一真相源）。
 * 截图落在 /tmp/lucent-detailpanel-shots/，作为验收证据。
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createMockUpstream } from '../tests/e2e-helpers.js';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SHOT_DIR = '/tmp/lucent-detailpanel-shots';
mkdirSync(SHOT_DIR, { recursive: true });

const CONFIG_DIR = mkdtempSync(join(tmpdir(), 'lucent-probe-'));
const BASE = 52000 + Math.floor(Math.random() * 3000);
const PROXY_PORT = BASE;
const WEB_PORT = BASE + 1;
const VITE_PORT = BASE + 2;

const upstream = await createMockUpstream({ name: 'probe', format: 'anthropic' });
const UPSTREAM_BASE = `http://127.0.0.1:${upstream.port}/v1`;

writeFileSync(join(CONFIG_DIR, 'config.json'), JSON.stringify({
  host: '127.0.0.1',
  proxyPort: PROXY_PORT,
  webPort: WEB_PORT,
  providers: [{
    id: 'p-hxy', name: 'hxy',
    endpoints: { 'anthropic-messages': UPSTREAM_BASE, 'openai-chat': null, 'openai-responses': null },
  }],
}));

const backend = spawn('npx', ['tsx', 'server/index.ts'], {
  cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, LUCENT_CONFIG_DIR: CONFIG_DIR, LUCENT_HOST: '127.0.0.1',
    LUCENT_PROXY_PORT: String(PROXY_PORT), LUCENT_WEB_PORT: String(WEB_PORT),
    LUCENT_LOG_DIR: join(CONFIG_DIR, 'logs') },
});
const vite = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(VITE_PORT), '--strictPort'], {
  cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, LUCENT_WEB_PORT: String(WEB_PORT) },
});

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, cond: any, detail = '') {
  results.push({ name, ok: !!cond, detail });
  console.log(`  ${cond ? '✓ PASS' : '✗ FAIL'}  ${name}${detail && !cond ? '  →  ' + detail : ''}`);
}

async function post(url: string, headers: Record<string, string>, body: any) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body) });
  return { status: res.status, body: await res.text() };
}

const ANTH_HEADERS = { 'x-api-key': 'sk-x', 'anthropic-version': '2023-06-01' };
const REQ_BODY = { model: 'claude-sonnet-4-5', max_tokens: 1,
  messages: [{ role: 'user', content: 'What is latin for Ant?' }] };

function readLogEntries() {
  const logDir = join(CONFIG_DIR, 'logs');
  const files = readdirSync(logDir).filter(f => f.endsWith('.jsonl')).sort();
  if (!files.length) return [];
  const content = readFileSync(join(logDir, files[files.length - 1]), 'utf-8');
  return content.split('\n').filter(s => s.trim().startsWith('{')).map(s => JSON.parse(s));
}

async function waitFor(proc: any, regex: RegExp, label: string, timeoutMs = 30000) {
  return new Promise<void>((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(`${label} startup timeout`)), timeoutMs);
    let done = false;
    proc.stdout.on('data', (d: Buffer) => { if (!done && regex.test(d.toString())) { done = true; clearTimeout(to); resolve(); } });
    proc.on('exit', (c: number) => { if (!done) reject(new Error(`${label} exit ${c}`)); });
  });
}
async function waitForPort(url: string, label: string, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { const res = await fetch(url); if (res.status > 0) return; } catch { /* ignore */ }
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error(`${label} port never accepted: ${url}`);
}

const shot = (page: any, name: string) => page.screenshot({ path: join(SHOT_DIR, name), fullPage: false });

try {
  await waitFor(backend, /Lucent|代理|listen|启动/i, 'backend');
  await waitFor(vite, /Local:|ready in/i, 'vite');
  await waitForPort(`http://127.0.0.1:${VITE_PORT}/`, 'vite');
  await new Promise(r => setTimeout(r, 1000));

  const PROXY = `http://127.0.0.1:${PROXY_PORT}`;
  const VITE = `http://127.0.0.1:${VITE_PORT}`;

  console.log(`\n========== 详情面板 Request/Response 行为探针 ==========\n`);
  console.log(`  上游 mock: ${UPSTREAM_BASE}`);
  console.log(`  proxy=${PROXY_PORT} web=${WEB_PORT} vite=${VITE_PORT}`);
  console.log(`  截图目录: ${SHOT_DIR}\n`);

  // 发两条流式 SSE 请求（用于切日志探针）+ 一条非流式 JSON
  upstream.setMode('sse-text');
  const sseRes1 = await post(`${PROXY}/custom/hxy/v1/messages`, ANTH_HEADERS, REQ_BODY);
  check('流式 SSE ①② 穿透成功(7 帧 + 文本)', sseRes1.status === 200 && sseRes1.body.includes('event: message_start') && sseRes1.body.includes('How can I help?'), `status=${sseRes1.status}`);
  await new Promise(r => setTimeout(r, 600));
  const sseLogA = readLogEntries().filter((e: any) => e.providerName === 'hxy').slice(-1)[0];

  const sseRes2 = await post(`${PROXY}/custom/hxy/v1/messages`, ANTH_HEADERS, REQ_BODY);
  check('流式 SSE 第二条(用于切日志)', sseRes2.status === 200);
  await new Promise(r => setTimeout(r, 600));
  const sseLogB = readLogEntries().filter((e: any) => e.providerName === 'hxy').slice(-1)[0];

  upstream.setMode('json');
  const jsonRes = await post(`${PROXY}/custom/hxy/v1/messages`, ANTH_HEADERS, REQ_BODY);
  check('非流式 JSON ①② 穿透成功(content text)', jsonRes.status === 200 && jsonRes.body.includes('Hello from JSON response.'), `status=${jsonRes.status}`);
  await new Promise(r => setTimeout(r, 400));
  const jsonLog = readLogEntries().filter((e: any) => e.providerName === 'hxy').slice(-1)[0];

  check('日志已落盘(SSE A / SSE B / JSON 各 1)', !!sseLogA && !!sseLogB && !!jsonLog && sseLogA.id !== sseLogB.id, `A=${sseLogA?.id?.slice(0,8)} B=${sseLogB?.id?.slice(0,8)} J=${jsonLog?.id?.slice(0,8)}`);

  // 日志记录层：response.body.type
  check('SSE 日志 response.body.type===sse_raw', sseLogA?.response?.body?.type === 'sse_raw', `type=${sseLogA?.response?.body?.type}`);
  check('JSON 日志 response.body.type===message(非 sse_raw)', jsonLog?.response?.body?.type === 'message', `type=${jsonLog?.response?.body?.type}`);

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  const VITE_ORIGIN = VITE;
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: VITE_ORIGIN }).catch(() => { /* noop */ });

  // ============ Request Tab：折叠态 / 展开态 / 复制 ============
  console.log('\n【Request Tab】');
  await page.goto(`${VITE}/?log=${sseLogA.id}&tab=request`);
  await page.waitForTimeout(600);
  await page.getByTestId('tab-request').click().catch(() => { /* noop */ });
  await page.waitForTimeout(300);

  // 默认折叠态：content 深层字符串不可见（level<2，messages[0] 折叠）
  const reqFoldedText = (await page.getByTestId('request-body').textContent()) || '';
  const foldedSeesContent = reqFoldedText.includes('What is latin for Ant?');
  check('Request 默认折叠态：messages[0].content 不可见(level<2)', !foldedSeesContent, `visible=${foldedSeesContent}`);
  await shot(page, '01-request-folded.png');

  // 点「展开全部」
  await page.getByTestId('expand-all').click().catch(() => { /* noop */ });
  await page.waitForTimeout(400);
  const reqExpandedText = (await page.getByTestId('request-body').textContent()) || '';
  const expandedSeesContent = reqExpandedText.includes('What is latin for Ant?');
  check('Request 展开全部：messages[0].content 可见', expandedSeesContent, `visible=${expandedSeesContent}`);
  await shot(page, '02-request-expanded-all.png');

  // 点「收起全部」应回到折叠态
  await page.getByTestId('collapse-all').click().catch(() => { /* noop */ });
  await page.waitForTimeout(400);
  const reqRecollapsedText = (await page.getByTestId('request-body').textContent()) || '';
  const recollapsedSeesContent = reqRecollapsedText.includes('What is latin for Ant?');
  check('Request 收起全部：回到折叠态(content 不可见)', !recollapsedSeesContent, `visible=${recollapsedSeesContent}`);
  await shot(page, '03-request-recollapsed.png');

  // 复制按钮：复制的是 request.body（格式化 JSON），含 messages
  await page.evaluate(() => navigator.clipboard.writeText(''));
  await page.getByText('复制').first().click().catch(() => { /* noop */ });
  await page.waitForTimeout(300);
  const reqCopied = await page.evaluate(() => navigator.clipboard.readText());
  let reqCopiedOk = false;
  try { reqCopiedOk = !!reqCopied && JSON.parse(reqCopied).messages?.[0]?.content === 'What is latin for Ant?'; } catch { /* ignore */ }
  check('Request 复制：内容为格式化 JSON 且含 messages[0].content', reqCopiedOk, `len=${reqCopied?.length} head=${reqCopied?.slice(0, 40)}`);

  // ============ Response Tab：SSE 原始视图 / 结构化视图 / 复制 ============
  console.log('\n【Response Tab · SSE】');
  await page.goto(`${VITE}/?log=${sseLogA.id}&tab=response`);
  await page.waitForTimeout(600);
  await page.getByTestId('tab-response').click().catch(() => { /* noop */ });
  await page.waitForTimeout(300);

  // 默认 raw 视图：原始 SSE 文本可见（含 event: message_start / data:）
  const respDefaultText = (await page.getByTestId('response-body').textContent()) || '';
  const isRawDefault = respDefaultText.includes('event: message_start') && respDefaultText.includes('data: ');
  check('Response SSE 默认=原始视图(event:/data: 可见)', isRawDefault, `head=${respDefaultText.slice(0, 60)}`);
  await shot(page, '04-response-sse-raw.png');

  // 切到结构化视图。默认折叠态下 content[0] 折叠为 {}，故只断言结构出现 + 无 event: 行；
  // 拼回文本的正确性由「结构化复制」断言（取全量 extractedBody）兜底。
  await page.getByText('结构化').click().catch(() => { /* noop */ });
  await page.waitForTimeout(400);
  const respStructuredText = (await page.getByTestId('response-body').textContent()) || '';
  const isStructured = respStructuredText.includes('content') && respStructuredText.includes('"message"')
    && !respStructuredText.includes('event: message_start');
  check('Response SSE 结构化视图：渲染 extractedBody(type=message/content) 且无 event: 行', isStructured, `head=${respStructuredText.slice(0, 80)}`);
  // 展开全部后，拼回文本 Hello! How can I help? 应可见
  await page.getByTestId('expand-all').click().catch(() => { /* noop */ });
  await page.waitForTimeout(400);
  const respStructExpanded = (await page.getByTestId('response-body').textContent()) || '';
  check('Response SSE 结构化展开全部：拼回文本 Hello! How can I help? 可见', respStructExpanded.includes('Hello! How can I help?'), `head=${respStructExpanded.slice(0, 80)}`);
  await shot(page, '05-response-sse-structured.png');
  // 收起，恢复折叠态以便后续复制按钮定位
  await page.getByTestId('collapse-all').click().catch(() => { /* noop */ });
  await page.waitForTimeout(300);

  // 结构化视图复制：复制的是 extractedBody（结构化 JSON），含 content text
  await page.evaluate(() => navigator.clipboard.writeText(''));
  await page.getByText('复制').first().click().catch(() => { /* noop */ });
  await page.waitForTimeout(300);
  const respStructCopied = await page.evaluate(() => navigator.clipboard.readText());
  let respStructCopiedOk = false;
  try { respStructCopiedOk = !!respStructCopied && JSON.parse(respStructCopied).content?.some((c: any) => (c.text || '').includes('Hello! How can I help?')); } catch { /* ignore */ }
  check('Response 结构化复制：内容为 extracted JSON 且含拼回文本', respStructCopiedOk, `head=${respStructCopied?.slice(0, 60)}`);

  // 切回 raw 视图复制：复制的是 rawSSEText（重建的 event:/data: 文本）
  await page.getByText('原始 SSE').click().catch(() => { /* noop */ });
  await page.waitForTimeout(300);
  await page.evaluate(() => navigator.clipboard.writeText(''));
  await page.getByText('复制').first().click().catch(() => { /* noop */ });
  await page.waitForTimeout(300);
  const respRawCopied = await page.evaluate(() => navigator.clipboard.readText());
  const respRawCopiedOk = !!respRawCopied && respRawCopied.includes('event: message_start') && respRawCopied.includes('data: ');
  check('Response 原始 SSE 复制：内容为重建的 event:/data: 文本', respRawCopiedOk, `head=${respRawCopied?.slice(0, 60)}`);

  // ============ Response Tab · 非流式 JSON ============
  console.log('\n【Response Tab · JSON】');
  await page.goto(`${VITE}/?log=${jsonLog.id}&tab=response`);
  await page.waitForTimeout(600);
  const respJsonText = (await page.getByTestId('response-body').textContent()) || '';
  // 默认折叠态下 content[0] 折叠，只断言 content 出现（与官方 verify:anthropic 一致口径）
  const jsonOk = respJsonText.includes('content') && respJsonText.includes('"message"');
  check('Response JSON 视图：渲染 content(默认折叠态)', jsonOk, `head=${respJsonText.slice(0, 80)}`);
  await page.getByTestId('expand-all').click().catch(() => { /* noop */ });
  await page.waitForTimeout(400);
  const respJsonExpanded = (await page.getByTestId('response-body').textContent()) || '';
  check('Response JSON 展开全部：text Hello from JSON response. 可见', respJsonExpanded.includes('Hello from JSON response.'), `head=${respJsonExpanded.slice(0, 80)}`);
  await shot(page, '06-response-json.png');

  // ============ 折叠/展开 状态机边界用例 ============
  console.log('\n【折叠/展开 状态机边界】');
  // 用例：默认折叠 → 点「展开」(CollapseButton, collapsed=false) → 点「展开全部」(expandAll=true)
  //      → 点「收起全部」(expandAll=false)。期望收起全部后回到折叠态。
  //      此用例暴露 expandAll 与 collapsed 双 state 解耦的潜在 desync。
  await page.goto(`${VITE}/?log=${sseLogA.id}&tab=request`);
  await page.waitForTimeout(500);
  await page.getByTestId('tab-request').click().catch(() => { /* noop */ });
  await page.waitForTimeout(300);
  // 1) 默认折叠：content 不可见
  const b1 = (await page.getByTestId('request-body').textContent()) || '';
  check('边界 step1 默认折叠：content 不可见', !b1.includes('What is latin for Ant?'), '');
  // 2) 点「展开」(CollapseButton) → content 可见
  await page.getByText('展开', { exact: true }).click().catch(() => { /* noop */ });
  await page.waitForTimeout(300);
  const b2 = (await page.getByTestId('request-body').textContent()) || '';
  check('边界 step2 点「展开」：content 可见', b2.includes('What is latin for Ant?'), '');
  // 3) 点「展开全部」→ content 可见
  await page.getByTestId('expand-all').click().catch(() => { /* noop */ });
  await page.waitForTimeout(300);
  const b3 = (await page.getByTestId('request-body').textContent()) || '';
  check('边界 step3 点「展开全部」：content 可见', b3.includes('What is latin for Ant?'), '');
  // 4) 点「收起全部」→ 期望回到折叠态(content 不可见)
  await page.getByTestId('collapse-all').click().catch(() => { /* noop */ });
  await page.waitForTimeout(400);
  const b4 = (await page.getByTestId('request-body').textContent()) || '';
  const b4Sees = b4.includes('What is latin for Ant?');
  check('边界 step4 点「收起全部」：应回到折叠态(content 不可见)', !b4Sees, `content可见=${b4Sees}（若 true=收起全部未生效，state desync bug）`);

  // ============ 切日志：内部 state 重置探针（客户端切换，不走 page.goto）============
  console.log('\n【切日志 state 重置探针（客户端 sidebar 切换）】');
  // 在 log A 上展开全部（Request），然后用 sidebar 点 log B（客户端，不重载），看折叠态是否重置
  await page.goto(`${VITE}/?log=${sseLogA.id}&tab=request`);
  await page.waitForTimeout(500);
  await page.getByTestId('expand-all').click().catch(() => { /* noop */ });
  await page.waitForTimeout(400);
  const afterExpandA = (await page.getByTestId('request-body').textContent()) || '';
  check('探针前置：log A 展开全部后 content 可见', afterExpandA.includes('What is latin for Ant?'), `visible=${afterExpandA.includes('What is latin for Ant?')}`);

  // 客户端切换：点 sidebar 里 log B 的行（不触发 page.goto 全量重载）
  await page.locator(`[data-testid="log-row"][data-logid="${sseLogB.id}"]`).click().catch(() => { /* noop */ });
  await page.waitForTimeout(600);
  const afterSwitchB = (await page.getByTestId('request-body').textContent()) || '';
  const bSeesContent = afterSwitchB.includes('What is latin for Ant?');
  // 期望（按 DetailPanel 注释）：切日志后折叠态重置 → content 不可见
  check('切日志后 Request 折叠态重置（content 应不可见）', !bSeesContent, `content可见=${bSeesContent}（若 true=折叠态未重置，bodyCollapsed/expandAll 持久化 bug）`);
  await shot(page, '07-after-switch-log.png');

  // SSE 视图模式重置探针：在 log A response 切到「结构化」，客户端切到 log B response，应回到默认 raw
  await page.locator(`[data-testid="log-row"][data-logid="${sseLogA.id}"]`).click().catch(() => { /* noop */ });
  await page.waitForTimeout(400);
  await page.getByTestId('tab-response').click().catch(() => { /* noop */ });
  await page.waitForTimeout(400);
  await page.getByText('结构化').click().catch(() => { /* noop */ });
  await page.waitForTimeout(300);
  const aStruct = (await page.getByTestId('response-body').textContent()) || '';
  check('探针前置：log A response 切到结构化视图', aStruct.includes('content') && !aStruct.includes('event: message_start'), '');
  // 客户端切到 log B
  await page.locator(`[data-testid="log-row"][data-logid="${sseLogB.id}"]`).click().catch(() => { /* noop */ });
  await page.waitForTimeout(600);
  const bResp = (await page.getByTestId('response-body').textContent()) || '';
  const bIsRaw = bResp.includes('event: message_start');
  check('切日志后 Response SSE 视图模式重置（应回到 raw）', bIsRaw, `isRaw=${bIsRaw}`);

  await browser.close();
} finally {
  backend.kill('SIGTERM');
  vite.kill('SIGTERM');
  await upstream.close();
  await new Promise(r => setTimeout(r, 500));
  try { rmSync(CONFIG_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
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
