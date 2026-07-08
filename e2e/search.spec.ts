/**
 * 检索功能 e2e（step 3）
 *
 * - 搜索框（防抖）+ 服务端 FTS 过滤 + 详情命中高亮：发带唯一锚点的请求 → 搜索 → 列表收窄 →
 *   点开看 Context tab，正文里命中词被 <mark> 标黄。
 * - keyset 深分页：经 /api/logs?cursor= 翻页，断言页间 id 不重叠、不漏、最终 hasMore=false。
 *
 * 复用 e2e/fixtures.ts 的隔离栈（mock 上游 + 临时 config + 随机端口 + 起 backend + vite dev）。
 */
import { test, expect } from './fixtures';

const OAI_HEADERS = { authorization: 'Bearer sk-mock-ui-e2e' };
const NEEDLE = 'STEP3NEEDLE';

test.describe('检索功能（step 3）', () => {
  test('搜索框过滤 + 命中高亮', async ({ page, lucent }) => {
    lucent.upstream.reset();
    lucent.upstream.setMode('chat-sse');

    // 2 条正文带唯一锚点（可被 FTS trigram 命中），1 条无关
    await lucent.postThroughProxy('/openai/v1/chat/completions', OAI_HEADERS, {
      model: 'gpt-4o', max_tokens: 1,
      messages: [{ role: 'user', content: `${NEEDLE} review the agent runtime` }],
    });
    await lucent.postThroughProxy('/openai/v1/chat/completions', OAI_HEADERS, {
      model: 'gpt-4o', max_tokens: 1,
      messages: [{ role: 'user', content: `${NEEDLE} check the proxy logs` }],
    });
    await lucent.postThroughProxy('/openai/v1/chat/completions', OAI_HEADERS, {
      model: 'gpt-4o', max_tokens: 1,
      messages: [{ role: 'user', content: 'unrelated weather question' }],
    });

    await page.goto(lucent.webBaseUrl);
    // 本测试的 3 条先就位（worker 共享后端，可能已有别测试的行，故用 >=）
    await expect.poll(async () => page.getByTestId('log-row').count(), { timeout: 10_000 }).toBeGreaterThanOrEqual(3);

    // 输入搜索词 → 防抖 300ms 后触发服务端 FTS → 列表收窄到 2 条（只有 2 条含锚点，与其它日志无关）
    await page.getByTestId('log-search-input').fill(NEEDLE);
    await expect(page.getByTestId('log-row')).toHaveCount(2, { timeout: 10_000 });

    // 点开第一条 → 切 Context tab → 选 user 消息 → 命中词被标黄
    await page.getByTestId('log-row').first().click();
    await expect(page.getByTestId('detail-panel')).toBeVisible();
    await page.getByTestId('tab-context').click();
    await page.getByTestId('context-item').first().click();
    const hit = page.locator('mark.search-hit', { hasText: NEEDLE });
    await expect(hit).toBeVisible();
  });

  test('keyset 深分页（/api/logs 游标）：页间不重叠、不漏、终止', async ({ lucent }) => {
    lucent.upstream.reset();
    lucent.upstream.setMode('chat-sse');
    for (let i = 0; i < 6; i++) {
      await lucent.postThroughProxy('/openai/v1/chat/completions', OAI_HEADERS, {
        model: 'gpt-4o', max_tokens: 1,
        messages: [{ role: 'user', content: `keyset probe ${i}` }],
      });
    }
    // 等全部落库
    await expect.poll(async () => (await lucent.fetchLogsPage({ limit: 1 })).total, { timeout: 10_000 })
      .toBeGreaterThanOrEqual(6);

    // keyset 翻页（limit=2，首页无 cursor，续页带 nextCursor）
    const seen: string[] = [];
    let cursor: string | undefined = undefined;
    let lastHasMore = true;
    for (let i = 0; i < 20; i++) {
      const page = await lucent.fetchLogsPage({ limit: 2, cursor });
      for (const l of page.logs) seen.push(l.id as string);
      lastHasMore = page.hasMore;
      if (!page.hasMore || !page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(lastHasMore, '翻完最后一页 hasMore 应为 false').toBe(false);
    expect(new Set(seen).size, 'keyset 页间 id 不重叠').toBe(seen.length);
    expect(seen.length, '至少翻出本测试的 6 条').toBeGreaterThanOrEqual(6);
  });
});
