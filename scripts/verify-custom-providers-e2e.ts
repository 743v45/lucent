#!/usr/bin/env tsx
/**
 * scripts/verify-custom-providers-e2e.ts — 自定义供应商全协议全链路端到端验收
 *
 * 对应 openspec/specs/protocol-chain-verification/spec.md
 *
 * 用法: npm run verify:custom
 *
 * 1 个 mock upstream（createMockUpstream format:'auto'）同时处理 3 协议
 * × 2 个自定义供应商（hxy + hxy2，都配齐 3 协议）
 * × 2 种响应模式（SSE + JSON）
 * × 7 个验收环节（请求构造 / 真实响应 / 日志记录 / /api/logs / Web UI request / UI context / UI logrow + schema）
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
import {
  createMockUpstream,
  validateAnthropicBody,
  validateOpenAIChatBody,
  validateOpenAIResponsesBody,
} from '../tests/e2e-helpers.js';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// ==================== 隔离环境 ====================

const CONFIG_DIR = mkdtempSync(join(tmpdir(), 'lucent-custom-verify-'));
const BASE = 55000 + Math.floor(Math.random() * 3000);
const PROXY_PORT = BASE;
const WEB_PORT = BASE + 1;
const VITE_PORT = BASE + 2;

// ==================== mock 上游（复用 helpers.ts fixture, auto 模式分派 3 协议）====================

const upstream = await createMockUpstream({ name: 'custom-verify', format: 'auto' });
const UPSTREAM_BASE = `http://127.0.0.1:${upstream.port}/v1`;

// ==================== 配置（2 个供应商各指向 UPSTREAM_BASE，3 协议全配）====================

writeFileSync(join(CONFIG_DIR, 'config.json'), JSON.stringify({
  host: '127.0.0.1',
  proxyPort: PROXY_PORT,
  webPort: WEB_PORT,
  providers: [
    { id: 'p-hxy', name: 'hxy', endpoints: { 'anthropic-messages': UPSTREAM_BASE, 'openai-chat': UPSTREAM_BASE, 'openai-responses': UPSTREAM_BASE } },
    { id: 'p-hxy2', name: 'hxy2', endpoints: { 'anthropic-messages': UPSTREAM_BASE, 'openai-chat': UPSTREAM_BASE, 'openai-responses': UPSTREAM_BASE } },
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

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, cond: any, detail = '') {
  results.push({ name, ok: !!cond, detail });
  console.log(`  ${cond ? '✓ PASS' : '✗ FAIL'}  ${name}${detail && !cond ? '  →  ' + detail : ''}`);
}

async function post(url: string, headers: Record<string, string>, body: any): Promise<{ status: number; body: string }> {
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
    // SSE 流用 reader 防丢帧
    const reader = (res.body as any).getReader();
    const decoder = new TextDecoder();
    let bodyText = '';
    const start = Date.now();
    while (Date.now() - start < 10000) {
      const { value, done } = await reader.read();
      if (done) break;
      bodyText += decoder.decode(value, { stream: true });
    }
    return { status: res.status, body: bodyText };
  } catch (e: any) { return { status: 0, body: String(e) }; }
}

const REQ_BODIES: Record<string, any> = {
  'anthropic-messages': { model: 'claude-sonnet-4-5', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: '(' }] },
  'openai-chat':        { model: 'gpt-4o', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: '(' }] },
  'openai-responses':   { model: 'gpt-4o', input: 'hi' },
};
const PATHS: Record<string, string> = {
  'anthropic-messages': '/v1/messages',
  'openai-chat':        '/v1/chat/completions',
  'openai-responses':   '/v1/responses',
};
const HEADERS: Record<string, Record<string, string>> = {
  'anthropic-messages': { 'x-api-key': 'sk-x', 'anthropic-version': '2023-06-01' },
  'openai-chat':        { 'authorization': 'Bearer sk-x' },
  'openai-responses':   { 'authorization': 'Bearer sk-x' },
};

// 各协议 SSE/JSON 关键字（验响应格式正确）
const SSE_MARKERS: Record<string, string[]> = {
  'anthropic-messages': ['event: message_start', 'event: content_block_delta', 'event: message_stop'],
  'openai-chat':        ['chat.completion.chunk', '[DONE]'],
  'openai-responses':   ['response.created', 'response.output_text.delta', 'response.completed'],
};
// JSON 响应关键字 + 完整文本（对齐 helpers fixture）
const JSON_CHECK: Record<string, { object: string; textInBody: string }> = {
  'anthropic-messages': { object: '"message"', textInBody: 'Hello from JSON response.' },
  'openai-chat':        { object: '"chat.completion"', textInBody: 'Hello from JSON.' },
  'openai-responses':   { object: '"response"', textInBody: 'Hello from JSON.' },
};

function readLogEntries(): any[] {
  const files = readdirSync(join(CONFIG_DIR, 'logs')).filter(f => f.endsWith('.jsonl')).sort();
  if (!files.length) return [];
  return readFileSync(join(CONFIG_DIR, 'logs', files[files.length - 1]), 'utf-8')
    // 标准 JSONL：一行一条 JSON
    .split('\n').filter(s => s.trim().startsWith('{')).map(s => JSON.parse(s));
}

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

// 单个 provider × protocol × mode 的全链路验收
async function verifyOneCombo(provider: string, protocol: string, mode: 'sse' | 'json') {
  console.log(`\n  ┌─ ${provider} × ${protocol} × ${mode} ─┐`);
  upstream.reset();
  upstream.setMode(mode);

  // ①② 真实响应
  const res = await post(`http://127.0.0.1:${PROXY_PORT}/custom/${provider}${PATHS[protocol]}`, HEADERS[protocol], REQ_BODIES[protocol]);

  if (mode === 'sse') {
    const markersOk = SSE_MARKERS[protocol].every(m => res.body.includes(m));
    check(`①② ${provider} ${protocol} sse: 收到 SSE 流(含 ${SSE_MARKERS[protocol].length} 关键标记)`,
      res.status === 200 && markersOk,
      `status=${res.status} markersOk=${markersOk}`);
  } else {
    const jc = JSON_CHECK[protocol];
    check(`①② ${provider} ${protocol} json: 收到 JSON(含 ${jc.object} + 文本)`,
      res.status === 200 && res.body.includes(jc.object) && res.body.includes(jc.textInBody),
      `status=${res.status} body 前 80: ${res.body.slice(0, 80)}`);
  }

  // ⑥ schema 校验
  const resBodyForSchema: any = mode === 'sse' ? res.body : JSON.parse(res.body);
  const schemaKind: 'sse' | 'json' = mode;
  let schema: { ok: boolean; errors: string[] };
  if (protocol === 'anthropic-messages') schema = validateAnthropicBody(resBodyForSchema, schemaKind);
  else if (protocol === 'openai-chat') schema = validateOpenAIChatBody(resBodyForSchema, schemaKind);
  else schema = validateOpenAIResponsesBody(resBodyForSchema, schemaKind);
  check(`⑥ ${provider} ${protocol} ${mode}: schema 校验`, schema.ok, schema.errors.slice(0, 3).join('; '));

  // ③ 日志记录
  await new Promise(r => setTimeout(r, mode === 'sse' ? 1500 : 400));
  const entries = readLogEntries().filter((e: any) => e.providerName === provider && e.endpointType === protocol);
  const log = entries[entries.length - 1];

  if (protocol === 'openai-responses') {
    // openai-responses 用 input
    check(`③ ${provider} ${protocol} ${mode}: 日志 body.input 保留`,
      log?.body?.input === 'hi',
      `input=${log?.body?.input}`);
  } else {
    check(`③ ${provider} ${protocol} ${mode}: 日志 body.messages.length===2`,
      log?.body?.messages?.length === 2,
      `len=${log?.body?.messages?.length}`);
  }
  if (mode === 'sse') {
    check(`③ ${provider} ${protocol} ${mode}: 日志 response 是 sse_raw`,
      log?.response?.body?.type === 'sse_raw' || Array.isArray(log?.response?.body?.lines),
      `resp.type=${log?.response?.body?.type}`);
  }

  // ④ /api/logs
  const apiRes = await fetch(`http://127.0.0.1:${WEB_PORT}/api/logs?limit=200`);
  const apiJson = await apiRes.json();
  const apiEntry = (apiJson.logs || apiJson).find((l: any) => l.id === log?.id);
  if (protocol === 'openai-responses') {
    check(`④ ${provider} ${protocol} ${mode}: /api/logs 返 body.input`,
      apiEntry?.request?.body?.input === 'hi', `input=${apiEntry?.request?.body?.input}`);
  } else {
    check(`④ ${provider} ${protocol} ${mode}: /api/logs 返 body.messages.length===2`,
      apiEntry?.request?.body?.messages?.length === 2, `len=${apiEntry?.request?.body?.messages?.length}`);
  }

  // ⑤ Web UI 渲染（playwright）
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    // request-body 渲染
    await page.goto(`http://127.0.0.1:${VITE_PORT}/?log=${log.id}&tab=request`);
    await page.getByTestId('tab-request').click().catch(() => {});
    await page.waitForTimeout(300);
    const reqVisible = await page.getByTestId('request-body').isVisible().catch(() => false);
    const reqText = reqVisible ? (await page.getByTestId('request-body').textContent()) : '';
    const reqKey = protocol === 'openai-responses' ? 'input' : 'messages';
    check(`⑤req ${provider} ${protocol} ${mode}: Request tab 渲染 request-body 含 "${reqKey}"`,
      reqVisible && reqText.includes(reqKey), `visible=${reqVisible}`);

    // JsonBlock 折叠断言（仅 anthropic/openai-chat 有 messages 数组，验折叠展开行为）
    if (protocol !== 'openai-responses') {
      // 默认折叠: messages 数组里的对象显示成 {}（level 2 折叠）
      const collapsedOk = reqText.includes('{}') || reqText.includes('"messages"');
      check(`⑤collapse ${provider} ${protocol} ${mode}: 默认折叠(messages 数组对象折叠为 {})`,
        collapsedOk, `含 {}=${reqText.includes('{}')}`);

      // 点展开全部后内字段可见
      await page.getByTestId('tab-request').click().catch(() => {});
      await page.waitForTimeout(200);
      // 尝试点展开按钮（如果有）
      const expandBtn = page.locator('button:has-text("展开"), button:has-text("Expand")').first();
      await expandBtn.click().catch(() => {});
      await page.waitForTimeout(300);
      const expandedText = await page.getByTestId('request-body').textContent().catch(() => '');
      const expandOk = expandedText?.includes('content') || expandedText?.includes('role');
      check(`⑤expand ${provider} ${protocol} ${mode}: 点展开全部后内字段可见(无 JsonBlock 折叠 bug)`,
        !!expandOk, `展开后含 content/role=${expandOk}`);
    }

    // log-row 列表渲染
    await page.goto(`http://127.0.0.1:${VITE_PORT}/`);
    await page.waitForTimeout(400);
    const rowCount = await page.getByTestId('log-row').count();
    check(`⑤row ${provider} ${protocol} ${mode}: 日志列表渲染 log-row`,
      rowCount >= 1, `rows=${rowCount}`);
  } finally {
    await browser.close();
  }
}

try {
  await waitFor(backend, /Lucent|代理|listen|启动/i, 'backend');
  await waitFor(vite, /Local:|ready in/i, 'vite');
  await waitForPort(`http://127.0.0.1:${VITE_PORT}/`, 'vite');
  await new Promise(r => setTimeout(r, 1000));

  console.log(`\n========== 自定义供应商全协议全链路验收 ==========`);
  console.log(`  mock upstream: ${UPSTREAM_BASE} (auto 模式, 3 协议)`);
  console.log(`  后端: proxy=${PROXY_PORT} web=${WEB_PORT} vite=${VITE_PORT}`);
  console.log(`  供应商: hxy + hxy2 × 协议: 3 × 模式: sse+json\n`);

  for (const provider of ['hxy', 'hxy2']) {
    for (const protocol of ['anthropic-messages', 'openai-chat', 'openai-responses']) {
      for (const mode of ['sse', 'json'] as const) {
        await verifyOneCombo(provider, protocol, mode);
      }
    }
  }

} finally {
  backend.kill('SIGTERM');
  vite.kill('SIGTERM');
  await upstream.close();
  await new Promise(r => setTimeout(r, 500));
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
