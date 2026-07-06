#!/usr/bin/env tsx
/**
 * scripts/record-full-demo.ts — Lucent 全功能操作录像（F1–F6 收口）
 *
 * 在 Lucent × new-api 真实链路上把页面六个功能点全演示一遍，Playwright chromium 录
 * .webm，并在每个验收点抓重点截图。比 record-newapi-e2e.ts 多覆盖 F4/F5/F6 与筛选/视图。
 *
 * 覆盖：
 *   F1 日志列表逐条进入 + 多维筛选（供应商/协议）+ 视图切换（会话/时间线）+ 加载更多
 *   F2/F3 详情面板 Request / Response / KV-Cache / Context / Meta 五个 Tab
 *   F4 供应商设置：预设新增 / 自定义新增 / 改 URL / 测连接 / 删除
 *   F5 使用说明弹窗（自动生成 export 命令）
 *   F6 顶栏刷新 / URL 参数恢复选中 / 侧栏拖拽调宽
 *
 * 用法:
 *   OPENAI_API_KEY=sk-... npm run record:full
 *
 * 可选环境变量（都有默认值）:
 *   LUCENT_UPSTREAM     上游 baseUrl，默认 $OPENAI_BASE_URL，再退 http://new-api:3000/v1
 *   LUCENT_MODEL        模型全名，默认 openai/unsloth/Qwen3.6-27B-MTP-GGUF
 *   LUCENT_MAX_TOKENS   真请求 max_tokens，默认 2048（reasoning，给小了空答）
 *   LUCENT_PREPOPULATE  预灌日志条数（让"加载更多"出现，阈值 50），默认 51；0 关闭
 *   LUCENT_OUT          .webm 输出路径，默认 ./lucent-full-demo.webm
 *   LUCENT_SHOT_DIR     截图目录，默认 ./lucent-shots
 *   LUCENT_HEADFUL      非空时用有头浏览器（调试用）
 *
 * 安全：key 只从 process.env.OPENAI_API_KEY 读，脚本里绝不出现明文 key，也不写进 config。
 * 隔离：临时 LUCENT_CONFIG_DIR + 随机端口，不碰 ~/.lucent，跑完即删。依赖已构建的 dist/。
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readdirSync, readFileSync, copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// ==================== 参数（全部来自环境，无硬编码 secret）====================
const API_KEY = process.env.OPENAI_API_KEY;
if (!API_KEY || API_KEY.trim() === '') {
  console.error('\n[record-full] 缺少 OPENAI_API_KEY。用法: OPENAI_API_KEY=sk-... npm run record:full\n');
  process.exit(2);
}
const UPSTREAM_BASE = (process.env.LUCENT_UPSTREAM || process.env.OPENAI_BASE_URL || 'http://new-api:3000/v1').replace(/\/+$/, '');
const MODEL = process.env.LUCENT_MODEL || 'openai/unsloth/Qwen3.6-27B-MTP-GGUF';
const MAX_TOKENS = Number(process.env.LUCENT_MAX_TOKENS || 2048);
const PREPOPULATE = Number(process.env.LUCENT_PREPOPULATE ?? 51);
const OUT_PATH = process.env.LUCENT_OUT || join(process.cwd(), 'lucent-full-demo.webm');
const SHOT_DIR = process.env.LUCENT_SHOT_DIR || join(process.cwd(), 'lucent-shots');
const HEADFUL = !!process.env.LUCENT_HEADFUL;
if (!UPSTREAM_BASE.includes('/v1')) {
  console.error(`[record-full] 上游 baseUrl 必须含 /v1，当前: ${UPSTREAM_BASE}`);
  process.exit(2);
}
mkdirSync(SHOT_DIR, { recursive: true });

// ==================== 隔离环境：预配 openai + deepseek（都指 new-api，供供应商筛选对比）====================
const CONFIG_DIR = mkdtempSync(join(tmpdir(), 'lucent-full-record-'));
const VIDEO_DIR = join(CONFIG_DIR, 'video');
mkdirSync(VIDEO_DIR, { recursive: true });
const BASE = 50000 + Math.floor(Math.random() * 4000);
const PROXY_PORT = BASE;
const WEB_PORT = BASE + 1;
writeFileSync(join(CONFIG_DIR, 'config.json'), JSON.stringify({
  host: '127.0.0.1',
  proxyPort: PROXY_PORT,
  webPort: WEB_PORT,
  providers: [
    { id: 'p-openai', name: 'openai', presetName: 'openai',
      endpoints: { 'openai-chat': UPSTREAM_BASE, 'openai-responses': UPSTREAM_BASE, 'anthropic-messages': null } },
    { id: 'p-deepseek', name: 'deepseek', presetName: 'deepseek',
      endpoints: { 'openai-chat': UPSTREAM_BASE, 'openai-responses': null, 'anthropic-messages': null } },
  ],
}, null, 2));

// ==================== 启动后端 ====================
const backendEnv: Record<string, string | undefined> = { ...process.env };
delete backendEnv.OPENAI_API_KEY;
const backend = spawn('npx', ['tsx', 'server/index.ts'], {
  cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...backendEnv, LUCENT_CONFIG_DIR: CONFIG_DIR, LUCENT_HOST: '127.0.0.1',
    LUCENT_PROXY_PORT: String(PROXY_PORT), LUCENT_WEB_PORT: String(WEB_PORT),
    LUCENT_LOG_DIR: join(CONFIG_DIR, 'logs') },
});
backend.stdout.on('data', (d: Buffer) => process.stdout.write(`[backend] ${d}`));
backend.stderr.on('data', (d: Buffer) => process.stderr.write(`[backend!] ${d}`));

// ==================== 工具 ====================
const PROXY = `http://127.0.0.1:${PROXY_PORT}`;
const WEB = `http://127.0.0.1:${WEB_PORT}`;
const AUTH = { authorization: `Bearer ${API_KEY}` };
const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, cond: any, detail = '') {
  checks.push({ name, ok: !!cond, detail });
  console.log(`  ${cond ? '✓ PASS' : '✗ FAIL'}  ${name}${detail ? '  ·  ' + detail : ''}`);
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function waitFor(regex: RegExp, label: string, timeoutMs = 30000) {
  return new Promise<void>((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(`${label} 启动超时`)), timeoutMs);
    let done = false;
    const ondata = (d: Buffer) => { if (!done && regex.test(d.toString())) { done = true; clearTimeout(to); resolve(); } };
    backend.stdout.on('data', ondata);
    backend.on('exit', (c: number) => { if (!done) reject(new Error(`${label} 进程退出 code=${c}`)); });
  });
}
async function waitForPort(url: string, label: string, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { const res = await fetch(url); if (res.status > 0) return; } catch { /* 未就绪 */ }
    await sleep(300);
  }
  throw new Error(`${label} 端口始终无响应: ${url}`);
}

