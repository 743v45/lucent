/**
 * 日志记录模式三态开关 UI spec（off / temporary / archive + TTL）
 *
 * 复用 e2e/fixtures.ts 隔离栈（真实后端 + vite dev + mock 上游）。覆盖：
 *   - 默认 archive：Segmented 选中「存档」，写入行 expiresAt 为空
 *   - 切 off：发请求不落库（beta 计数不变），Segmented 选中「只过路」
 *   - 切 temporary：TTL InputNumber 出现，写入行 expiresAt 非空
 *   - 改 TTL InputNumber → /api/status tempLogTtlMinutes 持久化更新
 *   - env 锁定：logModeEnvLocked=true 时 Segmented 内 input 禁用
 *
 * 隔离：worker 共享后端，用专属 provider=beta + 前后计数对比，不假定空库。
 */
import { test, expect, type LucentStack } from './fixtures';
import type { Page } from '@playwright/test';

const OAI_HEADERS = { authorization: 'Bearer sk-mock-ui-e2e' };
const PROVIDER = 'beta';

/** 发一条 openai-chat 请求穿过代理，落到 beta 名下。 */
async function sendChat(lucent: LucentStack, content: string): Promise<void> {
  lucent.upstream.setMode('chat-json');
  await lucent.postThroughProxy(`/${PROVIDER}/v1/chat/completions`, OAI_HEADERS, {
    model: 'gpt-4o',
    max_tokens: 1,
    messages: [{ role: 'user', content }],
  });
}

/** beta 已落库条数（只有本文件造 beta，故计数确定）。 */
async function betaCount(lucent: LucentStack): Promise<number> {
  return (await lucent.readLogEntries()).filter((l) => l.providerName === PROVIDER).length;
}

/** beta 最新一条（/api/logs 按 timestamp DESC，首条最新）。 */
async function latestBeta(lucent: LucentStack): Promise<Record<string, unknown> | undefined> {
  return (await lucent.readLogEntries()).find((l) => l.providerName === PROVIDER);
}

/** 经 /api/recording 设置模式（走 vite 代理到后端）。 */
async function setMode(page: Page, webBaseUrl: string, mode: 'off' | 'temporary' | 'archive'): Promise<void> {
  await page.request.post(`${webBaseUrl}/api/recording`, { data: { logMode: mode } });
}

/** 点 Segmented 某档（按 label 文本匹配 ant-segmented-item）。 */
async function pickMode(page: Page, label: string): Promise<void> {
  await page.getByTestId('log-mode-toggle').locator('.ant-segmented-item', { hasText: label }).click();
}

/** Segmented 当前选中档的文本。 */
async function selectedModeText(page: Page): Promise<string> {
  const el = page.getByTestId('log-mode-toggle').locator('.ant-segmented-item-selected');
  return (await el.textContent()) ?? '';
}

