/**
 * Context 面板系统提示词分段展示 spec（TAE-90，按用户反馈修订）
 *
 * 锁定端到端契约：系统提示词在「左侧一整块、右侧分多卡片」——
 *  - 后端：context.systemPrompt 仍是 string[]（N 段就 N 个元素，不 join）。
 *  - 前端：左侧「系统提示词」分组只有 1 个 system 项（不再按段拆成 N 条），
 *    点开后右侧按段渲染 N 张独立卡片（data-kind="segment"）。
 *  - 反向：单段 → 左侧仍 1 项、右侧 1 张卡片，不回归。
 *
 * 用 OpenAI Chat 多条 system 消息（每条 = 一段）路径，因为这原先 bug 最严重
 * （第 2 条 system 消息起被 continue 丢弃），最能证明「多段全保留」。
 *
 * 结构照抄 seed.spec.ts，复用 e2e/fixtures.ts 的 lucent fixture（隔离栈），不重造。
 */
import { test, expect } from './fixtures';

const OAI_HEADERS = { authorization: 'Bearer sk-mock-ui-e2e' };

test.describe('Context 面板：系统提示词左一整块、右多段卡片', () => {
  test('多条 system 消息 → 左侧 1 个 system 项、右侧 3 张段卡片，API context.systemPrompt 为 string[]', async ({ page, lucent }) => {
    lucent.upstream.reset();
    lucent.upstream.setMode('chat-json');

    // 3 条 system 消息 = 3 段；每段一个可辨识文本，便于断言卡片内容。
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

    // ① 后端契约：context.systemPrompt 必须是 3 段的 string[]（不 join）
    const entries = await lucent.readLogEntries();
    const entry = entries.find((e) => e.id === logId);
    const systemPrompt = (entry as any)?.context?.systemPrompt;
    expect(Array.isArray(systemPrompt), 'context.systemPrompt 必须是数组').toBe(true);
    expect(systemPrompt).toEqual(['TAE90 seg one', 'TAE90 seg two', 'TAE90 seg three']);

    // ② 前端契约：左侧「系统提示词」只有 1 个 system 项（不再按段拆成 3 条）
    await page.goto(`${lucent.webBaseUrl}/?log=${logId}&tab=context`);
    await expect(page.getByTestId('detail-panel')).toBeVisible();

    const systemItems = page.locator('[data-testid="context-item"][data-role="system"]');
    await expect(systemItems, '系统提示词左侧应为 1 个整块项，不按段拆').toHaveCount(1);

    // 验收截图：左侧一整块 + 右侧多卡片（test-results/tae90-context-multiseg-cards.png）
    await systemItems.click();

    // ③ 选中后右侧渲染 3 张段卡片（data-kind="segment"），各段文本按序可见
    const segCards = page.locator('[data-testid="context-card"][data-kind="segment"]');
    await expect(segCards, '3 段应渲染 3 张段卡片').toHaveCount(3);

    const cardTexts = await segCards.allTextContents();
    expect(cardTexts[0]).toContain('TAE90 seg one');
    expect(cardTexts[1]).toContain('TAE90 seg two');
    expect(cardTexts[2]).toContain('TAE90 seg three');

    // 右侧标题为「系统提示词」（整块，不再带单段序号）
    await expect(page.getByTestId('detail-title')).toHaveText('系统提示词');

    await page.screenshot({ path: 'test-results/tae90-context-multiseg-cards.png' });
  });

  test('反向：单条 system 消息 → 左侧仍 1 项、右侧 1 张段卡片，不回归', async ({ page, lucent }) => {
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
    await expect(systemItems, '单段左侧仍为 1 个整块项').toHaveCount(1);

    await systemItems.click();
    const segCards = page.locator('[data-testid="context-card"][data-kind="segment"]');
    await expect(segCards, '单段右侧渲染 1 张段卡片').toHaveCount(1);
  });

  test('对话历史：一条 user 消息 content 多 block → 左侧仍 1 项、右侧多张卡片', async ({ page, lucent }) => {
    lucent.upstream.reset();
    lucent.upstream.setMode('chat-json');

    // 一条 user 消息，content 是多 part 数组（OpenAI Chat content parts）→ 一个左项、多张右卡。
    const body = {
      model: 'gpt-4o',
      max_tokens: 1,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'TAE90 user block one' },
            { type: 'text', text: 'TAE90 user block two' },
          ],
        },
      ],
    };

    const res = await lucent.postThroughProxy('/openai/v1/chat/completions', OAI_HEADERS, body);
    expect(res.status).toBe(200);

    await expect
      .poll(() => lucent.latestLogId('openai', 'openai-chat'), { timeout: 5000, message: '日志应落库' })
      .toBeTruthy();
    const logId = await lucent.latestLogId('openai', 'openai-chat');

    await page.goto(`${lucent.webBaseUrl}/?log=${logId}&tab=context`);
    await expect(page.getByTestId('detail-panel')).toBeVisible();

    // 左侧「对话历史」里这条 user 只占 1 项（一整块），不按 block 拆
    const userItems = page.locator('[data-testid="context-item"][data-role="user"]');
    await expect(userItems, '多 block 的 user 消息左侧应为 1 个整块项').toHaveCount(1);

    // 选中后右侧按 block 渲染 2 张 text 卡片
    await userItems.first().click();
    const textCards = page.locator('[data-testid="context-card"][data-kind="text"]');
    await expect(textCards, '2 个 content block 应渲染 2 张卡片').toHaveCount(2);

    const cardTexts = await textCards.allTextContents();
    expect(cardTexts[0]).toContain('TAE90 user block one');
    expect(cardTexts[1]).toContain('TAE90 user block two');
  });
});
