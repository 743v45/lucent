/**
 * step 3 验收截图脚本
 *
 * 真起 mock 上游 + 后端 + vite，发 50+ 请求造够 keyset 翻页的数据，再用 chromium 驱动 Web UI，
 * 对三个特性各拍一张全页截图（特性元素加红色 outline 作「标注」）：
 *   ① 搜索框（防抖 → 服务端 FTS，列表收窄）
 *   ② 命中高亮（Context tab 正文里命中词被 <mark> 标黄）
 *   ③ keyset 翻页（首页 50 条 +「加载更多」按钮，点开后 >50 条）
 *
 * 产物落在 shots/step3-*.png。跑：npx tsx scripts/capture-step3-shots.ts
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Locator, type Page } from '@playwright/test';
import { createMockUpstream } from '../tests/e2e-helpers.js';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SHOTS_DIR = join(REPO_ROOT, 'shots');
mkdirSync(SHOTS_DIR, { recursive: true });

function waitForStdout(proc: ChildProcess, regex: RegExp, label: string, timeoutMs = 30000): Promise<void> {
  return new Promise((resolve, reject) => {
    let out = '';
    const to = setTimeout(() => reject(new Error(`${label} 启动超时。输出:\n${out.slice(-1500)}`)), timeoutMs);
    let done = false;
    const finish = (e?: Error) => { if (done) return; done = true; clearTimeout(to); if (e) reject(e); else resolve(); };
    proc.stdout?.on('data', (d: Buffer) => { out += d.toString(); if (!done && regex.test(out)) finish(); });
    proc.stderr?.on('data', (d: Buffer) => { out += d.toString(); });
    proc.on('exit', (c) => { if (!done) finish(new Error(`${label} 退出 code=${c}`)); });
  });
}
async function waitForPort(url: string, label: string, timeoutMs = 20000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { const r = await fetch(url); if (r.status > 0) return; } catch { /* 未起 */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${label} 端口不响应: ${url}`);
}
function killGroup(proc: ChildProcess | null): void {
  if (!proc || proc.pid == null) return;
  try { process.kill(-proc.pid, 'SIGTERM'); } catch { /* noop */ }
  try { proc.kill('SIGTERM'); } catch { /* noop */ }
}
async function post(proxyPort: number, path: string, headers: Record<string, string>, body: unknown) {
  const res = await fetch(`http://127.0.0.1:${proxyPort}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.text() };
}
async function poll<T>(fn: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 30000): Promise<T> {
  const start = Date.now();
  let last: T;
  while (Date.now() - start < timeoutMs) {
    last = await fn();
    if (ok(last)) return last;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`poll 超时，最后值: ${last!}`);
}

/** 给目标元素加红色 outline 作标注（截图后再还原） */
async function annotate(loc: Locator): Promise<void> {
  await loc.evaluate((el: HTMLElement) => {
    (el as any)._prev = el.style.outline;
    el.style.outline = '3px solid #ef4444';
    el.style.outlineOffset = '2px';
  });
}
async function unannotate(loc: Locator): Promise<void> {
  await loc.evaluate((el: HTMLElement) => { el.style.outline = (el as any)._prev || ''; });
}

