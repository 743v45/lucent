/**
 * Context 面板系统提示词多段还原 spec（TAE-90）
 *
 * 锁定端到端契约：多段 system prompt 不再被 join 成 1 段——
 *  - 多段（这里用 OpenAI Chat 多条 system 消息，每条 = 一段）→ Context 面板渲染 N 条独立段，
 *    API 返回的 context.systemPrompt 也是 string[]（N 个元素）。
 *  - 反向：单段（单条 system 消息）→ 仍渲染 1 条，不回归。
 *
 * 用 OpenAI Chat 路径是因为它原先的 bug 最严重（第 2 条 system 消息起被 continue 丢弃），
 * 最能证明「多段全保留」。Anthropic 多段口径由 unit（context-extractors / log-reader）覆盖。
 *
 * 结构照抄 seed.spec.ts，复用 e2e/fixtures.ts 的 lucent fixture（隔离栈），不重造。
 */
import { test, expect } from './fixtures';

const OAI_HEADERS = { authorization: 'Bearer sk-mock-ui-e2e' };

test.describe('Context 面板：系统提示词按段渲染（N 段不拼成 1 段）', () => {
  test('多条 system 消息 → 渲染 N 条独立段，API context.systemPrompt 为 string[]', async ({ page, lucent }) => {
    lucent.upstream.reset();
    lucent.upstream.setMode('chat-json');

    // 3 条 system 消息 = 3 段；每段一个可辨识的段首，便于断言渲染与选中。
    const body = {
      model: 'gpt-4o',
      max_tokens: 1,
      messages: [
        { role: 'system', content: 'TAE90 seg one' },
        { role: 'system', content: 'TAE90 seg two' },
        { role: 'system', content: 'TAE90 seg three' },
        { role: 'user', content: 'ping' },
      ],
    };

    const res = await lucent.postThroughProxy('/openai/v1/chat/completions', OAI_HEADERS, body);
    expect(res.status, `代理应回 200，实际 ${res.status}`).toBe(200);

    await expect
      .poll(() => lucent.latestLogId('openai', 'openai-chat'), { timeout: 5000, message: '日志应落库' })
      .toBeTruthy();
    const logId = await lucent.latestLogId('openai', 'openai-chat');

    // ① 后端契约：context.systemPrompt 必须是 3 段的 string[]（不再 join）
    const entries = await lucent.readLogEntries();
    const entry = entries.find((e) => e.id === logId);
    const systemPrompt = (entry as any)?.context?.systemPrompt;
    expect(Array.isArray(systemPrompt), 'context.systemPrompt 必须是数组').toBe(true);
    expect(systemPrompt).toEqual(['TAE90 seg one', 'TAE90 seg two', 'TAE90 seg three']);

    // ② 前端契约：Context 面板渲染 3 条独立段（data-role="system"）
    await page.goto(`${lucent.webBaseUrl}/?log=${logId}&tab=context`);
    await expect(page.getByTestId('detail-panel')).toBeVisible();

    const systemItems = page.locator('[data-testid="context-item"][data-role="system"]');
    await expect(systemItems, '3 段应渲染 3 个 system 项').toHaveCount(3);

    // 段序号 label：#1 / #2 / #3
    const labels = await systemItems.allTextContents();
    expect(labels[0]).toContain('#1');
    expect(labels[1]).toContain('#2');
    expect(labels[2]).toContain('#3');

    // 验收截图：3 段列表（test-results/tae90-context-multiseg-list.png）
    await page.screenshot({ path: 'test-results/tae90-context-multiseg-list.png' });

    // ③ 选中第 2 段 → 右侧标题为「系统提示词 #2」、正文展示该段文本（按段取内容，非整串）
    await systemItems.nth(1).click();
    await expect(page.locator('h3'), '选中第 2 段时右侧标题应带段号 #2').toHaveText('系统提示词 #2');
    await expect(page.getByTestId('detail-panel')).toContainText('TAE90 seg two');
    // 验收截图：选中第 2 段的详情（test-results/tae90-context-multiseg-seg2.png）
    await page.screenshot({ path: 'test-results/tae90-context-multiseg-seg2.png' });
  });

  test('反向：单条 system 消息 → 仍渲染 1 条，不回归', async ({ page, lucent }) => {
    lucent.upstream.reset();
    lucent.upstream.setMode('chat-json');

    const body = {
      model: 'gpt-4o',
      max_tokens: 1,
      messages: [
        { role: 'system', content: 'TAE90 only segment' },
        { role: 'user', content: 'ping' },
      ],
    };

    const res = await lucent.postThroughProxy('/openai/v1/chat/completions', OAI_HEADERS, body);
    expect(res.status).toBe(200);

    await expect
      .poll(() => lucent.latestLogId('openai', 'openai-chat'), { timeout: 5000, message: '日志应落库' })
      .toBeTruthy();
    const logId = await lucent.latestLogId('openai', 'openai-chat');

    const entries = await lucent.readLogEntries();
    const entry = entries.find((e) => e.id === logId);
    expect((entry as any)?.context?.systemPrompt).toEqual(['TAE90 only segment']);

    await page.goto(`${lucent.webBaseUrl}/?log=${logId}&tab=context`);
    await expect(page.getByTestId('detail-panel')).toBeVisible();

    const systemItems = page.locator('[data-testid="context-item"][data-role="system"]');
    await expect(systemItems, '单段仍渲染 1 个 system 项').toHaveCount(1);
  });
});