test.describe('日志记录模式三态开关', () => {
  test.beforeEach(async ({ page, lucent }) => {
    await setMode(page, lucent.webBaseUrl, 'archive');
    await page.goto(lucent.webBaseUrl);
    await expect(page.getByTestId('log-mode-toggle')).toBeVisible();
  });

  test('存档：Segmented 选中「存档」，写入行 expiresAt 为空', async ({ page, lucent }) => {
    expect(await selectedModeText(page)).toContain('存档');
    const before = await betaCount(lucent);
    await sendChat(lucent, 'LMT-ARCHIVE');
    await expect.poll(() => betaCount(lucent), { timeout: 5000 }).toBe(before + 1);
    const latest = await latestBeta(lucent);
    expect(latest?.expiresAt).toBeFalsy(); // 存档：无到期时间
  });

  test('切 off：发请求不落库（beta 计数不变），选中「只过路」', async ({ page, lucent }) => {
    await pickMode(page, '只过路');
    expect(await selectedModeText(page)).toContain('只过路');
    const before = await betaCount(lucent);
    await sendChat(lucent, 'LMT-OFF');
    await page.waitForTimeout(800); // 等异步写入队列（off 应无新增）
    expect(await betaCount(lucent)).toBe(before);
  });

  test('切 temporary：TTL InputNumber 出现，写入行 expiresAt 非空', async ({ page, lucent }) => {
    await pickMode(page, '临时');
    expect(await selectedModeText(page)).toContain('临时');
    await expect(page.getByTestId('temp-ttl-input')).toBeVisible();
    const before = await betaCount(lucent);
    await sendChat(lucent, 'LMT-TEMP');
    await expect.poll(() => betaCount(lucent), { timeout: 5000 }).toBe(before + 1);
    const latest = await latestBeta(lucent);
    expect(typeof latest?.expiresAt).toBe('string');
    expect((latest?.expiresAt as string).length).toBeGreaterThan(0);
  });

  test('改 TTL InputNumber → status 持久化 + 写入 expiresAt 反映新 TTL', async ({ page, lucent }) => {
    await pickMode(page, '临时');
    // antd InputNumber 把 data-testid 透传到 input 自身，用 role=spinbutton 定位（页面唯一）
    const input = page.getByRole('spinbutton');
    await expect(input).toBeVisible();
    await input.fill('7');
    await input.press('Tab'); // blur 触发 onChange 持久化
    await expect.poll(
      async () => (await page.request.get(`${lucent.webBaseUrl}/api/status`).then((r) => r.json()) as { tempLogTtlMinutes?: number }).tempLogTtlMinutes,
      { timeout: 5000 },
    ).toBe(7);
    // 回归断言：改 TTL=7 后写入的临时日志 expiresAt 应 ≈7 分钟（而非默认 30）。
    // writeLogEntry 必须用实时 getter，不能用启动快照 resolvedConfig——否则此处 FAIL。
    await sendChat(lucent, 'LMT-TTL7');
    await expect.poll(() => betaCount(lucent), { timeout: 5000 }).toBeGreaterThanOrEqual(1);
    const expiresAt = (await latestBeta(lucent))?.expiresAt as string | undefined;
    expect(expiresAt).toBeTruthy();
    const deltaMin = (Date.parse(expiresAt!) - Date.now()) / 60000;
    expect(deltaMin).toBeGreaterThanOrEqual(5); // 容差下界（异步写入延迟）
    expect(deltaMin).toBeLessThanOrEqual(9); // 30 分钟会明显超出 → 抓到 resolvedConfig 快照 bug
  });

  test('env 锁定：logModeEnvLocked=true 时 Segmented input 禁用', async ({ page, lucent }) => {
    // mock /api/status 返回锁定态（仅测 UI 渲染，不改真后端模式）
    await page.route('**/api/status', async (route) => {
      const real = await route.fetch();
      const json = await real.json();
      await route.fulfill({ json: { ...json, logModeEnvLocked: true } });
    });
    await page.reload();
    await expect(page.getByTestId('log-mode-toggle').locator('input').first()).toBeDisabled();
  });

  test('立即清空临时：删所有 expiresAt 非空行（存档保留）', async ({ page, lucent }) => {
    await pickMode(page, '临时');
    await sendChat(lucent, 'LMT-PURGE');
    await expect.poll(
      async () => (await lucent.readLogEntries()).filter((l) => l.providerName === PROVIDER && l.expiresAt).length,
      { timeout: 5000 },
    ).toBeGreaterThanOrEqual(1);
    await page.getByTestId('purge-temporary-btn').click();
    await expect.poll(
      async () => (await lucent.readLogEntries()).filter((l) => l.providerName === PROVIDER && l.expiresAt).length,
      { timeout: 5000 },
    ).toBe(0);
  });

  test('仅存档过滤：切换后前端隐藏临时行', async ({ page, lucent }) => {
    await sendChat(lucent, 'LMT-ARCHIVE-FILTER'); // 存档（beforeEach 已 archive）
    await pickMode(page, '临时');
    await sendChat(lucent, 'LMT-TEMP-FILTER'); // 临时
    await expect.poll(
      async () => (await lucent.readLogEntries()).filter((l) => l.providerName === PROVIDER && l.expiresAt).length,
      { timeout: 5000 },
    ).toBeGreaterThanOrEqual(1);
    await page.reload(); // 前端无自动刷新，手动拉一次新数据
    await expect(page.getByTestId('archive-only-switch')).toBeVisible();
    const tempRows = page.locator('[data-testid="log-row"]').filter({ hasText: '临时' });
    await expect.poll(async () => tempRows.count(), { timeout: 5000 }).toBeGreaterThanOrEqual(1);
    await page.getByTestId('archive-only-switch').click();
    await expect(tempRows).toHaveCount(0);
  });
});
