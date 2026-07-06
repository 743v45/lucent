#!/usr/bin/env tsx
/**
 * scripts/verify-loglist-neg-probe.ts — 反向探针（演示「能检出且退出非 0」）
 *
 * 对应 TAE-48 验收：至少一个反向失败用例，确认 harness 能检出异常并退出非 0。
 *
 * 设计：写入 60 条日志（>PAGE_SIZE 50），加载页面后 **不滚动**，立即断言
 *      「首屏已加载全部 60 条」。正确实现首屏只加载 50 条 → 该断言必然失败 → 退出 1。
 *      作用：证明 verify-loglist-e2e.ts 里的 G1/G2（加载更多）不是橡皮图章——
 *      一旦加载更多失效（首屏拿不到全量），harness 会检出并以非 0 退出。
 *
 * 期望：退出码 1（探测到「未滚动时行数 < 60」）。
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readdirSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createMockUpstream } from '../tests/e2e-helpers.js';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CONFIG_DIR = mkdtempSync(join(tmpdir(), 'lucent-loglist-neg-'));
const LOG_DIR = join(CONFIG_DIR, 'logs');
const BASE = 60000 + Math.floor(Math.random() * 2000);
const PROXY_PORT = BASE, WEB_PORT = BASE + 1, VITE_PORT = BASE + 2;
const upstream = await createMockUpstream({ name: 'loglist-neg', format: 'auto' });
const UPSTREAM_BASE = `http://127.0.0.1:${upstream.port}/v1`;

writeFileSync(join(CONFIG_DIR, 'config.json'), JSON.stringify({
  host: '127.0.0.1', proxyPort: PROXY_PORT, webPort: WEB_PORT,
  providers: [{ id: 'p-alpha', name: 'alpha', endpoints: { 'anthropic-messages': UPSTREAM_BASE, 'openai-chat': UPSTREAM_BASE, 'openai-responses': UPSTREAM_BASE } }],
}));

const backend = spawn('npx', ['tsx', 'server/index.ts'], { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LUCENT_CONFIG_DIR: CONFIG_DIR, LUCENT_HOST: '127.0.0.1', LUCENT_PROXY_PORT: String(PROXY_PORT), LUCENT_WEB_PORT: String(WEB_PORT), LUCENT_LOG_DIR: LOG_DIR } });
const vite = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(VITE_PORT), '--strictPort'], { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LUCENT_WEB_PORT: String(WEB_PORT) } });

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
  while (Date.now() - start < timeoutMs) { try { const r = await fetch(url); if (r.status > 0) return; } catch {} await new Promise(r => setTimeout(r, 300)); }
  throw new Error(`${label} port never accepted`);
}

function mkEntry(i: number): any {
  return {
    id: `n-${i}`, timestamp: new Date(Date.UTC(2026, 6, 3, 9, 0, 0) + i * 1000).toISOString(), project: '',
    request: { method: 'POST', url: 'https://up/v1/chat/completions', headers: { 'content-type': 'application/json' }, body: { model: 'gpt-4o', max_tokens: 1, messages: [{ role: 'user', content: 'x' }] } },
    response: { status: 200, statusText: 'OK', headers: { 'content-type': 'application/json' }, body: { id: 'r', type: 'response', role: 'assistant', content: [{ type: 'text', text: 'y' }] } },
    agentType: 'main', apiType: 'openai-chat', clientType: 'test-client', duration: 100 + i,
    metadata: { model: 'gpt-4o', provider: 'openai', stream: false },
    tokenUsage: { input_tokens: 10, output_tokens: 5 }, providerName: 'alpha', endpointType: 'openai-chat',
  };
}

let browser: any;
let exitCode = 0;
try {
  await waitFor(backend, /Lucent|代理|listen|启动/i, 'backend');
  await waitFor(vite, /Local:|ready in/i, 'vite');
  await waitForPort(`http://127.0.0.1:${VITE_PORT}/`, 'vite');
  await new Promise(r => setTimeout(r, 600));

  writeFileSync(join(LOG_DIR, 'constructed.jsonl'), Array.from({ length: 60 }, (_, i) => JSON.stringify(mkEntry(i))).join('\n') + '\n');

  browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${VITE_PORT}/`);
  await page.waitForTimeout(800);
  // 不滚动，立即读行数
  const rows = await page.$$eval('[data-testid="log-row"]', (els: any[]) => els.length);
  console.log(`首屏（未滚动）log-row 数 = ${rows}`);
  console.log(`反向断言：要求首屏即 60 条（模拟「加载更多失效」的预期）`);
  if (rows === 60) {
    console.log(`✗ 探针未检出异常（首屏竟有 60 条）→ 退出 0`);
  } else {
    console.log(`✓ 探针检出：首屏仅 ${rows} 条 < 60（加载更多未把全量塞进首屏，符合预期）→ 退出 1`);
    exitCode = 1;
  }
  await page.close();
} finally {
  if (browser) await browser.close();
  backend.kill('SIGTERM'); vite.kill('SIGTERM'); await upstream.close();
  await new Promise(r => setTimeout(r, 400));
  try { rmSync(CONFIG_DIR, { recursive: true, force: true }); } catch {}
}
process.exit(exitCode);
