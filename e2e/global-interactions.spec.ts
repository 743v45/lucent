/**
 * 顶栏与全局交互 spec（F-全局，TAE-60）
 *
 * 覆盖 src/App.tsx 顶栏 + 全局交互的 4 个面（照抄 seed.spec.ts 结构，复用
 * e2e/fixtures.ts 的 lucent 隔离栈，不重造）：
 *
 *  - 刷新按钮：loadLogs 重新拉日志（SSE 接通后刷新仍作为全量对齐兜底，新请求平时靠推送自动进列表）。
 *  - URL 同步：选中日志 + 切 tab 写入 URL（log/tab 参数），reload 仍恢复到同一日志同一 tab；
 *    默认 tab 不带 tab 参数。
 *  - 侧栏拖拽调宽：真实鼠标事件拖 sidebar-splitter → 宽度随 clientX 变化 + min/max 钳制
 *    + 松手存 localStorage + reload 恢复。
 *  - 实时推送（SSE 已接通）：连发第二条请求，日志落库后经 sse-bus 广播，前端 EventSource
 *    收到自动进列表，无需手动刷新。不合当前 provider/endpoint 筛选的会被前端丢弃。
 *
 * testid 仅按交互最小必要补：refresh-btn / sidebar-splitter / log-list-panel，其余复用现有契约。
 */
import { test, expect } from './fixtures';
import type { LucentStack } from './fixtures';
import type { OpenAIResponseMode } from '../tests/e2e-helpers';

// mock key，绝不硬编码真 key（task 安全要求）。代理只转发明文，不校验 key。
const OAI_HEADERS = { authorization: 'Bearer sk-mock-ui-e2e' };
const REQ_BODY = {
  model: 'gpt-4o',
  max_tokens: 1,
  messages: [{ role: 'user', content: 'global-interactions probe' }],
};

/** 取面板当前渲染宽度（px）。style={{ width }} + border-box，boundingBox 宽即 sidebarWidth。 */
async function panelWidth(page: import('@playwright/test').Page): Promise<number> {
  const box = await page.getByTestId('log-list-panel').boundingBox();
  if (!box) throw new Error('log-list-panel 没有 boundingBox');
  return box.width;
}

/**
 * 切上游模式 → 发请求穿代理 → 等一条「新的」日志落库并返回 id。
 * worker-scoped 单栈下日志跨用例累积：必须记下发请求前已知的 id，轮询到出现「新」id 再取，
 * 否则会拿到上一条累积日志的 id（detail spec 实测过这个坑）。
 */
async function postNewLog(
  lucent: LucentStack,
  mode: OpenAIResponseMode = 'chat-sse',
  path = '/openai/v1/chat/completions',
): Promise<string> {
  lucent.upstream.reset();
  lucent.upstream.setMode(mode);
  const known = new Set(
    (await lucent.readLogEntries())
      .filter((e) => e.providerName === 'openai' && e.endpointType === 'openai-chat')
      .map((e) => e.id),
  );
  const res = await lucent.postThroughProxy(path, OAI_HEADERS, REQ_BODY);
  expect(res.status, `代理应回 200，实际 ${res.status}`).toBe(200);
  let id: string | undefined;
  await expect
    .poll(
      async () => {
        id = await lucent.latestLogId('openai', 'openai-chat');
        return id && !known.has(id) ? id : false;
      },
      { timeout: 5000, message: '新日志应落库（区分于既有累积日志）' },
    )
    .toBeTruthy();
  return id as string;
}

/** 真实鼠标拖拽 sidebar-splitter 到目标 viewport x；宽度 = clamp(clientX)（见 App.tsx handleMouseMove）。 */
async function dragSplitterTo(page: import('@playwright/test').Page, targetX: number): Promise<void> {
  const splitter = page.getByTestId('sidebar-splitter');
  const box = await splitter.boundingBox();
  if (!box) throw new Error('sidebar-splitter 没有 boundingBox');
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width / 2, y);
  await page.mouse.down();
  // steps 让中间 mousemove 连续触发，document 上的全局 mousemove 监听才跟得上
  await page.mouse.move(targetX, y, { steps: 20 });
  await page.mouse.up();
}

