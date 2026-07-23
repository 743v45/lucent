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
 * 验收截图（带标注）：按 review-squad DoD——干净截图 + 只读 boundingBox() 量复制按钮坐标，
 * 在独立 context（deviceScaleFactor:1）里用 HTML overlay 画红框 + 文字标签再截。不注入运行中
 * 的页面、不动仓库代码、不依赖图像库。临时 overlay/产物落 /tmp（仓库外），最终标注图同放 /tmp。
 *
 * 结构照抄 system-prompt-segments.spec.ts，复用 e2e/fixtures.ts 的 lucent fixture（隔离栈），
 * 不重造。testid 复用 context-card / context-card-copy / context-item / detail-panel。
 */
import { test, expect } from './fixtures';
import type { Page, Locator } from '@playwright/test';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
const readClipboard = (page: Page) => page.evaluate(() => navigator.clipboard.readText());

// 标注图输出目录（仓库外）。最终三张标注图 + 干净图 + overlay HTML 都放这里。
const ANNOT_DIR = join(tmpdir(), 'lucent-annot-tae110');

/**
 * 给一张详情卡片的复制按钮画红框标注：截 detail-panel 干净图 → 量按钮相对面板坐标 →
 * 独立 context（dpr=1）里 HTML overlay 画框+标签再截。不注入运行中的应用页面。
 *
 * 坐标换算：app 页 boundingBox 返回 CSS px，源截图像素 = CSS px × appDpr；
 * overlay context dpr=1（1 CSS px = 1 像素），img 按源像素原尺寸显示，框按源像素坐标画 → 对齐。
 */
