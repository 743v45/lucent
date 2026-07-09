/**
 * 供应商设置（SettingsModal 全流程）交互 e2e —— F4
 *
 * 覆盖 TAE-51 的判断要点逐条交互断言：
 *  - 预设：选预设供应商网格 → 落地到列表。
 *  - 自定义：填名称创建 → 编辑端点（baseUrl）→ 失焦自动保存 → config 落盘 + 刷新仍在。
 *  - 测试连接：mock 上游可控回 200 / 500，成功显示 ms、失败显示信息。
 *  - 删除：二次确认（window.confirm）→ 列表移除 + config 同步删。
 *
 * 复用 e2e/fixtures.ts 的 lucent fixture（隔离栈：mock 上游 + 临时 config + 随机端口
 * + 起 backend + vite dev），不重造隔离栈。测试连接的目标 baseUrl 指向 mock 上游
 * lucent.upstream，绝不连真 API；header 只用 Bearer sk-mock-* 假 token。
 *
 * testid 约定见 openspec/specs/ui-e2e-verification（settings-modal / provider-row /
 * endpoint-input / test-connection-btn / delete-provider-btn 等）。
 */
import { test, expect } from './fixtures';

/** 假 token，绝不硬编码真 key（task 安全要求）。测试连接只验可达性，后端不校验 key。 */
const MOCK_UPSTREAM_BASE = (port: number) => `http://127.0.0.1:${port}/v1`;

/**
 * 取某 provider 的完整配置（经 vite /api 代理到后端）。
 * 用于校验「config 落盘」——UI 点保存后，后端 config.json 是否真的写进去了。
 */
async function getProviderFull(page: import('@playwright/test').Page, name: string) {
  return page.evaluate(async (n) => {
    const r = await fetch(`/api/providers/${encodeURIComponent(n)}/full`, { headers: { accept: 'application/json' } });
    return r.json();
  }, name);
}

