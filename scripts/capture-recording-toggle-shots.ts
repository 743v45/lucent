/**
 * 记录开关（「只过路」toggle）两态验收截图脚本 —— TAE-76
 *
 * 真起后端 + vite，用 chromium 驱动 Web UI，对顶栏「记录开关」按钮拍两态截图，
 * 目标元素加红色 outline 作「标注」（与 capture-step3-shots 同一套外置 overlay 规范）：
 *   ① recording-on.png  —— 默认态：记录中（按钮 dim）
 *   ② recording-off.png —— 「只过路」激活态（按钮高亮 text-brand-accent），切换 toast 同框
 *
 * 产物落在 shots/recording-*.png。跑：npx tsx scripts/capture-recording-toggle-shots.ts
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Locator, type Page } from '@playwright/test';

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
  const configDir = mkdtempSync(join(tmpdir(), 'lucent-rec-shots-'));
  const basePort = 30000 + Math.floor(Math.random() * 25000);
  const proxyPort = basePort, webPort = basePort + 1;
  // 不发任何代理请求，upstream 指向死端口即可；开关只走 /api/status 与 /api/recording
  writeFileSync(
    join(configDir, 'config.json'),
    JSON.stringify({
      host: '127.0.0.1', proxyPort, webPort,
      providers: [{ id: 'p', name: 'anthropic', endpoints: { 'anthropic-messages': 'http://127.0.0.1:9/v1', 'openai-chat': null, 'openai-responses': null } }],
    }),
  );

  // 后端本身用 express.static 托管已 build 的 dist/，webPort 直接出 UI（无需另起 vite）
  const backend = spawn('npx', ['tsx', 'server/index.ts'], {
    cwd: REPO_ROOT, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, LUCENT_CONFIG_DIR: configDir, LUCENT_HOST: '127.0.0.1', LUCENT_PROXY_PORT: String(proxyPort), LUCENT_WEB_PORT: String(webPort) },
  });

  const browser = await chromium.launch();
  try {
    await waitForStdout(backend, /Lucent|代理|listen|启动/i, 'backend');
    await waitForPort(`http://127.0.0.1:${webPort}/`, 'web');

    const page: Page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(`http://127.0.0.1:${webPort}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const toggle = page.getByTestId('recording-toggle');
    await toggle.waitFor({ state: 'visible', timeout: 60000 });

    // ① 默认态：记录中（按钮 dim，title 含「记录日志中」）
    await poll(async () => await toggle.getAttribute('title') || '', (t) => t.includes('记录日志中'), 10000);
    const diag1 = await toggle.evaluate((el) => ({ title: el.getAttribute('title'), highlighted: el.classList.contains('text-brand-accent') }));
    console.log('  [diag ①] title="%s" highlighted=%s', diag1.title, diag1.highlighted);
    await annotate(toggle);
    await page.screenshot({ path: join(SHOTS_DIR, 'recording-1-on.png') });
    await unannotate(toggle);
    console.log('① 记录中（默认 dim）截图: recording-1-on.png');

    // ② 切到「只过路」：高亮 text-brand-accent + toast 同框
    await toggle.click();
    await poll(async () => await toggle.evaluate((el) => el.classList.contains('text-brand-accent')), (v) => v === true, 10000);
    const diag2 = await toggle.evaluate((el) => ({ title: el.getAttribute('title'), highlighted: el.classList.contains('text-brand-accent') }));
    const toastText = await page.locator('.ant-message-notice').first().textContent({ timeout: 2000 }).catch(() => null);
    console.log('  [diag ②] title="%s" highlighted=%s toast="%s"', diag2.title, diag2.highlighted, toastText);
    await annotate(toggle);
    await page.screenshot({ path: join(SHOTS_DIR, 'recording-2-off.png') });
    await unannotate(toggle);
    console.log('② 只过路（高亮 + toast）截图: recording-2-off.png');

    console.log('SHOTS_DIR:', SHOTS_DIR);
  } finally {
    await browser.close();
    killGroup(backend);
    await new Promise((r) => setTimeout(r, 400));
    try { rmSync(configDir, { recursive: true, force: true }); } catch { /* noop */ }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