async function annotateCopyButton(appPage: Page, panel: Locator, btn: Locator, label: string, outPath: string) {
  const appDpr = await appPage.evaluate(() => window.devicePixelRatio);
  const panelBox = await panel.boundingBox();
  const btnBox = await btn.boundingBox();
  if (!panelBox || !btnBox) throw new Error(`annotate: 取不到 boundingBox（label=${label}）`);

  const cleanPath = outPath.replace(/\.png$/, '-clean.png');
  await panel.screenshot({ path: cleanPath });
  // 读干净图转 data URI（overlay 用 data URI，免 file:// 跨资源加载问题）
  const b64 = readFileSync(cleanPath).toString('base64');

  // 复制按钮相对面板左上角的坐标，转源截图像素（×appDpr）
  const sx = (btnBox.x - panelBox.x) * appDpr;
  const sy = (btnBox.y - panelBox.y) * appDpr;
  const sw = btnBox.width * appDpr;
  const sh = btnBox.height * appDpr;
  const imgW = Math.round(panelBox.width * appDpr);
  const imgH = Math.round(panelBox.height * appDpr);
  const lblTop = Math.max(sy - 30, 2);

  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    body{margin:0;background:#fff} .wrap{position:relative;display:inline-block}
    img{display:block;width:${imgW}px;height:${imgH}px}
    .box{position:absolute;left:${sx}px;top:${sy}px;width:${sw}px;height:${sh}px;border:3px solid #ff3b3b;border-radius:5px;box-sizing:border-box}
    .lbl{position:absolute;left:${sx}px;top:${lblTop}px;background:#ff3b3b;color:#fff;font:700 17px/1.2 system-ui,sans-serif;padding:3px 8px;border-radius:5px;white-space:nowrap}
  </style></head><body><div class="wrap">
    <img src="data:image/png;base64,${b64}"/>
    <div class="lbl">${label}</div>
    <div class="box"></div>
  </div></body></html>`;

  const overlayHtmlPath = outPath.replace(/\.png$/, '-overlay.html');
  writeFileSync(overlayHtmlPath, html);

  // 独立 context 渲染 overlay（dpr=1，不碰应用页面）
  const browser = appPage.context().browser();
  if (!browser) throw new Error('annotate: 取不到 browser');
  const ctx = await browser.newContext({ deviceScaleFactor: 1 });
  try {
    const op = await ctx.newPage();
    await op.goto('file://' + overlayHtmlPath);
    await op.locator('.wrap').screenshot({ path: outPath });
  } finally {
    await ctx.close();
  }
}

test.describe('Context 详情卡片逐段复制（TAE-110）', () => {
  // chromium 下 readText 需 clipboard-read 权限；127.0.0.1 是安全上下文，writeText 本就可写。
  // 必须在首次导航前 grant，否则 readText 会因权限被拒而抛错。
  test.beforeEach(async ({ context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    mkdirSync(ANNOT_DIR, { recursive: true });
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
    const panel = page.getByTestId('detail-panel');

    const systemItem = page.locator('[data-testid="context-item"][data-role="system"]');
    const userItem = page.locator('[data-testid="context-item"][data-role="user"]').first();
    const toolItem = page.locator('[data-testid="context-item"][data-role="tool"]').first();

    // ---------- Phase A：三类卡片各自复制 → 剪贴板 == 该段原文 ----------
    // 先把三次复制断言连续跑完（不开 overlay context，应用页保持焦点，clipboard 写入稳定）；
    // 标注截图放 Phase B，避免 overlay 新开 context 抢焦点导致后续复制失败。

    // ① 系统提示词：默认选中，右侧 N 张段卡片，每张一个复制按钮
    const segCards = page.locator('[data-testid="context-card"][data-kind="segment"]');
    await expect(segCards, '2 段 system 消息应渲染 2 张段卡片').toHaveCount(2);
    await expect(segCards.first().getByTestId('context-card-copy'), '每张段卡片各有 1 个复制按钮').toHaveCount(1);

    const segCardA = segCards.filter({ hasText: 'TAE110 system segment A' });
    await expect(segCardA).toHaveCount(1);
    await segCardA.getByTestId('context-card-copy').click();
    await expect(segCardA.getByTestId('context-card-copy')).toHaveText('已复制');
    expect(await readClipboard(page), '复制第 1 段：剪贴板应只含该段原文').toBe('TAE110 system segment A');

    // ② 对话历史：每个 content block 一张卡片、各自复制
    await userItem.click();
    const textCards = page.locator('[data-testid="context-card"][data-kind="text"]');
    await expect(textCards, '2 个 content block 应渲染 2 张文本卡片').toHaveCount(2);
    const blockTwo = textCards.filter({ hasText: 'TAE110 user block two' });
    await expect(blockTwo).toHaveCount(1);
    await blockTwo.getByTestId('context-card-copy').click();
    await expect(blockTwo.getByTestId('context-card-copy')).toHaveText('已复制');
    expect(await readClipboard(page), '复制第 2 个块：剪贴板只含该块，不含第 1 块').toBe('TAE110 user block two');

    // ③ 可用工具：每个工具描述一张卡片、各自复制
    await toolItem.click();
    const toolCards = page.locator('[data-testid="context-card"][data-kind="plain"]');
    await expect(toolCards, '工具描述应渲染 1 张卡片').toHaveCount(1);
    await toolCards.getByTestId('context-card-copy').click();
    await expect(toolCards.getByTestId('context-card-copy')).toHaveText('已复制');
    expect(await readClipboard(page), '复制工具描述：剪贴板应只含该工具描述').toBe('TAE110 list files tool description');

    // ---------- Phase B：带标注验收截图（overlay 在独立 context 渲染，不再有复制交互，焦点无关） ----------
    // 重新选回各类，截干净图 + 红框标注。
    await systemItem.click();
    await annotateCopyButton(page, panel, segCardA.getByTestId('context-card-copy'), '① 系统提示词段·复制按钮', join(ANNOT_DIR, '1-segment.png'));

    await userItem.click();
    await annotateCopyButton(page, panel, blockTwo.getByTestId('context-card-copy'), '② 对话历史·内容块·复制按钮', join(ANNOT_DIR, '2-text.png'));

    await toolItem.click();
    await annotateCopyButton(page, panel, toolCards.getByTestId('context-card-copy'), '③ 可用工具·描述·复制按钮', join(ANNOT_DIR, '3-tool.png'));
  });
});