async function main() {
  const configDir = mkdtempSync(join(tmpdir(), 'lucent-step3-shots-'));
  const basePort = 30000 + Math.floor(Math.random() * 25000);
  const proxyPort = basePort, webPort = basePort + 1, vitePort = basePort + 2;
  const upstream = await createMockUpstream({ name: 'step3-shots', format: 'openai' });
  const upstreamBase = `http://127.0.0.1:${upstream.port}/v1`;
  writeFileSync(
    join(configDir, 'config.json'),
    JSON.stringify({
      host: '127.0.0.1', proxyPort, webPort,
      providers: [{ id: 'p', name: 'openai', endpoints: { 'anthropic-messages': null, 'openai-chat': upstreamBase, 'openai-responses': null } }],
    }),
  );

  const backend = spawn('npx', ['tsx', 'server/index.ts'], {
    cwd: REPO_ROOT, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, LUCENT_CONFIG_DIR: configDir, LUCENT_HOST: '127.0.0.1', LUCENT_PROXY_PORT: String(proxyPort), LUCENT_WEB_PORT: String(webPort) },
  });
  const vite = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'], {
    cwd: REPO_ROOT, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, VITE_PORT: String(vitePort), LUCENT_WEB_PORT: String(webPort) },
  });

  const browser = await chromium.launch();
  try {
    await waitForStdout(backend, /Lucent|代理|listen|启动/i, 'backend');
    await waitForStdout(vite, /Local:|ready in/i, 'vite');
    await waitForPort(`http://127.0.0.1:${vitePort}/`, 'vite');
    upstream.setMode('chat-sse');

    const H = { authorization: 'Bearer sk-mock-step3-shots' };
    const NEEDLE = 'STEP3SHOT-NEEDLE';
    // 50 条普通 + 5 条带唯一锚点（够首页 50 + 翻页，且锚点供搜索/高亮）
    for (let i = 0; i < 50; i++) {
      await post(proxyPort, '/openai/v1/chat/completions', H, { model: 'gpt-4o', max_tokens: 1, messages: [{ role: 'user', content: `probe ${i} 讨论代理运行时与检索` }] });
    }
    for (let i = 0; i < 5; i++) {
      await post(proxyPort, '/openai/v1/chat/completions', H, { model: 'gpt-4o', max_tokens: 1, messages: [{ role: 'user', content: `${NEEDLE} 命中锚点编号 ${i}` }] });
    }

    const page: Page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(`http://127.0.0.1:${vitePort}`);
    await page.getByTestId('log-row').first().waitFor({ state: 'visible', timeout: 30000 });
    // 等足 55 条都落库并加载
    await poll(async () => page.getByTestId('log-row').count(), (n) => n >= 50, 30000);

    // ① 搜索框：输入锚点 → 列表收窄到 5 条
    await page.getByTestId('log-search-input').fill(NEEDLE);
    await poll(async () => page.getByTestId('log-row').count(), (n) => n === 5, 15000);
    const searchInput = page.getByTestId('log-search-input');
    await annotate(searchInput);
    await page.screenshot({ path: join(SHOTS_DIR, 'step3-1-search.png'), fullPage: true });
    await unannotate(searchInput);
    console.log('① 搜索框截图: 5 条命中');

    // ② 命中高亮：点开第一条 → Context tab → 选 user 消息 → mark 标黄
    await page.getByTestId('log-row').first().click();
    await page.getByTestId('detail-panel').waitFor({ state: 'visible' });
    await page.getByTestId('tab-context').click();
    await page.getByTestId('context-item').first().click();
    const mark = page.locator('mark.search-hit', { hasText: NEEDLE }).first();
    await mark.waitFor({ state: 'visible', timeout: 10000 });
    await annotate(mark);
    await page.screenshot({ path: join(SHOTS_DIR, 'step3-2-highlight.png'), fullPage: true });
    await unannotate(mark);
    console.log('② 命中高亮截图: mark 可见');

    // ③ keyset 翻页：清空搜索 → 55 条，首页 50；用 JS 直触 onClick 翻第二页（不经滚动，
    //    避免触发列表 onScroll 的自动加载把「加载更多」按钮吃掉）。
    await page.getByTestId('log-search-input').fill('');
    await poll(async () => page.getByTestId('log-row').count(), (n) => n >= 50, 15000);
    const before = await page.getByTestId('log-row').count();
    const countBadge = page.getByTestId('log-count');
    await annotate(countBadge);
    await page.screenshot({ path: join(SHOTS_DIR, 'step3-3-keyset-page1.png'), fullPage: true });
    await unannotate(countBadge);

    // 触发 keyset 下一页（直触按钮 onClick，不滚动）
    const loadMore = page.getByTestId('load-more-btn');
    if (await loadMore.count() > 0) {
      await loadMore.evaluate((el: HTMLElement) => el.click());
    }
    await poll(async () => page.getByTestId('log-row').count(), (n) => n > before, 15000);
    const after = await page.getByTestId('log-row').count();
    // 滚到列表底部，让翻出来的第二页行可见
    await page.getByTestId('log-row').last().scrollIntoViewIfNeeded();
    await annotate(countBadge);
    await page.screenshot({ path: join(SHOTS_DIR, 'step3-3-keyset-page2.png'), fullPage: true });
    await unannotate(countBadge);
    console.log(`③ keyset 翻页截图: 首页 ${before} 条 → 翻页后 ${after} 条`);

    console.log('SHOTS_DIR:', SHOTS_DIR);
  } finally {
    await browser.close();
    killGroup(backend);
    killGroup(vite);
    await upstream.close();
    await new Promise((r) => setTimeout(r, 400));
    try { rmSync(configDir, { recursive: true, force: true }); } catch { /* noop */ }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
