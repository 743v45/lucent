#!/usr/bin/env tsx
/**
 * scripts/record-newapi-e2e.ts — Lucent × new-api 真实链路录屏 + 全链路验收
 *
 * 把真实上游 new-api 配成 Lucent 的 openai 预设供应商，穿 Lucent 代理发真请求
 * （openai-chat / openai-responses，各 流式 + 非流式），确认 Web UI 渲染出日志，
 * 并用 Playwright chromium 录一段 .webm 操作视频。
 *
 * 用法:
 *   OPENAI_API_KEY=sk-... npm run record:newapi
 *
 * 可选环境变量（都有默认值，方便复用）:
 *   LUCENT_UPSTREAM   上游 baseUrl，默认 $OPENAI_BASE_URL，再退 http://new-api:3000/v1
 *   LUCENT_MODEL      模型全名，默认 openai/unsloth/Qwen3.6-27B-MTP-GGUF
 *   LUCENT_MAX_TOKENS 默认 2048（reasoning 模型，给小了会全花在思考上 → content 空串）
 *   LUCENT_OUT        .webm 输出路径，默认 ./lucent-newapi-demo.webm
 *   LUCENT_HEADFUL    非空时用有头浏览器（调试用，CI/录屏留空走 headless）
 *
 * 安全:
 *   - key 只从 process.env.OPENAI_API_KEY 读，脚本里绝不出现明文 key，也不写进 config。
 *   - 上游地址、模型名不是 secret，可留默认值。
 *
 * 隔离:
 *   - 临时 LUCENT_CONFIG_DIR + 随机端口，不碰 ~/.lucent，跑完即删。
 *   - 依赖已构建好的 dist/（npm run build）；后端用 `tsx server/index.ts` 直接 serve dist。
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readdirSync, readFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// ==================== 参数（全部来自环境，无硬编码 secret）====================

const API_KEY = process.env.OPENAI_API_KEY;
if (!API_KEY || API_KEY.trim() === '') {
  console.error('\n[record-newapi] 缺少 OPENAI_API_KEY。用法: OPENAI_API_KEY=sk-... npm run record:newapi\n');
  process.exit(2);
}

const UPSTREAM_BASE = (process.env.LUCENT_UPSTREAM || process.env.OPENAI_BASE_URL || 'http://new-api:3000/v1').replace(/\/+$/, '');
const MODEL = process.env.LUCENT_MODEL || 'openai/unsloth/Qwen3.6-27B-MTP-GGUF';
const MAX_TOKENS = Number(process.env.LUCENT_MAX_TOKENS || 2048);
const OUT_PATH = process.env.LUCENT_OUT || join(process.cwd(), 'lucent-newapi-demo.webm');
const HEADFUL = !!process.env.LUCENT_HEADFUL;

if (!UPSTREAM_BASE.includes('/v1')) {
  console.error(`[record-newapi] 上游 baseUrl 必须含 /v1（与 proxy 路径拼接逻辑对齐），当前: ${UPSTREAM_BASE}`);
  process.exit(2);
}

// ==================== 隔离环境 ====================

const CONFIG_DIR = mkdtempSync(join(tmpdir(), 'lucent-newapi-record-'));
const VIDEO_DIR = join(CONFIG_DIR, 'video');
mkdirSync(VIDEO_DIR, { recursive: true });
const BASE = 50000 + Math.floor(Math.random() * 4000);
const PROXY_PORT = BASE;
const WEB_PORT = BASE + 1;

// openai 预设供应商：两端点都指 new-api，anthropic 留空（上游不支持）
writeFileSync(join(CONFIG_DIR, 'config.json'), JSON.stringify({
  host: '127.0.0.1',
  proxyPort: PROXY_PORT,
  webPort: WEB_PORT,
  providers: [{
    id: 'p-openai',
    name: 'openai',
    presetName: 'openai',
    endpoints: {
      'openai-chat': UPSTREAM_BASE,
      'openai-responses': UPSTREAM_BASE,
      'anthropic-messages': null,
    },
  }],
}, null, 2));

// ==================== 启动后端（serve dist/ + proxy）====================

// Lucent 是透明代理，本身不需要客户端密钥；从 backend env 剔掉 OPENAI_API_KEY，
// 避免把密钥无谓下发给 Lucent 进程（key 只在驱动侧的 fetch header 里用）
const backendEnv: Record<string, string | undefined> = { ...process.env };
delete backendEnv.OPENAI_API_KEY;

const backend = spawn('npx', ['tsx', 'server/index.ts'], {
  cwd: REPO_ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...backendEnv,
    LUCENT_CONFIG_DIR: CONFIG_DIR,
    LUCENT_HOST: '127.0.0.1',
    LUCENT_PROXY_PORT: String(PROXY_PORT),
    LUCENT_WEB_PORT: String(WEB_PORT),
    LUCENT_LOG_DIR: join(CONFIG_DIR, 'logs'),
  },
});

backend.stdout.on('data', (d: Buffer) => process.stdout.write(`[backend] ${d}`));
backend.stderr.on('data', (d: Buffer) => process.stderr.write(`[backend!] ${d}`));

// ==================== 工具 ====================

const PROXY = `http://127.0.0.1:${PROXY_PORT}`;
const WEB = `http://127.0.0.1:${WEB_PORT}`;
const AUTH = { authorization: `Bearer ${API_KEY}` };

const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
const fired: Array<{ label: string; endpoint: string; ok: boolean; detail: string }> = [];
function check(name: string, cond: any, detail = '') {
  checks.push({ name, ok: !!cond, detail });
  console.log(`  ${cond ? '✓ PASS' : '✗ FAIL'}  ${name}${detail && !cond ? '  →  ' + detail : ''}`);
}

function readLogEntries() {
  const logDir = join(CONFIG_DIR, 'logs');
  if (!readdirSync(logDir).some(f => f.endsWith('.jsonl'))) return [];
  const files = readdirSync(logDir).filter(f => f.endsWith('.jsonl')).sort();
  const content = readFileSync(join(logDir, files[files.length - 1]), 'utf-8');
  return content.split(/\n---\n/).filter(s => s.trim().startsWith('{')).map(s => JSON.parse(s));
}

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
    try { const res = await fetch(url); if (res.status > 0) return; } catch { /* 端口未就绪，重试 */ }
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error(`${label} 端口始终无响应: ${url}`);
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// 发请求穿 Lucent 代理（非流式）
async function postJson(path: string, body: unknown) {
  const res = await fetch(`${PROXY}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...AUTH },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.text() };
}

// 发请求穿 Lucent 代理（流式 SSE，读完整条流让代理落完整日志）
async function postStream(path: string, body: unknown) {
  const res = await fetch(`${PROXY}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...AUTH },
    body: JSON.stringify(body),
  });
  const reader = res.body?.getReader();
  const dec = new TextDecoder();
  let acc = '';
  let frames = 0;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = dec.decode(value, { stream: true });
      acc += chunk;
      frames += (chunk.match(/data":|"type":"|chat\.completion\.chunk/g) || []).length;
    }
  }
  return { status: res.status, body: acc, frames };
}

