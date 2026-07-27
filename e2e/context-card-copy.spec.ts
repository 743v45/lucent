/**
 * Context 详情卡片复制按钮 spec（TAE-113）
 *
 * 锁定端到端契约：Context tab 右侧每张卡片都有一个复制按钮，点击只复制本卡的 content；
 * 卡片正文为空（显示「（空）」）时不显示按钮。
 *
 * 覆盖三种卡（与任务验收一一对应）：
 *  - 系统提示词多段卡（data-kind="segment"，头行带 #N 标签，无 tag）
 *  - 带 tag 的工具调用卡（data-kind="tool_use"，头行带 label + tag）
 *  - 纯文本消息卡（data-kind="text"，无头——单独起一个头行放按钮）
 *
 * 数据来源（不瞎编）：tool_use / tool_result 卡只能由 Anthropic 协议路径产出
 * （OpenAI Chat 的 assistant tool_calls 在 extractOpenAIChat 里被归一化成空 content，
 *  前端 messageToCards 收到空数组不出卡）。所以这里走 anthropic-messages 上游，
 * 用 sse-text（标准 200 文本流）把请求落库即可——context 由 buildContextFromRequest
 * 从 request.body 提取，与响应模式无关。
 *
 * 复制正确性用剪贴板读回强校验（每张卡内容都带唯一标记，能证「只复制本卡、不串内容」）；
 * 同时校验 CopyButton 文案翻成「已复制」（onCopy 返回 true 才翻）。
 * 截图用外置 overlay（测试注入 position:fixed 红框，不改仓库代码）框出复制按钮。
 */
import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

const ANTH_HEADERS = { 'x-api-key': 'sk-mock-ui-e2e', 'anthropic-version': '2023-06-01' };

// 一条 anthropic 请求造出全部用例：3 段 system + 纯文本 user + tool_use assistant + tool_result user + 空 user。
// 每段 / 每块内容都带唯一标记，断言剪贴板时能区分「本卡」与「邻卡」。
const ANTH_BODY_ALL_CARDS = {
  model: 'claude-sonnet-4-20250514',
  max_tokens: 16,
  system: [
    { type: 'text', text: '系统提示·第一段·标记SEG1' },
    { type: 'text', text: '系统提示·第二段·标记SEG2' },
    { type: 'text', text: '系统提示·第三段·标记SEG3' },
  ],
  messages: [
    // [0] user：纯文本块 → 无头 text 卡
    { role: 'user', content: [{ type: 'text', text: '纯文本用户消息·标记TXT' }] },
    // [1] assistant：tool_use 块 → 带 label+tag 的工具调用卡
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_marker', name: 'Bash', input: { command: 'echo TOOLUSE_MARKER' } }] },
    // [2] user：tool_result 块 → 带 label+tag 的工具结果卡
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_marker', content: '工具结果正文·标记RES' }] },
    // [3] user：空文本块 → 正文为空、无复制按钮的「（空）」卡（反向用例）
    { role: 'user', content: [{ type: 'text', text: '' }] },
  ],
};

/** 给定位到的复制按钮套一个外置红框 + 标签（position:fixed 对齐视口坐标，截图后移除）。 */
async function annotateCopyButton(page: Page, locator: import('@playwright/test').Locator, label: string) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) throw new Error('annotateCopyButton: 拿不到 boundingBox');
  await page.evaluate(({ box, label }) => {
    const frame = document.createElement('div');
    Object.assign(frame.style, {
      position: 'fixed',
      left: `${box.x - 4}px`,
      top: `${box.y - 4}px`,
      width: `${box.width + 8}px`,
      height: `${box.height + 8}px`,
      border: '2px dashed #ef4444',
      borderRadius: '6px',
      zIndex: '99999',
      pointerEvents: 'none',
    });
    const tag = document.createElement('div');
    tag.textContent = label;
    Object.assign(tag.style, {
      position: 'fixed',
      left: `${box.x - 4}px`,
      top: `${Math.max(box.y - 22, 0)}px`,
      background: '#ef4444',
      color: '#fff',
      fontSize: '11px',
      lineHeight: '16px',
      padding: '1px 6px',
      borderRadius: '4px',
      zIndex: '99999',
      pointerEvents: 'none',
    });
    document.body.append(frame, tag);
  }, { box, label });
}

async function clearOverlays(page: Page) {
  await page.evaluate(() => {
    // 仅清测试注入的框/签（不动仓库 DOM）
    document.querySelectorAll('div[style*="99999"]').forEach((el) => el.remove());
  });
}

