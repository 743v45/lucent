/**
 * 日志记录模式 UI spec（[📂 当前态 ▾] 一个 Popover：Radio 三态选模式 + 两时长常驻可改 + 清临时）
 *
 * - 顶栏一个按钮（显示当前态），点开 Popover
 * - Popover 内：纵向 Radio 三态（选模式）+ 分隔线 + 两时长常驻（临时存活时长 / 存档保留期，无需选中即可改）+ 清临时
 * - 选模式（Radio）即时提交；改时长（InputNumber）仅本地，**关闭 Popover 时**统一提交
 *
 * 覆盖：存档默认 / off 不落库 / 临时 expiresAt 非空 / 改 TTL 关闭后写入反映新值 / env 锁定 /
 * 立即清空临时 / 仅存档过滤。
 */
import { test, expect, type LucentStack } from './fixtures';
import type { Page } from '@playwright/test';

const OAI_HEADERS = { authorization: 'Bearer sk-mock-ui-e2e' };
const PROVIDER = 'beta';

async function sendChat(lucent: LucentStack, content: string): Promise<void> {
  lucent.upstream.setMode('chat-json');
  await lucent.postThroughProxy(`/${PROVIDER}/v1/chat/completions`, OAI_HEADERS, {
    model: 'gpt-4o',
    max_tokens: 1,
    messages: [{ role: 'user', content }],
  });
}

async function betaCount(lucent: LucentStack): Promise<number> {
  return (await lucent.readLogEntries()).filter((l) => l.providerName === PROVIDER).length;
}

async function latestBeta(lucent: LucentStack): Promise<Record<string, unknown> | undefined> {
  return (await lucent.readLogEntries()).find((l) => l.providerName === PROVIDER);
}

async function setMode(page: Page, webBaseUrl: string, mode: 'off' | 'temporary' | 'archive'): Promise<void> {
  await page.request.post(`${webBaseUrl}/api/recording`, { data: { logMode: mode } });
}

/** 点顶栏 [📂] 按钮开 Popover。 */
async function openPopover(page: Page): Promise<void> {
  await page.getByTestId('log-mode-btn').click();
}

/** 开 Popover 并点某态的 Radio。Popover 保持开（点 content 内不关）。 */
async function pickMode(page: Page, mode: 'off' | 'temporary' | 'archive'): Promise<void> {
  await openPopover(page);
  await page.getByTestId(`mode-${mode}`).click();
}

/** 关闭 Popover（触发 onOpenChange(false) → 统一提交时长）。 */
async function closePopover(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
}

async function modeBtnText(page: Page): Promise<string> {
  return (await page.getByTestId('log-mode-btn').textContent()) ?? '';
}

test.describe('日志记录模式（[📂] Popover：Radio 选 + 两时长常驻配置）', () => {
  test.beforeEach(async ({ page, lucent }) => {
    await setMode(page, lucent.webBaseUrl, 'archive');
    await page.goto(lucent.webBaseUrl);
    await expect(page.getByTestId('log-mode-btn')).toBeVisible();
  });

  test('存档：默认态，写入 expiresAt 空', async ({ page, lucent }) => {
    expect(await modeBtnText(page)).toContain('存档');
    const before = await betaCount(lucent);
    await sendChat(lucent, 'LMT-ARCHIVE');
    await expect.poll(() => betaCount(lucent), { timeout: 5000 }).toBe(before + 1);
    expect((await latestBeta(lucent))?.expiresAt).toBeFalsy();
  });

  test('切 off：发请求不落库', async ({ page, lucent }) => {
    await pickMode(page, 'off');
    expect(await modeBtnText(page)).toContain('过路');
    const before = await betaCount(lucent);
    await sendChat(lucent, 'LMT-OFF');
    await page.waitForTimeout(800);
    expect(await betaCount(lucent)).toBe(before);
  });

  test('切 temporary：两时长常驻可见，写入 expiresAt 非空', async ({ page, lucent }) => {
    await pickMode(page, 'temporary');
    expect(await modeBtnText(page)).toContain('临时');
    await expect(page.getByTestId('temp-ttl-input')).toBeVisible();
    await expect(page.getByTestId('retention-input')).toBeVisible(); // 常驻，不管当前模式
    const before = await betaCount(lucent);
    await sendChat(lucent, 'LMT-TEMP');
    await expect.poll(() => betaCount(lucent), { timeout: 5000 }).toBe(before + 1);
    const latest = await latestBeta(lucent);
    expect(typeof latest?.expiresAt).toBe('string');
    expect((latest?.expiresAt as string).length).toBeGreaterThan(0);
  });

  test('改 TTL 关闭 Popover 后 → status 持久化 + 写入 expiresAt 反映新 TTL', async ({ page, lucent }) => {
    await pickMode(page, 'temporary');
    const input = page.getByTestId('temp-ttl-input');
    await expect(input).toBeVisible();
    await input.fill('7');
    // 改时长不立即提交——必须关闭 Popover 才提交
    const st0 = await page.request.get(`${lucent.webBaseUrl}/api/status`).then((r) => r.json()) as { tempLogTtlMinutes?: number };
    expect(st0.tempLogTtlMinutes).not.toBe(7);
    await closePopover(page); // 关闭 → 统一提交
    await expect.poll(
      async () => (await page.request.get(`${lucent.webBaseUrl}/api/status`).then((r) => r.json()) as { tempLogTtlMinutes?: number }).tempLogTtlMinutes,
      { timeout: 5000 },
    ).toBe(7);
    await sendChat(lucent, 'LMT-TTL7');
    await expect.poll(() => betaCount(lucent), { timeout: 5000 }).toBeGreaterThanOrEqual(1);
    const expiresAt = (await latestBeta(lucent))?.expiresAt as string | undefined;
    expect(expiresAt).toBeTruthy();
    const deltaMin = (Date.parse(expiresAt!) - Date.now()) / 60000;
    expect(deltaMin).toBeGreaterThanOrEqual(5);
    expect(deltaMin).toBeLessThanOrEqual(9);
  });

  test('env 锁定：顶栏按钮 disabled', async ({ page }) => {
    await page.route('**/api/status', async (route) => {
      const real = await route.fetch();
      const json = await real.json();
      await route.fulfill({ json: { ...json, logModeEnvLocked: true } });
    });
    await page.reload();
    await expect(page.getByTestId('log-mode-btn')).toBeDisabled();
  });

  test('仅存档过滤：切换后前端隐藏临时行', async ({ page, lucent }) => {
    await sendChat(lucent, 'LMT-ARCHIVE-FILTER');
    await pickMode(page, 'temporary');
    await sendChat(lucent, 'LMT-TEMP-FILTER');
    await expect.poll(
      async () => (await lucent.readLogEntries()).filter((l) => l.providerName === PROVIDER && l.expiresAt).length,
      { timeout: 5000 },
    ).toBeGreaterThanOrEqual(1);
    await page.reload();
    await expect(page.getByTestId('archive-only-switch')).toBeVisible();
    const tempRows = page.locator('[data-testid="log-row"]').filter({ hasText: '临时' });
    await expect.poll(async () => tempRows.count(), { timeout: 5000 }).toBeGreaterThanOrEqual(1);
    await page.getByTestId('archive-only-switch').click();
    await expect(tempRows).toHaveCount(0);
  });
});
