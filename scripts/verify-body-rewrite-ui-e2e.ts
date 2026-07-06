#!/usr/bin/env tsx
/**
 * scripts/verify-body-rewrite-ui-e2e.ts — Body 重写规则 UI/API 端到端验收
 *
 * 覆盖:
 *   Part 1 API CRUD: GET(空) → POST(加) → GET(含) → PUT(改) → POST(非法pattern→400) → DELETE → GET(已删)
 *   Part 2 UI (playwright): 点顶栏「Body 重写规则」按钮 → modal 打开 → 列表渲染 → 试跑预览区存在
 *
 * 隔离: 临时 config + 随机端口，不碰 ~/.lucent
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// ==================== 隔离环境 ====================

const CONFIG_DIR = mkdtempSync(join(tmpdir(), 'lucent-rewrite-ui-verify-'));
const BASE = 50000 + Math.floor(Math.random() * 3000);
const PROXY_PORT = BASE;
const WEB_PORT = BASE + 1;
const VITE_PORT = BASE + 2;

// config 不含 bodyRewrites（测从空开始）；provider 指向不存在的上游（UI/API 测试不转发请求）
writeFileSync(join(CONFIG_DIR, 'config.json'), JSON.stringify({
  host: '127.0.0.1',
  proxyPort: PROXY_PORT,
  webPort: WEB_PORT,
  providers: [{
    id: 'p-hxy', name: 'hxy',
    endpoints: {
      'anthropic-messages': 'http://127.0.0.1:9999/v1',
      'openai-chat': null, 'openai-responses': null,
    },
  }],
}));

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

const vite = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(VITE_PORT), '--strictPort'], {
  cwd: REPO_ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, LUCENT_WEB_PORT: String(WEB_PORT) },
});

// ==================== 工具 ====================

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, cond: any, detail = '') {
  results.push({ name, ok: !!cond, detail });
  console.log(`  ${cond ? '✓ PASS' : '✗ FAIL'}  ${name}${detail && !cond ? '  →  ' + detail : ''}`);
}

async function waitFor(proc: any, regex: RegExp, label: string, timeoutMs = 30000) {
  return new Promise<void>((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(`${label} startup timeout`)), timeoutMs);
    let done = false;
    proc.stdout.on('data', (d: Buffer) => {
      if (!done && regex.test(d.toString())) { done = true; clearTimeout(to); resolve(); }
    });
    proc.on('exit', (c: number) => { if (!done) reject(new Error(`${label} exit ${c}`)); });
  });
}

async function waitForPort(url: string, label: string, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { const res = await fetch(url); if (res.status > 0) return; } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error(`${label} port never accepted: ${url}`);
}

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${WEB_PORT}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* keep null */ }
  return { status: res.status, json };
}

const VITE_URL = `http://127.0.0.1:${VITE_PORT}`;