test.describe('顶栏与全局交互：刷新 / URL 同步 / 侧栏拖拽 / 实时推送', () => {
  test('刷新按钮：点 refresh-btn 重新拉首页对齐，已有日志不丢', async ({ page, lucent }) => {
    // 第一条先就位，UI 加载它
    const id1 = await postNewLog(lucent);
    await page.goto(lucent.webBaseUrl);
    await expect(page.locator(`[data-testid="log-row"][data-logid="${id1}"]`)).toBeVisible({
      timeout: 10_000,
    });

    // id2 落库（SSE 接通后会自动进列表）；refresh-btn 作为全量对齐兜底——点后重新拉首页，id1/id2 都在
    const id2 = await postNewLog(lucent);
    const refresh = page.getByTestId('refresh-btn');
    await expect(refresh).toBeEnabled();
    await refresh.click();
    await expect(page.locator(`[data-testid="log-row"][data-logid="${id1}"]`)).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.locator(`[data-testid="log-row"][data-logid="${id2}"]`)).toBeVisible({
      timeout: 10_000,
    });
  });

  test('URL 同步：选中日志 + 切 tab 写入 URL，reload 恢复到同一日志同一 tab；默认 tab 不带参数', async ({
    page,
    lucent,
  }) => {
    const id = await postNewLog(lucent);
    await page.goto(lucent.webBaseUrl);
    const row = page.locator(`[data-testid="log-row"][data-logid="${id}"]`);
    await expect(row).toBeVisible({ timeout: 10_000 });

    // 选中 → URL 带 log=<id>，detail 面板渲染
    await row.click();
    await expect(page.getByTestId('detail-panel')).toBeVisible();
    expect(new URL(page.url()).searchParams.get('log'), 'URL 应带 log=<id>').toBe(id);
    // 默认 tab（request）不应写入 tab 参数
    expect(new URL(page.url()).searchParams.has('tab'), '默认 tab 不应带 tab 参数').toBe(false);

    // 切到 Response tab（非默认）→ URL 带 tab=response
    await page.getByTestId('tab-response').click();
    await expect(page.getByTestId('response-body')).toBeVisible();
    expect(new URL(page.url()).searchParams.get('tab'), '切 Response 后 URL 应带 tab=response').toBe(
      'response',
    );

    // reload → 同一日志 + 同一 tab 恢复
    await page.reload();
    await expect(page.getByTestId('detail-panel')).toBeVisible();
    await expect(page.getByTestId('response-body')).toBeVisible();
    expect(new URL(page.url()).searchParams.get('log'), 'reload 后 URL 仍是同一 log').toBe(id);
    expect(new URL(page.url()).searchParams.get('tab'), 'reload 后 URL 仍是 tab=response').toBe(
      'response',
    );

    // 切回默认 Request tab → URL 去掉 tab 参数
    await page.getByTestId('tab-request').click();
    await expect(page.getByTestId('request-body')).toBeVisible();
    expect(new URL(page.url()).searchParams.has('tab'), '切回默认 tab 应去掉 tab 参数').toBe(false);
    expect(new URL(page.url()).searchParams.get('log'), 'log 参数应保留').toBe(id);
  });

  test('侧栏拖拽调宽：拖 splitter 改宽 + min/max 钳制 + localStorage 持久化 + reload 恢复', async ({
    page,
    lucent,
  }) => {
    await postNewLog(lucent); // 只为让列表有内容、首屏稳定
    await page.goto(lucent.webBaseUrl);
    await expect(page.getByTestId('log-row').first()).toBeVisible({ timeout: 10_000 });

    const MIN = 200;
    const MAX = 700;
    const DEFAULT = 300;
    const TOL = 3; // border / 亚像素容差

    // 初始默认宽度 300（新 context，localStorage 空）
    await expect.poll(() => panelWidth(page), { timeout: 5000 }).toBeCloseTo(DEFAULT, 0);

    // 拖到 x=520 → 宽度变 520（增大）
    await dragSplitterTo(page, 520);
    await expect.poll(() => panelWidth(page), { timeout: 5000 }).toBeCloseTo(520, 0);
    // 松手存 localStorage（key=logListWidth，见 constants.ts STORAGE_KEY_SIDEBAR_WIDTH）
    await expect
      .poll(
        async () => page.evaluate(() => localStorage.getItem('logListWidth')),
        { timeout: 5000, message: '拖拽后宽度应写入 localStorage' },
      )
      .toBe('520');

    // 钳制上界：拖到 x=2000 → 宽度封顶 700
    await dragSplitterTo(page, 2000);
    await expect.poll(() => panelWidth(page), { timeout: 5000 }).toBeLessThanOrEqual(MAX + TOL);
    await expect.poll(() => panelWidth(page), { timeout: 5000 }).toBeGreaterThanOrEqual(MAX - TOL);

    // 钳制下界：拖到 x=10 → 宽度封底 200
    await dragSplitterTo(page, 10);
    await expect.poll(() => panelWidth(page), { timeout: 5000 }).toBeLessThanOrEqual(MIN + TOL);
    await expect.poll(() => panelWidth(page), { timeout: 5000 }).toBeGreaterThanOrEqual(MIN - TOL);

    // 把宽度定回一个明确值（520），验证 reload 恢复
    await dragSplitterTo(page, 520);
    await expect.poll(() => panelWidth(page), { timeout: 5000 }).toBeCloseTo(520, 0);
    await page.reload();
    await expect(page.getByTestId('log-row').first()).toBeVisible({ timeout: 10_000 });
    await expect.poll(() => panelWidth(page), { timeout: 5000 }).toBeCloseTo(520, 0);
  });

  test('实时推送（SSE 已接通）：连发第二条请求，日志落库后自动进列表，无需刷新', async ({ page, lucent }) => {
    // 第一条：UI 已加载它（goto 后 EventSource 也随之建立连接）
    const id1 = await postNewLog(lucent);
    await page.goto(lucent.webBaseUrl);
    await expect(page.locator(`[data-testid="log-row"][data-logid="${id1}"]`)).toBeVisible({
      timeout: 10_000,
    });
    // 等 EventSource 完成握手（connected）后再发第二条，避免广播早于客户端注册而丢失
    await page.waitForTimeout(1000);

    // 第二条：发出去并落库 → LogWriter 经 sse-bus 广播 → 前端 EventSource 收到自动进列表
    const id2 = await postNewLog(lucent);
    await expect(
      page.locator(`[data-testid="log-row"][data-logid="${id2}"]`),
      'SSE 已接通：第二条应自动出现在列表（无需刷新）',
    ).toBeVisible({ timeout: 10_000 });
  });
});
