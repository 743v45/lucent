#!/usr/bin/env tsx
/**
 * scripts/verify-settings-ui.ts — 供应商设置 SettingsModal 全流程 UI 验收
 *
 * 对应 issue TAE-51「供应商设置」。
 * 实跑页面驱动真实 SettingsModal：预设添加 / 自定义新增 / 端点编辑+失焦自动保存 /
 * URL 校验 / 测试连接成功+失败 / 删除二次确认，并校验落盘 config.json 无 key 明文。
 * 隔离：临时 config 目录 + 随机端口 + mock 上游，不碰 ~/.lucent。
 *
 * 用法：npx tsx scripts/verify-settings-ui.ts
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createMockUpstream } from '../tests/e2e-helpers.js';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SHOTS_DIR = join(REPO_ROOT, 'shots-settings');
mkdirSync(SHOTS_DIR, { recursive: true });

// ==================== 隔离环境 ====================
const CONFIG_DIR = mkdtempSync(join(tmpdir(), 'lucent-settings-ui-'));
const BASE = 62000 + Math.floor(Math.random() * 2000);
const PROXY_PORT = BASE;
const WEB_PORT = BASE + 1;
const VITE_PORT = BASE + 2;

// 只放一个 anthropic 种子（与真实首次启动一致）
writeFileSync(join(CONFIG_DIR, 'config.json'), JSON.stringify({
  host: '127.0.0.1',
  proxyPort: PROXY_PORT,
  webPort: WEB_PORT,
  providers: [
    { id: 'seed-anthropic', name: 'anthropic',
      endpoints: { 'openai-chat': null, 'openai-responses': null,
        'anthropic-messages': 'https://api.anthropic.com/v1' } },
  ],
}));

// ==================== mock 上游（测试连接成功用）====================
const upstream = await createMockUpstream({ name: 'settings-ui', format: 'auto' });
const UPSTREAM_BASE = `http://127.0.0.1:${upstream.port}/v1`;
const DEAD_BASE = 'http://127.0.0.1:9/v1'; // 死端口 → 测试连接失败

// ==================== 后端 + vite ====================
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

// ==================== 断言工具 ====================
const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, cond: any, detail = '') {
  results.push({ name, ok: !!cond, detail });
  console.log(`  ${cond ? '✓ PASS' : '✗ FAIL'}  ${name}${cond || !detail ? '' : '  →  ' + detail}`);
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
    try { const r = await fetch(url); if (r.status > 0) return; } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error(`${label} port never accepted`);
}

function shot(page: any, name: string) { return page.screenshot({ path: join(SHOTS_DIR, `${name}.png`) }); }
function readConfig(): any { return JSON.parse(readFileSync(join(CONFIG_DIR, 'config.json'), 'utf-8')); }

// ==================== 主流程 ====================
async function main() {
  await waitFor(backend, /Lucent|代理|listen|启动|ready/i, 'backend');
  await waitFor(vite, /Local:|ready in/i, 'vite');
  await waitForPort(`http://127.0.0.1:${VITE_PORT}/`, 'vite');

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  await page.goto(`http://127.0.0.1:${VITE_PORT}/`);
  await page.waitForTimeout(500);

  page.on('console', () => {});
  // antd message 出现在 .ant-message portal；用 evaluate 取文本（避免 auto-wait 挂起）
  const lastMsg = async () => {
    await page.waitForTimeout(450);
    return await page.evaluate(() => {
      const nodes = Array.from(document.querySelectorAll('[class*="message"]'));
      const txts = nodes.map(n => (n.textContent || '').trim()).filter(Boolean);
      return txts.sort((a, b) => b.length - a.length)[0] || '';
    });
  };

  // 打开设置 Modal
  await page.locator('button[title="配置"]').click();
  await page.waitForTimeout(400);
  await shot(page, '01-settings-open');
  const titleVisible = await page.getByText('供应商配置').first().isVisible();
  check('打开供应商配置 Modal', titleVisible);

  // --- 预设网格 ---
  await page.getByRole('button', { name: /新增供应商/ }).click();
  await page.waitForTimeout(300);
  await shot(page, '02-preset-grid');
  const modal = () => page.locator('.ant-modal');
  const hasCats = await page.evaluate(() => {
    const t = document.querySelector('.ant-modal')?.textContent || '';
    return t.includes('官方') && t.includes('社区');
  });
  check('预设网格：official/community 分类', hasCats);

  // anthropic 已存在（种子）→ 在预设面板里仍可见（已添加置灰）
  const presetPanelHasAnthropic = await page.evaluate(() => (document.querySelector('.ant-modal')?.textContent || '').includes('Anthropic'));
  check('预设网格：已添加的 anthropic 在面板可见', presetPanelHasAnthropic);

  // 添加 openai 预设（点 preset 单元格 div，避免命中 svg <title>）
  await modal().locator('.cursor-pointer', { hasText: 'OpenAI' }).first().click();
  await page.waitForTimeout(400);
  await shot(page, '03-preset-added-openai');
  const cfg1 = readConfig();
  const openaiAdded = cfg1.providers.some((p: any) => p.name === 'openai' && p.presetName === 'openai');
  check('添加 openai 预设落盘', openaiAdded, JSON.stringify(cfg1.providers.map((p: any) => p.name)));

  // 回到预设面板确认 openai 已置灰（cursor-default + 勾）
  await page.getByRole('button', { name: /新增供应商/ }).click();
  await page.waitForTimeout(400);
  await shot(page, '04-preset-openai-greyed');
  // 再次点击 openai 应无反应（已置灰 onClick=undefined）—— 确认数量不变
  const beforeCount = readConfig().providers.length;
  await modal().locator('div', { hasText: 'OpenAI' }).first().click().catch(() => {});
  await page.waitForTimeout(300);
  const afterCount = readConfig().providers.length;
  check('重复添加已存在预设：不重复创建', beforeCount === afterCount, `before=${beforeCount} after=${afterCount}`);

  // --- 自定义新增：合法名 ---
  await page.getByRole('button', { name: /自定义供应商/ }).click();
  await page.waitForTimeout(200);
  await page.locator('input[placeholder="输入自定义名称"]').fill('mytest');
  await page.locator('input[placeholder="输入自定义名称"]').press('Enter');
  await page.waitForTimeout(400);
  await shot(page, '05-custom-created');
  const cfg2 = readConfig();
  const customAdded = cfg2.providers.some((p: any) => p.name === 'mytest' && p.presetName === undefined);
  check('自定义新增合法名 mytest 落盘（无 presetName）', customAdded);

  // --- 自定义新增：非法名（含空格+特殊字符）---
  await page.getByRole('button', { name: /新增供应商/ }).click();
  await page.waitForTimeout(200);
  // showCustomInput 在上一次创建后可能仍为 true（输入框已展开），点不到 dashed 按钮就当已展开
  const dashedCustom = page.getByRole('button', { name: /自定义供应商/ });
  if (await dashedCustom.isVisible().catch(() => false)) await dashedCustom.click();
  await page.waitForTimeout(200);
  const ci = page.locator('input[placeholder="输入自定义名称"]').first();
  await ci.fill('bad name!');
  await ci.press('Enter');
  const illegalMsg = await lastMsg();
  await shot(page, '06-custom-illegal-name');
  check('非法名报错（前端拦截）', /格式错误|只允许/.test(illegalMsg), `msg="${illegalMsg}"`);
  const illegalNotAdded = !readConfig().providers.some((p: any) => p.name === 'bad name!');
  check('非法名未落盘', illegalNotAdded);

  // --- 自定义新增：系统保留名 ---
  await page.locator('input[placeholder="输入自定义名称"]').fill('openai');
  await page.locator('input[placeholder="输入自定义名称"]').press('Enter');
  const reservedMsg = await lastMsg();
  await shot(page, '07-custom-reserved-name');
  check('保留名报错（前端拦截）', /保留名/.test(reservedMsg), `msg="${reservedMsg}"`);

  // --- 自定义新增：重复名 ---
  await page.locator('input[placeholder="输入自定义名称"]').fill('mytest');
  await page.locator('input[placeholder="输入自定义名称"]').press('Enter');
  const dupMsg = await lastMsg();
  await shot(page, '08-custom-duplicate-name');
  check('重复名报错（前端拦截）', /已被占用/.test(dupMsg), `msg="${dupMsg}"`);

  // 关掉预设面板，回到列表（ArrowLeftOutlined 图标 aria-label=arrow-left）
  await page.locator('[aria-label="arrow-left"]').first().click().catch(async () => {
    // 兜底：点 modal 右上角关闭后重开（onClose 会 reset expanded）
    await page.locator('.ant-modal-close').first().click().catch(() => {});
    await page.waitForTimeout(200);
    await page.locator('button[title="配置"]').click();
  });
  await page.waitForTimeout(300);
  await shot(page, '08b-back-to-list');
  // 展开 mytest 卡片编辑端点
  await page.getByText('mytest', { exact: true }).first().click();
  await page.waitForTimeout(400);
  await shot(page, '09-custom-expanded');

  // --- 端点编辑：合法 URL + 失焦自动保存 ---
  // 端点 input：val=null 时 placeholder='不支持（留空）'，有值时='输入上游 URL'。
  // ENDPOINT_TYPES 顺序：[anthropic-messages=0, openai-chat=1, openai-responses=2]，取 openai-chat(nth1)
  const ocInput = () => page.locator('.ant-modal input[placeholder="不支持（留空）"], .ant-modal input[placeholder="输入上游 URL"]').nth(1);
  await ocInput().fill(UPSTREAM_BASE);
  await ocInput().press('Tab'); // 失焦触发自动保存
  await page.waitForTimeout(500);
  await shot(page, '10-endpoint-autosave');
  const cfg3 = readConfig();
  const savedChat = cfg3.providers.find((p: any) => p.name === 'mytest').endpoints['openai-chat'];
  check('端点合法 URL 失焦自动保存落盘（openai-chat）', savedChat === UPSTREAM_BASE, `saved="${savedChat}"`);

  // --- 端点编辑：非法 URL → 不保存 + 提示 + 红框 ---
  await ocInput().fill('not a url');
  await ocInput().press('Tab');
  const badUrlMsg = await lastMsg();
  await page.waitForTimeout(200);
  await shot(page, '11-endpoint-invalid-url');
  const cfg4 = readConfig();
  const notSaved = cfg4.providers.find((p: any) => p.name === 'mytest').endpoints['openai-chat'];
  check('非法 URL 未保存（保持上一个合法值）+提示', notSaved === UPSTREAM_BASE && /URL 格式无效|未保存/.test(badUrlMsg),
    `saved="${notSaved}" msg="${badUrlMsg}"`);

  // 还原成合法 URL（重新填回，准备测试连接）
  await ocInput().fill(UPSTREAM_BASE);
  await ocInput().press('Tab');
  await page.waitForTimeout(400);

  // --- 测试连接：成功（mock 上游 openai-chat → /chat/completions 200）---
  upstream.reset(); upstream.setMode('json');
  await page.waitForTimeout(200);
  await page.locator('.ant-modal').locator('button', { hasText: /测\s*试/ }).first().click();
  await page.waitForTimeout(1500);
  const successMsg = await lastMsg();
  await shot(page, '12-test-connection-success');
  check('测试连接成功（显示 duration）', /连接正常|ms/.test(successMsg), `msg="${successMsg}"`);

  // --- 测试连接：失败（指向死端口 → ECONNREFUSED）---
  await ocInput().fill(DEAD_BASE);
  await ocInput().press('Tab');
  await page.waitForTimeout(400);
  await page.locator('.ant-modal').locator('button', { hasText: /测\s*试/ }).first().click();
  await page.waitForTimeout(3000);
  await shot(page, '13-test-connection-fail');
  // 失败时结果展示在行内（exclamation + 文字），也可能弹 warning message
  const failTexts = await page.evaluate(() => Array.from(document.querySelectorAll('[class*="message"], .ant-modal span')).map(e => (e.textContent || '').trim()).filter(Boolean));
  const failHit = failTexts.some(t => /连接失败|连接超时|ECONNREFUSED|fetch failed|failed/i.test(t));
  check('测试连接失败显示错误信息', failHit, `texts sample="${failTexts.slice(0, 3).join(' | ')}"`);

  // --- 测试连接：401（端点可达但未授权）—— Lucent 无 key，<500 视为可达，是设计行为 ---
  await ocInput().fill(UPSTREAM_BASE);
  await ocInput().press('Tab');
  await page.waitForTimeout(300);
  upstream.reset(); upstream.setMode('error-401');
  await page.locator('.ant-modal').locator('button', { hasText: /测\s*试/ }).first().click();
  await page.waitForTimeout(1500);
  await shot(page, '13b-test-connection-401');
  const msg401 = await lastMsg();
  // 401<500 → ok:true → 「端点可达 / 连接正常」；这是 keyless 代理的设计（真实鉴权由客户端带 key 走代理验）
  check('测试连接 401 → 端点可达（keyless 设计，<500 视为可达）', /连接正常|端点可达|ms/.test(msg401), `msg="${msg401}"`);

  // --- 删除：二次确认（定位 mytest 卡片的删除按钮）---
  await ocInput().fill(UPSTREAM_BASE); // 还原，避免脏数据
  await ocInput().press('Tab');
  await page.waitForTimeout(300);
  const mytestCard = page.locator('.ant-modal').locator('.cursor-pointer', { hasText: 'mytest' }).first();
  const delBtn = mytestCard.locator('[aria-label="delete"]');
  const dialogPromise = page.waitForEvent('dialog', { timeout: 3000 }).catch(() => null);
  await delBtn.first().click().catch(async () => {
    // 兜底：mytest 卡片里任意 danger/delete 图标
    await mytestCard.locator('.anticon-delete, [aria-label="delete"]').first().click().catch(() => {});
  });
  const dialog: any = await dialogPromise;
  const confirmText = dialog ? dialog.message() : '';
  check('删除弹出二次确认（window.confirm）', !!dialog && /删除|确定/.test(confirmText), `dialog="${confirmText}"`);
  if (dialog) await dialog.accept();
  await page.waitForTimeout(500);
  await shot(page, '14-after-delete');
  // mytest 被删了；剩下 anthropic + openai
  const cfg5 = readConfig();
  const deleted = !cfg5.providers.some((p: any) => p.name === 'mytest');
  check('删除后列表即时更新（mytest 移除）', deleted, JSON.stringify(cfg5.providers.map((p: any) => p.name)));

  // --- 落盘安全：config.json 无 key 明文 ---
  const rawConfig = readFileSync(join(CONFIG_DIR, 'config.json'), 'utf-8');
  const hasKey = /\b(sk-[A-Za-z0-9]{10,}|api[_-]?key|x-api-key|authorization)\b/i.test(rawConfig);
  check('落盘 config.json 无 key 明文（安全硬性）', !hasKey, rawConfig.slice(0, 200));
  await shot(page, '15-final');

  await browser.close();

  // ==================== 汇总 ====================
  const passed = results.filter(r => r.ok).length;
  console.log('\n========================================================');
  console.log(`  ${passed}/${results.length} 通过, ${results.length - passed} 失败`);
  console.log('========================================================');
  if (results.length - passed > 0) {
    console.log('\n失败项:');
    results.filter(r => !r.ok).forEach(r => console.log(`  - ${r.name}${r.detail ? ' (' + r.detail + ')' : ''}`));
  }
  return results.length - passed === 0 ? 0 : 1;
}

main()
  .then((code) => {
    // 清理子进程
    try { backend.kill('SIGTERM'); } catch { /* ignore */ }
    try { vite.kill('SIGTERM'); } catch { /* ignore */ }
    try { upstream.close?.(); } catch { /* ignore */ }
    try { rmSync(CONFIG_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
    process.exit(code);
  })
  .catch((e) => {
    console.error('verify-settings-ui 崩溃:', e);
    try { backend.kill('SIGTERM'); } catch { /* ignore */ }
    try { vite.kill('SIGTERM'); } catch { /* ignore */ }
    try { rmSync(CONFIG_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
    process.exit(2);
  });