try {
  await waitFor(backend, /Lucent|代理|listen|启动/i, 'backend');
  await waitFor(vite, /Local:|ready in/i, 'vite');
  await waitForPort(`${VITE_URL}/`, 'vite');
  await new Promise(r => setTimeout(r, 1000));

  console.log(`\n========== Body 重写规则 UI/API 端到端验收 ==========\n`);
  console.log(`  后端: proxy=${PROXY_PORT} web=${WEB_PORT}`);
  console.log(`  vite: ${VITE_PORT}\n`);

  // ============================================================
  // Part 1: API CRUD
  // ============================================================
  console.log('【Part 1: API CRUD】');

  const list1 = await api('GET', '/api/body-rewrites');
  check('API-① GET 初始列表为数组', Array.isArray(list1.json?.bodyRewrites), `status=${list1.status} len=${list1.json?.bodyRewrites?.length}`);

  const createRes = await api('POST', '/api/body-rewrites', {
    name: '测试脱敏', enabled: true,
    fieldPath: 'system[0].text',
    pattern: 'x-anthropic-billing-header:[^;]*;[^;]*;?',
    replacement: '[REDACTED]',
  });
  const ruleId = createRes.json?.id;
  check('API-② POST 新增规则返回 201 + id', createRes.status === 201 && typeof ruleId === 'string', `status=${createRes.status}`);

  const list2 = await api('GET', '/api/body-rewrites');
  check('API-③ 新增后列表含该规则', Array.isArray(list2.json?.bodyRewrites) && list2.json.bodyRewrites.some((r: any) => r.id === ruleId), `len=${list2.json?.bodyRewrites?.length}`);

  const putRes = await api('PUT', `/api/body-rewrites/${ruleId}`, { enabled: false, replacement: '' });
  check('API-④ PUT 更新规则返回 200 + 字段已改',
    putRes.status === 200 && putRes.json?.enabled === false && putRes.json?.replacement === '',
    `status=${putRes.status} enabled=${putRes.json?.enabled}`);

  const badRes = await api('POST', '/api/body-rewrites', { fieldPath: 'system[0].text', pattern: '[unclosed', replacement: '' });
  check('API-⑤ POST 非法 pattern 返回 400 + 错误信息', badRes.status === 400 && typeof badRes.json?.error === 'string', `status=${badRes.status}`);

  const delRes = await api('DELETE', `/api/body-rewrites/${ruleId}`);
  check('API-⑥ DELETE 返回 200 + success', delRes.status === 200 && delRes.json?.success === true, `status=${delRes.status}`);

  const list3 = await api('GET', '/api/body-rewrites');
  check('API-⑦ 删除后列表不含该规则', !((list3.json?.bodyRewrites ?? []).some((r: any) => r.id === ruleId)), `len=${list3.json?.bodyRewrites?.length}`);

  // ============================================================
  // Part 2: UI（playwright）
  // ============================================================
  console.log('\n【Part 2: UI modal（playwright）】');

  // 先加一条规则供 UI 显示
  await api('POST', '/api/body-rewrites', {
    name: 'UI 测试规则', enabled: true,
    fieldPath: 'system[0].text', pattern: 'cc_version=[^;]+', replacement: '[V]',
  });

  {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(VITE_URL);
    await page.waitForTimeout(1000);

    // 点顶栏 Body 重写按钮
    const btn = page.getByTitle('Body 重写规则');
    await btn.click();
    await page.waitForTimeout(600);
    // 等规则 input 渲染（fieldPath 输入框），防异步未加载
    await page.waitForSelector('input', { timeout: 5000 }).catch(() => {});

    const bodyText = (await page.textContent('body')) || '';
    check('UI-① 点击顶栏按钮打开 modal（含标题）', bodyText.includes('Body 重写规则'), `含标题=${bodyText.includes('Body 重写规则')}`);
    // fieldPath 是 <Input> 的 value（不在 textContent），用 inputValue 检查规则数据已加载到表单
    const inputs = page.locator('input');
    const inputCount = await inputs.count();
    let hasFieldValue = false;
    for (let i = 0; i < inputCount; i++) {
      const v = await inputs.nth(i).inputValue().catch(() => '');
      if (v.includes('system[0].text')) { hasFieldValue = true; break; }
    }
    check('UI-② modal 渲染规则列表（fieldPath input 含 system[0].text）',
      hasFieldValue, `inputCount=${inputCount} hasFieldValue=${hasFieldValue}`);
    check('UI-③ 试跑预览区渲染（含"样例"或"试跑"提示）',
      bodyText.includes('样例') || bodyText.includes('试跑'),
      `含试跑提示=${bodyText.includes('样例') || bodyText.includes('试跑')}`);

    await browser.close();
  }

} finally {
  backend.kill('SIGTERM');
  vite.kill('SIGTERM');
  await new Promise(r => setTimeout(r, 500));
  try { rmSync(CONFIG_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
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
