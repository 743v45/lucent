/**
 * 使用说明弹窗 UsageGuide 交互 spec（F4，TAE-59）
 *
 * 种子 spec（seed.spec.ts）已覆盖请求→日志→详情主流程。本 spec 补「使用说明」弹窗：
 * 自动生成的 export 接入命令是否正确——host:port 命中真实隔离端口、provider 路径前缀
 * （预设无前缀 / 自定义 custom/）、OpenAI 端点 /v1 后缀、chat+responses 去重。
 *
 * 两条用例：
 *  - 主流程：用隔离栈**真实** status（custom openai + openai-chat），点顶栏按钮打开弹窗 →
 *    断言渲染的命令命中真实隔离 host:port（取自 lucent.proxyBaseUrl，不写死）→ 复制到剪贴板 → 关闭。
 *  - 组合差异：用 page.route 喂一份覆盖「预设/自定义 × openai-chat/openai-responses/anthropic-messages」
 *    的 status（host:port 仍取真实隔离值），断言各组合下命令的差异——custom/ 前缀、/v1 后缀、
 *    OPENAI_BASE_URL vs ANTHROPIC_BASE_URL、同一供应商 chat+responses 去重为一条。
 *
 * 结构照抄 seed.spec.ts，复用 e2e/fixtures.ts 的 lucent fixture（隔离栈），不重造。
 * testid：本 issue 在 UsageGuide.tsx / App.tsx 最小新增 usage-guide / access-line / copy-cmd /
 * usage-guide-trigger（按交互最小必要补，不滥用）。
 *
 * 安全：弹窗只展示命令结构 + 隔离端口，不发请求、不碰真 key。
 */
import { test, expect } from './fixtures';
import type { LucentStack } from './fixtures';

/** 从隔离栈 proxyBaseUrl 解出真实 host:port（断言落到实际隔离值，不写死端口）。 */
function hostBase(lucent: LucentStack): string {
  const u = new URL(lucent.proxyBaseUrl);
  return `${u.protocol}//${u.host}`;
}