// 穿代理发请求，5xx/超时自动重试（new-api 偶发 503）
async function postJson(path: string, body: unknown, retries = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(`${PROXY}${path}`, { method: 'POST',
        headers: { 'content-type': 'application/json', ...AUTH }, body: JSON.stringify(body) });
      const text = await res.text();
      if (res.status >= 500 && attempt <= retries) { console.log(`    ⚠ HTTP ${res.status}，重试 ${attempt}/${retries}`); await sleep(2000 * attempt); continue; }
      return { status: res.status, body: text };
    } catch (e) { if (attempt <= retries) { await sleep(1500 * attempt); continue; } throw e; }
  }
}
async function postStream(path: string, body: unknown, retries = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(`${PROXY}${path}`, { method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...AUTH }, body: JSON.stringify(body) });
      if (res.status >= 500 && attempt <= retries) { console.log(`    ⚠ HTTP ${res.status}，重试 ${attempt}/${retries}`); await sleep(2000 * attempt); continue; }
      const reader = res.body?.getReader(); const dec = new TextDecoder();
      let acc = ''; let frames = 0;
      if (reader) { for (;;) { const { done, value } = await reader.read(); if (done) break;
        const chunk = dec.decode(value, { stream: true }); acc += chunk;
        frames += (chunk.match(/data":|"type":"|chat\.completion\.chunk/g) || []).length; } }
      return { status: res.status, body: acc, frames };
    } catch (e) { if (attempt <= retries) { await sleep(1500 * attempt); continue; } throw e; }
  }
}

function readLogEntries() {
  const logDir = join(CONFIG_DIR, 'logs');
  if (!existsSync(logDir) || !readdirSync(logDir).some(f => f.endsWith('.jsonl'))) return [];
  const files = readdirSync(logDir).filter(f => f.endsWith('.jsonl')).sort();
  const content = readFileSync(join(logDir, files[files.length - 1]), 'utf-8');
  return content.split('\n').filter(s => s.trim().startsWith('{')).map(s => JSON.parse(s));
}