test.describe('供应商设置（SettingsModal 全流程）', () => {
  test('预设供应商：网格一键添加 → 落地列表 + 落盘', async ({ page, lucent }) => {
    await page.goto(lucent.webBaseUrl);
    // 打开 SettingsModal
    await page.getByTestId('settings-open-btn').click();
    await expect(page.getByTestId('settings-modal')).toBeVisible();

    // 列表初始只有种子 openai（worker-scoped 栈，别的 spec 不动 provider）
    const beforeCount = await page.getByTestId('provider-row').count();

    // 点「新增供应商」进预设面板
    await page.getByTestId('add-provider-btn').click();
    // 选一个未添加的预设（groq 属 community，初始未添加）
    const groqPreset = page.locator('[data-testid="preset-item"][data-name="groq"]');
    await expect(groqPreset).toBeVisible();
    await groqPreset.click();

    // 落地：列表多出一行 groq
    const groqRow = page.locator('[data-testid="provider-row"][data-name="groq"]');
    await expect(groqRow).toBeVisible({ timeout: 10_000 });
    expect(await page.getByTestId('provider-row').count(), '预设添加后列表 +1').toBe(beforeCount + 1);

    // 落盘：后端 config 真的写了 groq（openai-chat 端点带预设默认 URL）
    const full = await getProviderFull(page, 'groq');
    expect(full.name, 'config 落盘：groq 已写入').toBe('groq');
    expect(full.endpoints['openai-chat'], 'groq 预设 openai-chat 端点已落盘').toBeTruthy();
  });

  test('自定义供应商：创建 → 编辑端点 → 失焦自动保存 → 落盘 + 刷新仍在', async ({ page, lucent }) => {
    const name = 'acmetest';
    const upstreamUrl = MOCK_UPSTREAM_BASE(lucent.upstream.port);

    await page.goto(lucent.webBaseUrl);
    await page.getByTestId('settings-open-btn').click();
    await expect(page.getByTestId('settings-modal')).toBeVisible();

    // 进预设面板 → 展开「自定义供应商」输入
    await page.getByTestId('add-provider-btn').click();
    await page.getByTestId('show-custom-input-btn').click();
    const nameInput = page.getByTestId('custom-name-input');
    await expect(nameInput).toBeVisible();
    await nameInput.fill(name);
    await page.getByTestId('custom-confirm-btn').click();

    // 落地：列表多出 acmetest（落在「我的」自定义分组），且创建后自动展开编辑器
    const row = page.locator('[data-testid="provider-row"][data-name="' + name + '"]');
    await expect(row).toBeVisible({ timeout: 10_000 });

    // 编辑 openai-chat 端点：填 baseUrl → 失焦触发自动保存
    const chatInput = page.locator('[data-testid="endpoint-input"][data-protocol="openai-chat"]');
    await expect(chatInput).toBeVisible();
    await chatInput.fill(upstreamUrl);
    await chatInput.blur();

    // 落盘：后端 config 写入该端点（PUT 失焦自动保存生效）
    await expect.poll(
      async () => (await getProviderFull(page, name)).endpoints?.['openai-chat'],
      { timeout: 10_000, message: '失焦自动保存应把 openai-chat 端点写进 config' },
    ).toBe(upstreamUrl);

    // 刷新仍在：reload 后端从磁盘重读 config，端点值依旧在（不是只在内存里）。
    // 同时验「列表刷新生效」——重开后 acmetest 行仍在列表里。
    await page.reload();
    await page.getByTestId('settings-open-btn').click();
    await expect(page.getByTestId('settings-modal')).toBeVisible();
    await expect(page.locator('[data-testid="provider-row"][data-name="' + name + '"]'), '刷新后列表仍有该供应商').toBeVisible({ timeout: 10_000 });
    await expect.poll(
      async () => (await getProviderFull(page, name)).endpoints?.['openai-chat'],
      { timeout: 10_000, message: '刷新后端点值应依旧落盘' },
    ).toBe(upstreamUrl);
  });

  test('测试连接：mock 上游回 200 成功 / 回 500 失败', async ({ page, lucent }) => {
    const name = 'conntest';
    const upstreamUrl = MOCK_UPSTREAM_BASE(lucent.upstream.port);

    await page.goto(lucent.webBaseUrl);
    await page.getByTestId('settings-open-btn').click();
    await expect(page.getByTestId('settings-modal')).toBeVisible();

    // 建一个自定义供应商并配上指向 mock 上游的 openai-chat 端点
    await page.getByTestId('add-provider-btn').click();
    await page.getByTestId('show-custom-input-btn').click();
    await page.getByTestId('custom-name-input').fill(name);
    await page.getByTestId('custom-confirm-btn').click();
    await expect(page.locator('[data-testid="provider-row"][data-name="' + name + '"]')).toBeVisible({ timeout: 10_000 });

    const chatInput = page.locator('[data-testid="endpoint-input"][data-protocol="openai-chat"]');
    await chatInput.fill(upstreamUrl);
    await chatInput.blur();
    // 等自动保存落盘（测试连接读的是 config，不是内存表单）
    await expect.poll(
      async () => (await getProviderFull(page, name)).endpoints?.['openai-chat'],
      { timeout: 10_000 },
    ).toBe(upstreamUrl);

    const testBtn = page.locator('[data-testid="test-connection-btn"][data-protocol="openai-chat"]');
    const result = page.locator('[data-testid="test-result"][data-protocol="openai-chat"]');

    // 成功：mock 上游回 chat-json(200)，后端测连接判 <500 = 可达
    lucent.upstream.setMode('chat-json');
    await testBtn.click();
    await expect(result).toHaveAttribute('data-ok', 'true', { timeout: 10_000 });
    await expect(result).toContainText(/ms/);

    // 失败：mock 上游回 error-500，后端判 >=500 = 不可达
    lucent.upstream.setMode('error-500');
    await testBtn.click();
    await expect(result).toHaveAttribute('data-ok', 'false', { timeout: 10_000 });
    await expect(result).toContainText(/500/);
  });

  test('删除供应商：二次确认 → 列表移除 + config 同步删', async ({ page, lucent }) => {
    const name = 'delme';
    await page.goto(lucent.webBaseUrl);
    await page.getByTestId('settings-open-btn').click();
    await expect(page.getByTestId('settings-modal')).toBeVisible();

    // 先建一个待删供应商
    await page.getByTestId('add-provider-btn').click();
    await page.getByTestId('show-custom-input-btn').click();
    await page.getByTestId('custom-name-input').fill(name);
    await page.getByTestId('custom-confirm-btn').click();
    const row = page.locator('[data-testid="provider-row"][data-name="' + name + '"]');
    await expect(row).toBeVisible({ timeout: 10_000 });
    const beforeCount = await page.getByTestId('provider-row').count();

    // 删除触发 window.confirm —— Playwright 默认会自动 dismiss，这里显式 accept 走「确认删除」。
    // handler 里只记录信息 + accept，不做断言（断言放 handler 外，避免抛错卡住未 dismiss 的弹窗）。
    const dialogInfo: Array<{ type: string; message: string }> = [];
    page.on('dialog', async (d) => {
      dialogInfo.push({ type: d.type(), message: d.message() });
      await d.accept();
    });
    // 删除按钮要精确落在目标供应商的行内（否则会点到列表第一行 openai 的删除按钮）
    await page.locator('[data-testid="provider-row"][data-name="' + name + '"] [data-testid="delete-provider-btn"]').click();

    // 列表移除：行消失、总数 -1
    await expect(row, '删除后该行应从列表移除').toHaveCount(0, { timeout: 10_000 });
    expect(await page.getByTestId('provider-row').count(), '删除后列表 -1').toBe(beforeCount - 1);
    expect(dialogInfo.length, '删除前应弹过二次确认').toBeGreaterThanOrEqual(1);
    expect(dialogInfo[0].type, '应是 confirm 类型弹窗').toBe('confirm');
    expect(dialogInfo[0].message, '确认文案应含供应商名').toContain(name);

    // config 同步删：后端已无该 provider（404）
    const after = await page.evaluate(async (n) => {
      const r = await fetch(`/api/providers/${encodeURIComponent(n)}/full`);
      return r.status;
    }, name);
    expect(after, '删除后后端 config 应已无该 provider').toBe(404);
  });
});