test.describe('使用说明弹窗 UsageGuide：自动生成 export 接入命令', () => {
  test('主流程：打开 → 命令含真实 host:port + custom/ + /v1 → 复制 → 关闭', async ({ page, lucent }) => {
    // 剪贴板：127.0.0.1 是安全上下文，writeText 可用；读回需要 clipboard-read 权限
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);

    const base = hostBase(lucent);
    // 隔离栈固定一个 custom provider「openai」+ openai-chat：
    //   export OPENAI_BASE_URL=http://127.0.0.1:<port>/custom/openai/v1
    const expectedCmd = `export OPENAI_BASE_URL=${base}/custom/openai/v1`;

    await page.goto(lucent.webBaseUrl);
    // 打开前弹窗不可见（antd Modal 首次未挂载；关闭后隐藏）
    await expect(page.getByTestId('usage-guide')).not.toBeVisible();

    // ① 点顶栏「使用说明」按钮打开弹窗（真实点击交互，非 URL 直跳）
    await page.getByTestId('usage-guide-trigger').click();
    await expect(page.getByTestId('usage-guide')).toBeVisible();

    // ② 断言渲染命令命中真实隔离 host:port + custom/ 前缀 + /v1 后缀（端口取自隔离栈，不写死）
    // 共享 fixture 现配了多个 custom OpenAI 供应商（openai + beta），按 openai 的路径精确锁定这一行
    const line = page.getByTestId('access-line').filter({ hasText: '/custom/openai/v1' });
    await expect(line).toBeVisible();
    const cmdText = (await line.textContent()) ?? '';
    expect(cmdText, '命令应含真实隔离 host:port').toContain(`${base}/custom/openai/v1`);
    expect(cmdText, '应为 OPENAI_BASE_URL 环境变量').toContain('OPENAI_BASE_URL');
    expect(cmdText, '自定义供应商应有 custom/ 前缀').toContain('/custom/openai');
    expect(cmdText, 'OpenAI 端点末尾应有 /v1').toMatch(/\/v1\b/);

    // ③ 复制命令：点 copy-cmd → 剪贴板内容 == 命令文本（localhost 安全上下文 + 已授权）
    await line.getByTestId('copy-cmd').click();
    await expect.poll(
      async () => page.evaluate(() => navigator.clipboard.readText()),
      { timeout: 5000, message: '剪贴板应含复制的 export 命令' },
    ).toBe(expectedCmd);

    // ④ 关闭弹窗（ESC；antd Modal 默认 keyboard:true）
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('usage-guide')).not.toBeVisible();
  });

  test('组合差异：预设/自定义 × chat/responses/anthropic 命令各不同，chat+responses 去重', async ({ page, lucent }) => {
    const base = hostBase(lucent);
    // 喂一份覆盖各组合的 status（host:port 仍取真实隔离值 → 命令断言落到实际隔离端口）
    const providers = [
      {
        id: 'p-anthropic', name: 'anthropic', presetName: 'anthropic',
        endpoints: { 'openai-chat': null, 'openai-responses': null, 'anthropic-messages': 'https://api.anthropic.com' },
      },
      {
        id: 'p-openai', name: 'openai', presetName: 'openai',
        endpoints: { 'openai-chat': 'https://api.openai.com/v1', 'openai-responses': 'https://api.openai.com/v1', 'anthropic-messages': null },
      },
      {
        id: 'p-glm', name: 'my-glm', presetName: null,
        endpoints: { 'openai-chat': 'https://open.bigmodel.cn', 'openai-responses': null, 'anthropic-messages': null },
      },
    ];
    await page.route('**/api/status', async (route) => {
      const u = new URL(lucent.proxyBaseUrl);
      await route.fulfill({
        status: 200,
        json: {
          enabled: true, running: true,
          host: u.hostname,
          webPort: 0, proxyPort: u.port,
          logFile: null, providers,
          logRecording: true, logRecordingEnvLocked: false,
        },
      });
    });

    await page.goto(lucent.webBaseUrl);
    await page.getByTestId('usage-guide-trigger').click();
    await expect(page.getByTestId('usage-guide')).toBeVisible();

    // 预设 anthropic（Claude Code 分组）：无 custom/、无 /v1、ANTHROPIC_BASE_URL
    const anthropicCmd = `export ANTHROPIC_BASE_URL=${base}/anthropic`;
    await expect(page.getByTestId('access-line').filter({ hasText: anthropicCmd })).toBeVisible();

    // 预设 openai：chat + responses 去重为「一条」OPENAI_BASE_URL 命令，/v1，无 custom/
    const openaiCmd = `export OPENAI_BASE_URL=${base}/openai/v1`;
    const openaiLine = page.getByTestId('access-line').filter({ hasText: openaiCmd });
    await expect(openaiLine).toBeVisible();
    expect(await openaiLine.count(), '同一供应商 chat+responses 应去重为一条命令，不是两条').toBe(1);

    // 自定义 my-glm（Codex / OpenAI 分组）：custom/ 前缀、/v1
    const glmCmd = `export OPENAI_BASE_URL=${base}/custom/my-glm/v1`;
    await expect(page.getByTestId('access-line').filter({ hasText: glmCmd })).toBeVisible();

    // 汇总校验：自定义命令必含 custom/，预设两条命令都不含
    const allCmds = (await page.getByTestId('access-line').allInnerTexts()).join('\n');
    expect(allCmds, '自定义 my-glm 命令应含 custom/').toContain('/custom/my-glm');
    expect(allCmds, '预设 anthropic 命令不应含 custom/').toContain(`${base}/anthropic`);
    expect(allCmds, '预设 openai 命令不应含 custom/').toContain(`${base}/openai/v1`);
    expect(allCmds, 'anthropic 端点不应有 /v1').not.toContain(`${base}/anthropic/v1`);
  });
});