test.describe('Context 详情卡片复制按钮（TAE-113）', () => {
  test.beforeEach(async ({ page, lucent }) => {
    lucent.upstreamAnthropic.reset();
    lucent.upstreamAnthropic.setMode('sse-text');
    await lucent.postThroughProxy('/anthropic/v1/messages', ANTH_HEADERS, ANTH_BODY_ALL_CARDS);
    await expect
      .poll(() => lucent.latestLogId('anthropic', 'anthropic-messages'), { timeout: 5000, message: '日志应落库' })
      .toBeTruthy();
    // clipboard 读写都要权限（127.0.0.1 是安全上下文，但仍需显式授权 readText）
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: lucent.webBaseUrl });
  });

  test('系统提示词多段卡：每张段卡头行有复制按钮，点击只复制本段', async ({ page, lucent }) => {
    const logId = await lucent.latestLogId('anthropic', 'anthropic-messages');
    await page.goto(`${lucent.webBaseUrl}/?log=${logId}&tab=context`);
    await expect(page.getByTestId('detail-panel')).toBeVisible();

    await page.locator('[data-testid="context-item"][data-role="system"]').click();
    const segCards = page.locator('[data-testid="context-card"][data-kind="segment"]');
    await expect(segCards, '3 段应渲染 3 张段卡片').toHaveCount(3);

    // 每张段卡恰好一个复制按钮
    await expect(segCards.nth(0).getByRole('button', { name: '复制' })).toHaveCount(1);
    await expect(segCards.nth(1).getByRole('button', { name: '复制' })).toHaveCount(1);
    await expect(segCards.nth(2).getByRole('button', { name: '复制' })).toHaveCount(1);

    // 点第 2 张的按钮 → 剪贴板 = 第 2 段（不是第 1/3 段，证「只复制本卡」）
    const card2 = segCards.nth(1);
    const btn2 = card2.getByRole('button', { name: '复制' });
    await card2.screenshot({ path: 'test-results/tae113-segment-card.png' });
    await annotateCopyButton(page, btn2, '复制·第2段');
    await page.screenshot({ path: 'test-results/tae113-segment-copy.png' });
    await clearOverlays(page);
    await btn2.click();
    await expect(btn2).toHaveText('已复制');
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip, '只复制第 2 段').toBe('系统提示·第二段·标记SEG2');
    expect(clip, '不能串入第 1/3 段').not.toContain('SEG1');
    expect(clip).not.toContain('SEG3');
  });

  test('带 tag 的工具调用卡：头行 label+tag+复制按钮，点击复制 input JSON', async ({ page, lucent }) => {
    const logId = await lucent.latestLogId('anthropic', 'anthropic-messages');
    await page.goto(`${lucent.webBaseUrl}/?log=${logId}&tab=context`);
    await expect(page.getByTestId('detail-panel')).toBeVisible();

    // 选 assistant（messages[1]）→ 右侧出 tool_use 卡
    await page.locator('[data-testid="context-item"][data-role="assistant"]').first().click();
    const useCard = page.locator('[data-testid="context-card"][data-kind="tool_use"]');
    await expect(useCard).toHaveCount(1);
    // 头行同时有 label、tag、复制按钮
    await expect(useCard.getByText('工具调用: Bash')).toBeVisible();
    await expect(useCard.getByText('工具调用', { exact: true })).toBeVisible();
    const btn = useCard.getByRole('button', { name: '复制' });
    await expect(btn).toHaveCount(1);

    await useCard.screenshot({ path: 'test-results/tae113-tooluse-card.png' });
    await annotateCopyButton(page, btn, '复制·工具调用');
    await page.screenshot({ path: 'test-results/tae113-tooluse-copy.png' });
    await clearOverlays(page);
    await btn.click();
    await expect(btn).toHaveText('已复制');
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip, '复制的是 input 的 JSON').toBe(JSON.stringify({ command: 'echo TOOLUSE_MARKER' }, null, 2));
  });

  test('纯文本消息卡（无头）：单独起头行放复制按钮，点击复制正文', async ({ page, lucent }) => {
    const logId = await lucent.latestLogId('anthropic', 'anthropic-messages');
    await page.goto(`${lucent.webBaseUrl}/?log=${logId}&tab=context`);
    await expect(page.getByTestId('detail-panel')).toBeVisible();

    // 选第 1 条 user（messages[0]，纯文本块）→ 无头 text 卡
    await page.locator('[data-testid="context-item"][data-role="user"]').first().click();
    const textCard = page.locator('[data-testid="context-card"][data-kind="text"]');
    await expect(textCard, '应渲染 1 张无头 text 卡').toHaveCount(1);
    // 无头卡：没有 label/tag，但仍有复制按钮（说明给它起了头行）
    const btn = textCard.getByRole('button', { name: '复制' });
    await expect(btn).toHaveCount(1);

    await textCard.screenshot({ path: 'test-results/tae113-plain-card.png' });
    await annotateCopyButton(page, btn, '复制·纯文本');
    await page.screenshot({ path: 'test-results/tae113-plain-copy.png' });
    await clearOverlays(page);
    await btn.click();
    await expect(btn).toHaveText('已复制');
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip).toBe('纯文本用户消息·标记TXT');
  });

  test('反向：正文为空的卡片不显示复制按钮', async ({ page, lucent }) => {
    const logId = await lucent.latestLogId('anthropic', 'anthropic-messages');
    await page.goto(`${lucent.webBaseUrl}/?log=${logId}&tab=context`);
    await expect(page.getByTestId('detail-panel')).toBeVisible();

    // 选最后一条 user（messages[3]，空文本块）→ 正文为空、显示「（空）」、无复制按钮。
    // 注：tool_result 那条（messages[2]）role 仍是 'user'，故 user 列项有 3 个（msg0/msg2/msg3），
    //     空卡在最后一条 user 上，取 .last()。
    const userItems = page.locator('[data-testid="context-item"][data-role="user"]');
    await expect(userItems, '应有 3 个 user 列项').toHaveCount(3);
    await userItems.last().click();
    const emptyCard = page.locator('[data-testid="context-card"][data-kind="text"]');
    await expect(emptyCard).toHaveCount(1);
    await expect(emptyCard.getByText('（空）')).toBeVisible();
    await expect(emptyCard.getByRole('button', { name: '复制' }), '空卡不应有复制按钮').toHaveCount(0);
  });
});