// ==================== 内容断言（兜住"回没回"，不只看 HTTP 200）====================
//
// 只看 status===200 && body 非空太松：reasoning 模型 max_tokens 给小了会
// finish_reason=length / content 空串（issue 背景点名的故障模式），HTTP 照样 200、
// body 是非空 JSON 壳子。这里每场景加一条内容断言，空答/截断会被抓到。
type Scenario = { label: string; path: string; body: any; stream: boolean; expectEndpoint: string };
type Res = { status: number; body: string; frames?: number };

function evaluateContent(s: Scenario, res: Res): { ok: boolean; detail: string } {
  if (res.status !== 200) return { ok: false, detail: `HTTP ${res.status}（非 200）` };

  // chat 非流式：choices[0].message.content 非空 且 finish_reason !== 'length'
  if (s.expectEndpoint === 'openai-chat' && !s.stream) {
    let j: any; try { j = JSON.parse(res.body); } catch { return { ok: false, detail: '响应非合法 JSON' }; }
    const content = j?.choices?.[0]?.message?.content;
    const finish = j?.choices?.[0]?.finish_reason;
    const ok = typeof content === 'string' && content.trim() !== '' && finish !== 'length';
    return { ok, detail: `finish_reason=${finish} content="${String(content ?? '').slice(0, 40)}"` };
  }

  // responses 非流式：output 里有实际（非 reasoning）内容
  if (s.expectEndpoint === 'openai-responses' && !s.stream) {
    let j: any; try { j = JSON.parse(res.body); } catch { return { ok: false, detail: '响应非合法 JSON' }; }
    const out: any[] = Array.isArray(j?.output) ? j.output : [];
    const msg = out.find((o: any) => o.type === 'message');
    const text = msg?.content?.find((c: any) => c.type === 'output_text')?.text;
    const ok = typeof text === 'string' && text.trim() !== '';
    return { ok, detail: `status=${j?.status ?? '?'} incomplete=${JSON.stringify(j?.incomplete_details)} text="${String(text ?? '').slice(0, 40)}"` };
  }

  // 流式（chat / responses）：frames>0 且至少出现一帧 content delta（不是只有 reasoning）
  if (s.stream) {
    let contentDeltas = 0;
    for (const line of res.body.split('\n')) {
      const m = line.match(/^data:\s*(.*)$/);
      if (!m) continue;
      const raw = m[1].trim();
      if (!raw || raw === '[DONE]') continue;
      let ev: any; try { ev = JSON.parse(raw); } catch { continue; }
      if (s.expectEndpoint === 'openai-chat') {
        const dc = ev?.choices?.[0]?.delta?.content;
        if (typeof dc === 'string' && dc !== '') contentDeltas++;
      } else { // openai-responses
        if (ev?.type === 'response.output_text.delta') contentDeltas++;
      }
    }
    const ok = (res.frames ?? 0) > 0 && contentDeltas >= 1;
    return { ok, detail: `frames=${res.frames ?? 0} contentDeltas=${contentDeltas}` };
  }

  return { ok: false, detail: '未知场景' };
}

