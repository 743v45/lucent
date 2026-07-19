/**
 * 定时自动刷新 e2e
 *
 * 覆盖 design doc §8 验收 1-5：默认 off、选 5s 自动刷新出新日志、记忆、手动刷新不受影响。
 * hidden 暂停（验收 7）e2e 难模拟（黑盒看不到 setInterval 在 hidden 时是否跳过），归手动验证。
 * parseRefreshInterval 纯函数（验收 6）由 tests/auto-refresh.test.ts 单测覆盖。
 *
 * 共享 worker 后端：每个 test 起手 lucent.clearLogs() 隔离，避免历史日志污染计数断言。
 */
import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

const OAI_HEADERS = { authorization: 'Bearer sk-mock-auto-refresh' };
const REQ_BODY = {
  model: 'gpt-4o',
  max_tokens: 1,
  messages: [{ role: 'user', content: 'ping' }],
};

/** Select 触发器当前选中项的文字（antd v6 选中值在 .ant-select-content 文本节点） */
const intervalLabel = (page: Page) =>
  page.locator('[data-testid="refresh-interval-select"] .ant-select-content');

/** 打开下拉并点指定选项（label 如 '5秒'；Select 已设 virtual={false} 全量渲染可点） */
async function pickInterval(page: Page, label: string) {
  await page.locator('[data-testid="refresh-interval-select"] .ant-select-content').click();
  await page.getByRole('option', { name: label }).click();
}

test.describe('定时自动刷新', () => {
  test('默认 off，Select 显示"关闭"', async ({ page, lucent }) => {
    lucent.upstream.reset();
    await lucent.clearLogs();
    await page.goto(lucent.webBaseUrl);
    await expect(page.getByTestId('refresh-interval-select')).toBeVisible();
    await expect(intervalLabel(page)).toHaveText('关闭');
  });

  test('选 5s：发请求不手动刷新，列表自动出现新行', async ({ page, lucent }) => {
    lucent.upstream.reset();
    lucent.upstream.setMode('chat-sse');
    await lucent.clearLogs();
    await page.goto(lucent.webBaseUrl);
    await expect(page.getByTestId('log-row')).toHaveCount(0);

    await pickInterval(page, '5秒');
    await expect(intervalLabel(page)).toHaveText('5秒');

    // 直接穿代理发请求（不经 UI），前端未手动刷新
    const res = await lucent.postThroughProxy('/openai/v1/chat/completions', OAI_HEADERS, REQ_BODY);
    expect(res.status, `代理应回 200，实际 ${res.status}`).toBe(200);

    // 自动刷新第一次 tick 在 ~5s 后拉到新日志；全程不点 refresh-btn
    await expect(page.getByTestId('log-row')).toHaveCount(1, { timeout: 12_000 });
  });

  test('记忆：reload 后 Select 仍显示上次选择', async ({ page, lucent }) => {
    await lucent.clearLogs();
    await page.goto(lucent.webBaseUrl);
    await pickInterval(page, '10秒');
    await expect(intervalLabel(page)).toHaveText('10秒');

    await page.reload();
    await expect(intervalLabel(page)).toHaveText('10秒');
  });

  test('手动刷新按钮不受影响（默认 off，点按钮立即出日志）', async ({ page, lucent }) => {
    lucent.upstream.reset();
    lucent.upstream.setMode('chat-sse');
    await lucent.clearLogs();
    await page.goto(lucent.webBaseUrl);
    await expect(intervalLabel(page)).toHaveText('关闭');
    await expect(page.getByTestId('log-row')).toHaveCount(0);

    await lucent.postThroughProxy('/openai/v1/chat/completions', OAI_HEADERS, REQ_BODY);
    // 默认 off 不自动刷新；手动点 refresh-btn 应立即拉到
    await page.getByTestId('refresh-btn').click();
    await expect(page.getByTestId('log-row')).toHaveCount(1, { timeout: 5_000 });
  });
});
