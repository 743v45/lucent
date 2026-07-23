/**
 * Context 详情卡片逐段复制 spec（TAE-110）
 *
 * 锁定端到端契约：详情页 Context 标签页右侧每张详情卡片各自带一个复制按钮，
 * 点一下只复制这一段（非整块复制）。覆盖三类卡片：
 *  - 系统提示词每一段（data-kind="segment"）
 *  - 对话历史每条消息的每个 content block（data-kind="text"）
 *  - 每个工具的描述（data-kind="plain"）
 *
 * 验证手段（不撒谎、不空话）：点复制按钮 → 等「已复制」反馈出现（只有 copyText 真正写入
 * 剪贴板才会显）→ 读剪贴板，断言内容 == 该卡片原文。三个 kind 各验一张。
 *
 * 结构照抄 system-prompt-segments.spec.ts，复用 e2e/fixtures.ts 的 lucent fixture（隔离栈），
 * 不重造。testid 复用 context-card / context-card-copy / context-item / detail-panel。
 */
import { test, expect } from './fixtures';

const OAI_HEADERS = { authorization: 'Bearer sk-mock-ui-e2e' };

// 多段 system + 多 block user 消息 + tools：一次造出三类可复制卡片。
// 每段/每块/工具描述都用可辨识的唯一文本，便于按 hasText 精确定位单张卡片。
const BODY = {
  model: 'gpt-4o',
  max_tokens: 1,
  messages: [
    { role: 'system', content: 'TAE110 system segment A' },
    { role: 'system', content: 'TAE110 system segment B' },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'TAE110 user block one' },
        { type: 'text', text: 'TAE110 user block two' },
      ],
    },
  ],
  tools: [{ type: 'function', function: { name: 'list_files', description: 'TAE110 list files tool description' } }],
};

// 读剪贴板：navigator.clipboard.readText（需 clipboard-read 权限，beforeEach 已 grant）。
const readClipboard = (page: import('@playwright/test').Page) =>
  page.evaluate(() => navigator.clipboard.readText());

test.describe('Context 详情卡片逐段复制（TAE-110）', () => {
  // chromium 下 readText 需 clipboard-read 权限；127.0.0.1 是安全上下文，writeText 本就可写。
  // 必须在首次导航前 grant，否则 readText 会因权限被拒而抛错。
  test.beforeEach(async ({ context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  });

  test('系统提示词段 / 消息内容块 / 工具描述 各自复制：剪贴板 == 该段原文，且只复制这一段', async ({ page, lucent }) => {
    lucent.upstream.reset();
    lucent.upstream.setMode('chat-json');

    const res = await lucent.postThroughProxy('/openai/v1/chat/completions', OAI_HEADERS, BODY);
    expect(res.status, `代理应回 200，实际 ${res.status}`).toBe(200);

    await expect
      .poll(() => lucent.latestLogId('openai', 'openai-chat'), { timeout: 5000, message: '日志应落库' })
      .toBeTruthy();
    const logId = await lucent.latestLogId('openai', 'openai-chat');

    // 默认选中系统提示词（有段时），右侧直接出段卡片，无需点击
    await page.goto(`${lucent.webBaseUrl}/?log=${logId}&tab=context`);
    await expect(page.getByTestId('detail-panel')).toBeVisible();

    // ---------- ① 系统提示词：每段一张卡片、各自一个复制按钮 ----------
    const segCards = page.locator('[data-testid="context-card"][data-kind="segment"]');
    await expect(segCards, '2 段 system 消息应渲染 2 张段卡片').toHaveCount(2);
    // 每张段卡片各有 1 个复制按钮
    await expect(segCards.first().getByTestId('context-card-copy')).toHaveCount(1);

    // 复制第 1 段：按内容精确定位该卡片 → 点其复制按钮 → 等「已复制」（写入成功才显）→ 读剪贴板
    const segCardA = segCards.filter({ hasText: 'TAE110 system segment A' });
    await expect(segCardA).toHaveCount(1);
    await segCardA.getByTestId('context-card-copy').click();
    await expect(segCardA.getByTestId('context-card-copy')).toHaveText('已复制');
    expect(await readClipboard(page), '复制第 1 段：剪贴板应只含该段原文').toBe('TAE110 system segment A');
    // 验收截图①：系统提示词段卡片 + 复制按钮（已复制态）
    await page.getByTestId('detail-panel').screenshot({ path: 'test-results/tae110-copy-segment.png' });

    // ---------- ② 对话历史：每个 content block 一张卡片、各自复制 ----------
    await page.locator('[data-testid="context-item"][data-role="user"]').first().click();
    const textCards = page.locator('[data-testid="context-card"][data-kind="text"]');
    await expect(textCards, '2 个 content block 应渲染 2 张文本卡片').toHaveCount(2);

    const blockTwo = textCards.filter({ hasText: 'TAE110 user block two' });
    await expect(blockTwo).toHaveCount(1);
    await blockTwo.getByTestId('context-card-copy').click();
    await expect(blockTwo.getByTestId('context-card-copy')).toHaveText('已复制');
    expect(await readClipboard(page), '复制第 2 个块：剪贴板只含该块，不含第 1 块').toBe('TAE110 user block two');
    // 验收截图②：消息内容块卡片 + 复制按钮
    await page.getByTestId('detail-panel').screenshot({ path: 'test-results/tae110-copy-text.png' });

    // ---------- ③ 可用工具：每个工具描述一张卡片、各自复制 ----------
    await page.locator('[data-testid="context-item"][data-role="tool"]').first().click();
    const toolCards = page.locator('[data-testid="context-card"][data-kind="plain"]');
    await expect(toolCards, '工具描述应渲染 1 张卡片').toHaveCount(1);

    await toolCards.getByTestId('context-card-copy').click();
    await expect(toolCards.getByTestId('context-card-copy')).toHaveText('已复制');
    expect(await readClipboard(page), '复制工具描述：剪贴板应只含该工具描述').toBe('TAE110 list files tool description');

    // 验收截图③：工具描述卡片 + 复制按钮
    await page.getByTestId('detail-panel').screenshot({ path: 'test-results/tae110-context-card-copy.png' });
  });
});