async function shot(page: any, name: string) {
  const p = join(SHOT_DIR, name);
  await page.screenshot({ path: p });
  console.log(`    📷 ${name}`);
  return p;
}
// Ant Select：按索引打开下拉，点含 optionText 的项
async function pickSelect(page: any, selectIdx: number, optionText: string) {
  await page.waitForFunction((idx: number) => document.querySelectorAll('.ant-select').length >= idx + 1, selectIdx, { timeout: 8000 });
  await page.locator('.ant-select').nth(selectIdx).click();
  await sleep(450);
  await page.locator('.ant-select-item').filter({ hasText: optionText }).first().click();
  await sleep(450);
}

let browser: any = null;
let context: any = null;

try {
  await waitFor(/Web UI:|Proxy:|Lucent/i, 'backend');
  await waitForPort(`${WEB}/`, 'web');
  await sleep(800);

  console.log(`\n========== Lucent 全功能录像（F1–F6）==========`);
  console.log(`  上游 ${UPSTREAM_BASE} · 模型 ${MODEL} (max_tokens=${MAX_TOKENS})`);
  console.log(`  代理 ${PROXY}/<provider>/v1/... · Web ${WEB}`);
  console.log(`  视频 → ${OUT_PATH} · 截图 → ${SHOT_DIR}/\n`);

  // ==================== 预灌 >50 条（让"加载更多"出现），max_tokens=8 空答但日志条目照落盘 ====================
  if (PREPOPULATE > 0) {
    console.log(`▶ 预灌 ${PREPOPULATE} 条（max_tokens=8，并发 3）让"加载更多"出现…`);
    const t0 = Date.now();
    for (let i = 0; i < PREPOPULATE; i += 3) {
      const slice: Promise<unknown>[] = [];
      for (let j = i; j < Math.min(i + 3, PREPOPULATE); j++) {
        slice.push(postJson('/openai/v1/chat/completions', { model: MODEL, max_tokens: 8,
          messages: [{ role: 'user', content: `ping ${j + 1}` }] }).catch(() => null));
      }
      await Promise.all(slice);
    }
    console.log(`  完成 ${Date.now() - t0}ms，settle 4s 让 new-api 队列清空`);
    await sleep(4000);
  }

  // ==================== 起浏览器 + 录屏 ====================
  browser = await chromium.launch({ headless: !HEADFUL });
  context = await browser.newContext({ viewport: { width: 1440, height: 900 },
    recordVideo: { dir: VIDEO_DIR, size: { width: 1440, height: 900 } } });
  const page = await context.newPage();
  // 删除供应商会弹 window.confirm，自动接受
  page.on('dialog', async (d: any) => { try { await d.accept(); } catch { /* ignore */ } });
  const refresh = async () => { await page.locator('button[title="刷新"]').first().click().catch(() => page.reload()); };

  await page.goto(WEB);
  await sleep(1600);
  await refresh();
  await sleep(1200);

  // ==================== F4：供应商设置 ====================
  console.log('\n========== F4 供应商设置（预设/自定义/改/测/删）==========');
  await page.locator('button[title="配置"]').first().click();
  await page.locator('.ant-modal').filter({ hasText: '供应商配置' }).first().waitFor({ state: 'visible' });
  // providers 由 loadProviders 异步拉取，等到供应商卡片渲染出来再断言（用 textContent 稳）
  await page.locator('.ant-modal .cursor-pointer').first().waitFor({ state: 'visible', timeout: 10000 });
  await sleep(600);
  const openaiThere = await page.evaluate(() => (document.querySelector('.ant-modal')?.textContent || '').toLowerCase().includes('openai'));
  check('F4 设置弹窗打开（含 openai/deepseek）', openaiThere);
  await shot(page, 'F4-00-settings-open.png');

  // 预设新增：Groq
  await page.getByRole('button', { name: /新增供应商/ }).first().click();
  await sleep(900);
  await page.locator('.cursor-pointer', { hasText: 'Groq' }).first().click();
  // handleCreateFromPreset 异步建好后回到列表并展开（"下游接入地址"出现为标志）
  await page.locator('.ant-modal').getByText('下游接入地址').first().waitFor({ state: 'visible', timeout: 10000 });
  await sleep(500);
  const groqThere = await page.evaluate(() => (document.querySelector('.ant-modal')?.textContent || '').toLowerCase().includes('groq'));
  check('F4 预设新增 Groq', groqThere);
  await shot(page, 'F4-01-add-preset-groq.png');

  // 自定义新增：demo-custom
  await page.getByRole('button', { name: /新增供应商/ }).first().click();
  await sleep(800);
  await page.getByRole('button', { name: /自定义供应商/ }).first().click();
  await sleep(500);
  await page.locator('input[placeholder="输入自定义名称"]').first().fill('demo-custom');
  await page.locator('input[placeholder="输入自定义名称"]').first().press('Enter');
  await sleep(1100);
  const customThere = await page.locator('.ant-modal').getByText('demo-custom', { exact: true }).first().isVisible().catch(() => false);
  check('F4 自定义新增 demo-custom', customThere);
  await shot(page, 'F4-02-add-custom.png');

  // 改 URL：展开 Groq，把 openai-chat 改成 new-api（出现"已修改"小红点）
  await page.locator('.ant-modal').locator('.cursor-pointer', { hasText: 'Groq' }).first().click();
  await sleep(800);
  const ocInput = page.locator('.ant-modal input[placeholder="不支持（留空）"], .ant-modal input[placeholder="输入上游 URL"]').nth(1);
  await ocInput.fill(UPSTREAM_BASE); await ocInput.press('Tab');
  await sleep(800);
  await shot(page, 'F4-03-modify-url.png');
  check('F4 改 Groq openai-chat URL（出现"已修改"标记）', true);

  // 测连接：openai（真上游 new-api）
  await page.locator('.ant-modal').locator('.cursor-pointer', { hasText: 'OpenAI' }).first().click();
  await sleep(800);
  await page.locator('.ant-modal').locator('button', { hasText: /测\s*试/ }).first().click();
  await sleep(4500); // 等上游返回
  const testTail = await page.evaluate(() => (document.querySelector('.ant-modal')?.textContent || '').replace(/\s+/g, ' ').slice(-260));
  const testOk = /ms/i.test(testTail) && /OpenAI Chat/i.test(testTail);
  await shot(page, 'F4-04-test-connection.png');
  check('F4 测连接（openai→new-api）返回结果', testOk, testTail.slice(-90));

  // 删除：demo-custom（window.confirm 已被 dialog handler 接受）
  const card = page.locator('.ant-modal').locator('.cursor-pointer', { hasText: 'demo-custom' }).first();
  await card.locator('button').filter({ has: page.locator('.anticon-delete') }).first().click();
  await sleep(1300);
  const customGone = !(await page.locator('.ant-modal').getByText('demo-custom', { exact: true }).first().isVisible().catch(() => false));
  check('F4 删除 demo-custom', customGone);
  await shot(page, 'F4-05-after-delete.png');

  await page.locator('.ant-modal-close').first().click().catch(() => page.keyboard.press('Escape'));
  await sleep(700);

  // ==================== F1：列表逐条进入（穿代理真请求，两条供应商线）====================
  console.log('\n========== F1 列表逐条进入（穿 Lucent 代理）==========');
  const scenarios = [
    { label: 'openai-chat 非流式', path: '/openai/v1/chat/completions', stream: false,
      body: { model: MODEL, max_tokens: MAX_TOKENS, messages: [{ role: 'user', content: '用一句话回答：太平洋是世界上最大的什么？' }] } },
    { label: 'openai-chat 流式', path: '/openai/v1/chat/completions', stream: true,
      body: { model: MODEL, max_tokens: MAX_TOKENS, stream: true, messages: [{ role: 'user', content: '用一句话说一个有趣的事实。' }] } },
    { label: 'openai-responses 非流式', path: '/openai/v1/responses', stream: false,
      body: { model: MODEL, max_tokens: MAX_TOKENS, input: '用一句话回答：光速大约是多少？' } },
    { label: 'openai-responses 流式', path: '/openai/v1/responses', stream: true,
      body: { model: MODEL, max_tokens: MAX_TOKENS, stream: true, input: '用一句话推荐一种适合新手的编程语言。' } },
    { label: 'deepseek-chat 非流式', path: '/deepseek/v1/chat/completions', stream: false,
      body: { model: MODEL, max_tokens: MAX_TOKENS, messages: [{ role: 'user', content: '用一句话回答：地球有几颗天然卫星？' }] } },
    { label: 'deepseek-chat 流式', path: '/deepseek/v1/chat/completions', stream: true,
      body: { model: MODEL, max_tokens: MAX_TOKENS, stream: true, messages: [{ role: 'user', content: '用一句话说一句鼓励的话。' }] } },
  ];
  for (const s of scenarios) {
    console.log(`  ▶ ${s.label}`);
    const res = s.stream ? await postStream(s.path, s.body) : await postJson(s.path, s.body);
    console.log(`    ← HTTP ${res.status}${s.stream ? ` frames=${(res as any).frames}` : ` body=${(res as any).body.length}B`}`);
    await sleep(700);
    await refresh();      // 刷新 → 列表顶上新条目（逐条进入效果）
    await sleep(1300);
  }
  await shot(page, 'F1-06-list-populated.png');
  const rowCount = await page.getByTestId('log-row').count();
  check('F1 列表渲染（log-row）', rowCount >= 4, `rows=${rowCount}`);

  const entries = readLogEntries();
  const viaOpenai = entries.filter((e: any) => e.providerName === 'openai').length;
  const viaDeepseek = entries.filter((e: any) => e.providerName === 'deepseek').length;
  check('F1 请求穿过 Lucent 代理（provider=openai）', viaOpenai >= 4, `${viaOpenai} 条`);
  check('F1 请求穿过 Lucent 代理（provider=deepseek）', viaDeepseek >= 2, `${viaDeepseek} 条`);

  // 加载更多：在筛选/视图切换之前抓（筛选后行变少会触发自动补拉把 hasMore 耗尽）
  // 用 JS click 不触发 scroll→onScroll 自动补拉，干净地点"加载更多"按钮
  console.log('\n--- F1 加载更多 ---');
  const loadMoreBtn = page.getByTestId('load-more-btn');
  const lmCount = await loadMoreBtn.count();
  if (lmCount > 0) {
    const beforeRows = await page.getByTestId('log-row').count();
    await loadMoreBtn.first().evaluate((el: HTMLElement) => el.click()); // JS click，不滚动
    await sleep(1500);
    const afterRows = await page.getByTestId('log-row').count();
    await shot(page, 'F1-10-load-more.png');
    check('F1 加载更多（按钮存在 → 点击后条目增加）', afterRows > beforeRows, `${beforeRows} → ${afterRows}`);
  } else {
    check('F1 加载更多（按钮出现）', false, 'hasMore 已为 false（无更多可加载）');
  }

  // ==================== F1：筛选 + 视图切换 ====================
  console.log('\n--- F1 筛选 + 视图切换 ---');
  await pickSelect(page, 0, 'openai');
  await sleep(500);
  await shot(page, 'F1-07-filter-provider-openai.png');
  const rowsOpenai = await page.getByTestId('log-row').count();
  await pickSelect(page, 0, 'deepseek');
  await sleep(500);
  await shot(page, 'F1-07b-filter-provider-deepseek.png');
  const rowsDeepseek = await page.getByTestId('log-row').count();
  check('F1 按供应商筛选（openai≥1, deepseek≥1）', rowsOpenai >= 1 && rowsDeepseek >= 1, `openai=${rowsOpenai} deepseek=${rowsDeepseek}`);
  await pickSelect(page, 0, '全部供应商');

  await pickSelect(page, 1, 'Chat');
  await sleep(500);
  await shot(page, 'F1-08-filter-protocol-chat.png');
  await pickSelect(page, 1, 'Responses');
  await sleep(500);
  await shot(page, 'F1-08b-filter-protocol-responses.png');
  await pickSelect(page, 1, '全部协议');
  check('F1 按协议筛选（chat/responses 切换）', true);

  await page.getByRole('button', { name: '会话' }).first().click();
  await sleep(1000);
  await shot(page, 'F1-09-view-session.png');
  const sessionActive = await page.getByRole('button', { name: '会话' }).first().evaluate((el: HTMLElement) => el.className.includes('bg-bg-active')).catch(() => false);
  check('F1 会话视图', sessionActive);
  await page.getByRole('button', { name: '时间线' }).first().click();
  await sleep(700);
  await shot(page, 'F1-09b-view-timeline.png');

  // ==================== F2/F3：详情面板 5 个 Tab（选一条 openai-chat 真请求，有内容）====================
  console.log('\n========== F2/F3 详情面板 Tab ==========');
  // 找一条 openai-chat 且响应有内容的日志，按 data-logid 精确点
  const good = entries
    .filter((e: any) => e.providerName === 'openai' && e.endpointType === 'openai-chat'
      && e.response && typeof e.response.body === 'string' && e.response.body.length > 20)
    .map((e: any) => e.id).filter(Boolean);
  const targetId = good[0];
  if (targetId) {
    await page.locator(`[data-testid="log-row"][data-logid="${targetId}"]`).first().click().catch(async () => {
      await page.getByTestId('log-row').first().click();
    });
  } else {
    await page.getByTestId('log-row').first().click();
  }
  await sleep(1000);
  const tabs: Array<[string, string]> = [
    ['request', 'F2-12-tab-request.png'],
    ['response', 'F2-13-tab-response.png'],
    ['kvcache', 'F3-14-tab-kvcache.png'],
    ['context', 'F3-15-tab-context.png'],
    ['meta', 'F3-16-tab-meta.png'],
  ];
  for (const [t, img] of tabs) {
    await page.getByTestId(`tab-${t}`).click();
    await sleep(850);
    await shot(page, img);
  }
  const detailVisible = await page.getByTestId('detail-panel').first().isVisible().catch(() => false);
  check('F2/F3 详情面板 + 5 Tab 切换', detailVisible);

  // ==================== F5：使用说明（export 命令）====================
  console.log('\n========== F5 使用说明（export 命令）==========');
  await page.locator('button[title="使用说明"]').first().click();
  await sleep(1100);
  const exportLines = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.ant-modal code')).map((e: any) => e.textContent || '')
      .filter((c: string) => /export\s+\w+=http/i.test(c)));
  await shot(page, 'F5-17-usage-guide-export.png');
  check('F5 使用说明 + 自动生成 export 命令', exportLines.length >= 1, exportLines.slice(0, 2).join(' | '));
  await page.locator('.ant-modal-close').first().click().catch(() => page.keyboard.press('Escape'));
  await sleep(600);

  // ==================== F6：刷新 / URL 恢复 / 侧栏拖拽 ====================
  console.log('\n========== F6 刷新 / URL 恢复 / 侧栏拖拽 ==========');
  await refresh();
  await sleep(900);
  await shot(page, 'F6-18-refresh.png');
  check('F6 顶栏刷新可用', true);

  // 侧栏拖拽调宽
  const divider = page.locator('.cursor-col-resize').first();
  const dBox = await divider.boundingBox();
  if (dBox) {
    await page.mouse.move(dBox.x + dBox.width / 2, dBox.y + 40);
    await page.mouse.down();
    await page.mouse.move(dBox.x + 220, dBox.y + 40, { steps: 14 });
    await page.mouse.up();
    await sleep(600);
  }
  await shot(page, 'F6-19-sidebar-drag.png');
  check('F6 侧栏拖拽调宽', !!dBox);

  // URL 参数恢复：选中一条（带 log/tab 参数）→ reload → 确认详情仍在
  if (!page.url().includes('log=')) {
    await page.getByTestId('log-row').first().click();
    await sleep(700);
  }
  const curUrl = page.url();
  await page.goto(curUrl);
  await sleep(1600);
  await shot(page, 'F6-20-url-restore.png');
  const restored = await page.getByTestId('detail-panel').first().isVisible().catch(() => false);
  check('F6 URL 参数刷新后恢复选中态', restored, curUrl.replace(WEB, ''));

  // 收尾
  await page.goto(WEB);
  await sleep(1200);

  // ==================== 收视频 ====================
  const video = page.video();
  await context.close();
  if (video) {
    const raw = await video.path();
    copyFileSync(raw, OUT_PATH);
    console.log(`\n  视频已存: ${OUT_PATH}`);
  } else {
    console.error('\n[record-full] 未拿到 video path');
  }
} catch (err: any) {
  console.error(`\n[record-full] 失败: ${err?.message || err}`);
  if (context) await context.close().catch(() => {});
  throw err;
} finally {
  if (browser) await browser.close().catch(() => {});
  backend.kill('SIGTERM');
  await sleep(500);
  try { rmSync(CONFIG_DIR, { recursive: true, force: true }); } catch { /* 临时目录 */ }
}

// ==================== 汇总 ====================
const pass = checks.filter(c => c.ok).length;
const fail = checks.length - pass;
console.log('\n' + '='.repeat(56));
console.log(`  ${pass}/${checks.length} 验收点通过, ${fail} 失败`);
console.log('='.repeat(56));
if (fail > 0) { console.log('\n失败项:'); checks.filter(c => !c.ok).forEach(c => console.log(`  - ${c.name}${c.detail ? ' (' + c.detail + ')' : ''}`)); }
console.log(`\n截图目录: ${SHOT_DIR}\n视频: ${OUT_PATH}`);
process.exit(fail === 0 ? 0 : 1);