let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
let context: Awaited<ReturnType<NonNullable<typeof browser>['newContext']>> | null = null;

try {
  await waitFor(/Web UI:|Proxy:|Lucent/i, 'backend');
  await waitForPort(`${WEB}/`, 'web');
  await sleep(800);

  console.log(`\n========== Lucent × new-api 真实链路录屏 ==========\n`);
  console.log(`  上游:   ${UPSTREAM_BASE}`);
  console.log(`  模型:   ${MODEL}  (max_tokens=${MAX_TOKENS}, reasoning)`);
  console.log(`  代理:   ${PROXY}/openai/v1/...`);
  console.log(`  Web UI: ${WEB}`);
  console.log(`  视频:   → ${OUT_PATH}  (headful=${HEADFUL})\n`);

  // ==================== 起浏览器 + 录屏 ====================
  browser = await chromium.launch({ headless: !HEADFUL });
  context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    recordVideo: { dir: VIDEO_DIR, size: { width: 1440, height: 900 } },
  });
  const page = await context.newPage();

  // 打开 Web UI（深色界面），先空列表
  await page.goto(WEB);
  await sleep(1200);
  const refresh = () => page.locator('[title="刷新"]').first().click().catch(() => page.reload());

  // ==================== 穿代理发 4 个真请求（带间隔，日志逐条进入）====================
  const scenarios = [
    {
      label: 'openai-chat 非流式',
      path: '/openai/v1/chat/completions',
      body: { model: MODEL, max_tokens: MAX_TOKENS, messages: [{ role: 'user', content: '用一句话回答：太平洋是世界上最大的什么？' }] },
      stream: false,
      expectEndpoint: 'openai-chat',
    },
    {
      label: 'openai-chat 流式 SSE',
      path: '/openai/v1/chat/completions',
      body: { model: MODEL, max_tokens: MAX_TOKENS, stream: true, messages: [{ role: 'user', content: '用一句话说一个有趣的事实。' }] },
      stream: true,
      expectEndpoint: 'openai-chat',
    },
    {
      label: 'openai-responses 非流式',
      path: '/openai/v1/responses',
      body: { model: MODEL, max_tokens: MAX_TOKENS, input: '用一句话回答：光的速度大约是多少？' },
      stream: false,
      expectEndpoint: 'openai-responses',
    },
    {
      label: 'openai-responses 流式 SSE',
      path: '/openai/v1/responses',
      body: { model: MODEL, max_tokens: MAX_TOKENS, stream: true, input: '用一句话推荐一种适合新手的编程语言。' },
      stream: true,
      expectEndpoint: 'openai-responses',
    },
  ];

  const firedLocal: Array<{ label: string; endpoint: string; ok: boolean; detail: string }> = [];
  for (const s of scenarios) {
    console.log(`\n▶ ${s.label}  →  ${PROXY}${s.path}`);
    const t0 = Date.now();
    const res = s.stream ? await postStream(s.path, s.body) : await postJson(s.path, s.body);
    const dt = Date.now() - t0;
    const ev = evaluateContent(s, res);   // 内容断言：HTTP 200 但空答/截断会被判 false
    console.log(`  ← HTTP ${res.status}  ${dt}ms  body=${res.body.length}B${s.stream ? ` frames=${(res as any).frames}` : ''}  ${ev.ok ? '✓' : '✗'} ${ev.detail}`);
    check(`内容 ${s.label}: ${s.stream ? '≥1 帧 content delta' : '有实际回答内容（非空、未 length 截断）'}`, ev.ok, ev.detail);
    firedLocal.push({ label: s.label, endpoint: s.expectEndpoint, ok: ev.ok, detail: `HTTP ${res.status} ${dt}ms · ${ev.detail}` });

    await sleep(700);                       // 等日志落盘
    await refresh();                        // 刷新 → 列表新增一行（视频里逐条进入）
    await sleep(1300);
  }
  fired.push(...firedLocal);

  // ==================== 验收：确认穿的是 Lucent 代理（非直连 new-api）====================
  console.log(`\n---------- 全链路验收 ----------\n`);
  const entries = readLogEntries();
  for (const s of scenarios) {
    const hit = entries.filter((e: any) => e.providerName === 'openai' && e.endpointType === s.expectEndpoint);
    check(`日志 ${s.label}: providerName=openai & endpointType=${s.expectEndpoint}`,
      hit.length >= 1, `命中 ${hit.length} 条（应为 ≥1，证明走的是 Lucent 代理而非直连 new-api）`);
  }
  check('请求全部穿过 Lucent 代理（4/4 provider=openai）',
    entries.filter((e: any) => e.providerName === 'openai').length >= 4,
    `provider=openai 的日志共 ${entries.filter((e: any) => e.providerName === 'openai').length} 条`);

  // ==================== 镜头交互：点列表项 + 切 5 个 Tab ====================
  console.log(`\n---------- 录屏交互 ----------\n`);
  await refresh();
  await sleep(800);
  const rowCount = await page.getByTestId('log-row').count();
  console.log(`  日志列表行数: ${rowCount}`);
  check('Web UI 列表渲染 log-row', rowCount >= 4, `rows=${rowCount}`);

  const tabs = ['request', 'response', 'kvcache', 'context', 'meta'] as const;
  const rowsToDemo = Math.min(rowCount, 4);
  for (let i = 0; i < rowsToDemo; i++) {
    const row = page.getByTestId('log-row').nth(i);
    await row.click();
    await sleep(700);
    const url = page.url();
    console.log(`  ▸ 第 ${i + 1} 行已选中: ${url.includes('log=') ? '已定位详情' : url}`);
    for (const t of tabs) {
      await page.getByTestId(`tab-${t}`).click().catch(() => {});
      await sleep(650);
    }
    await sleep(400);
  }

  // 收尾镜头：回到列表全景
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
    console.error('\n[record-newapi] 未拿到 video path，视频可能未生成');
  }

} catch (err: any) {
  console.error(`\n[record-newapi] 失败: ${err?.message || err}`);
  if (context) await context.close().catch(() => {});
  throw err;
} finally {
  if (browser) await browser.close().catch(() => {});
  backend.kill('SIGTERM');
  await sleep(500);
  try { rmSync(CONFIG_DIR, { recursive: true, force: true }); } catch { /* 临时目录，忽略 */ }
}

// ==================== 汇总 ====================
const pass = checks.filter(c => c.ok).length;
const fail = checks.length - pass;
console.log('');
console.log('='.repeat(56));
console.log(`  ${pass}/${checks.length} 验收点通过, ${fail} 失败`);
console.log('='.repeat(56));
if (fail > 0) {
  console.log('\n失败项:');
  checks.filter(c => !c.ok).forEach(c => console.log(`  - ${c.name}${c.detail ? ' (' + c.detail + ')' : ''}`));
}
const firedOk = fired.filter(f => f.ok).length;
console.log(`\n穿代理真请求: ${firedOk}/${fired.length} 成功`);
process.exit(fail === 0 && firedOk === fired.length ? 0 : 1);
