/**
 * 种子 spec —— Web UI 交互层 e2e 的样板
 *
 * 贯穿主流程：起服务 → 发请求穿越代理 → Web UI 出 log-row → 点开看 detail 的
 * Request / Response tab。后续 F1–F6 的交互 spec（筛选 / 视图切换 / 滚动暂停 /
 * 拖拽调宽）照这个结构写。
 *
 * 刻意避开 TAE-48 在审的逻辑：不动 provider/endpoint 筛选、不切 timeline/session
 * 视图、不滚、不拖——只断言当前稳定行为。
 */
import { test, expect } from './fixtures';

// 用 mock key，绝不硬编码真 key（task 安全要求）。代理只转发明文，不校验 key。
const OAI_HEADERS = { authorization: 'Bearer sk-mock-ui-e2e' };
const REQ_BODY = {
  model: 'gpt-4o',
  max_tokens: 1,
  messages: [{ role: 'user', content: 'ping' }],
};

test.describe('种子 spec：请求穿越代理 → Web UI 出日志 → 点开看详情', () => {
  test('主流程：log-row 出现，点开看 Request/Response tab', async ({ page, lucent }) => {
    lucent.upstream.reset();
    lucent.upstream.setMode('chat-sse');

    // ① 发请求穿过代理（mock 上游回 chat-sse 流）
    const res = await lucent.postThroughProxy('/openai/v1/chat/completions', OAI_HEADERS, REQ_BODY);
    expect(res.status, `代理应回 200，实际 ${res.status}`).toBe(200);
    expect(res.body).toContain('[DONE]');

    // 等日志落盘
    await expect
      .poll(() => lucent.latestLogId('openai', 'openai-chat'), { timeout: 5000, message: '日志应落盘' })
      .toBeTruthy();
    const logId = lucent.latestLogId('openai', 'openai-chat');

    // ② 打开 Web UI，列表出现 log-row
    // 共享栈（workers:1 + worker-scoped fixture）下日志会在兄弟 spec 间累积，
    // 列表常多于一行——这里只断言「至少一行可见」，具体点哪行靠下面的 data-logid。
    await page.goto(lucent.webBaseUrl);
    await expect(page.getByTestId('log-row').first()).toBeVisible();
    const rowCount = await page.getByTestId('log-row').count();
    expect(rowCount, '至少一行日志').toBeGreaterThanOrEqual(1);

    // ③ 点开看详情（交互：点击行触发，不是 URL 直跳）
    await expect(page.getByTestId('detail-empty')).toBeVisible();
    await page.locator(`[data-testid="log-row"][data-logid="${logId}"]`).click();
    // 详情面板渲染，默认 Request tab
    await expect(page.getByTestId('detail-panel')).toBeVisible();
    await expect(page.getByTestId('request-body')).toBeVisible();
    const reqText = (await page.getByTestId('request-body').textContent()) ?? '';
    expect(reqText, 'Request tab 应渲染请求体含 messages').toContain('messages');

    // ④ 切到 Response tab（SSE raw 模式渲染原始 chunk 流，含 chat.completion.chunk）
    await page.getByTestId('tab-response').click();
    await expect(page.getByTestId('response-body')).toBeVisible();
    const respText = (await page.getByTestId('response-body').textContent()) ?? '';
    expect(respText, 'Response tab 应渲染 SSE 原始流含 chat.completion.chunk').toContain('chat.completion.chunk');
  });
});
