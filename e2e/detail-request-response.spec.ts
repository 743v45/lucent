/**
 * 详情面板 Request/Response Tab 交互 spec（F2，TAE-58）
 *
 * 种子 spec（seed.spec.ts）已覆盖 chat-sse 主流程：点 log-row → detail-panel →
 * 默认 Request tab → 切 Response tab 渲染 SSE 原始流。本 spec 补种子没碰的
 * **多模式 + 边界**：
 *
 *  - chat-json（非 SSE）模式 Response tab 渲染断言，对照 chat-sse（不应出现 SSE chunk 标记）。
 *  - JSON 视图 expand-all ↔ collapse-all 折叠/展开交互（默认折叠到 level 2，全展开后深层键可见）。
 *  - 边界：空 response body、错误响应（4xx/5xx）下 detail 面板不崩。
 *
 * 结构照抄 seed.spec.ts，复用 e2e/fixtures.ts 的 lucent fixture（隔离栈），不重造。
 * testid 一律复用现有契约：log-row / detail-panel / detail-empty / request-body /
 * response-body / tab-${key} / expand-all / collapse-all，不新增。
 */
import { test, expect } from './fixtures';
import type { LucentStack } from './fixtures';
import type { Page } from '@playwright/test';
import type { OpenAIResponseMode } from '../tests/e2e-helpers';

// mock key，绝不硬编码真 key（task 安全要求）。代理只转发明文，不校验 key。
const OAI_HEADERS = { authorization: 'Bearer sk-mock-ui-e2e' };
const REQ_BODY = {
  model: 'gpt-4o',
  max_tokens: 1,
  messages: [{ role: 'user', content: 'ping' }],
};

/**
 * 切上游模式 → 发请求穿代理 → 等日志落盘 → 返回代理响应 + 最新日志 id。
 * 非流式模式（chat-json / error-* / empty）的日志在 handleNormalResponse 里同步写盘，
 * 但仍按种子 spec 的套路轮询确认，避免时序假设。
 */
async function postAndAwaitLog(
  lucent: LucentStack,
  mode: OpenAIResponseMode,
  path = '/openai/v1/chat/completions',
): Promise<{ status: number; body: string; logId: string }> {
  lucent.upstream.reset();
  lucent.upstream.setMode(mode);
  // worker-scoped 单栈下日志跨用例累积：不能只等「有日志」——既有日志会让 poll 当场通过、
  // 读到上一条的 id（实测 ~14% 概率点开错误的行：4xx 用例点到上一条 200）。记下发请求前
  // 已知的同类日志 id，轮询到出现「新的」id 再取，保证取到的就是本次请求的日志。
  const knownIds = new Set(
    (await lucent.readLogEntries())
      .filter((e) => e.providerName === 'openai' && e.endpointType === 'openai-chat')
      .map((e) => e.id),
  );
  const res = await lucent.postThroughProxy(path, OAI_HEADERS, REQ_BODY);
  await expect
    .poll(
      async () => {
        const id = await lucent.latestLogId('openai', 'openai-chat');
        return id && !knownIds.has(id) ? id : false;
      },
      { timeout: 5000, message: '新日志应落盘（区分于既有累积日志）' },
    )
    .toBeTruthy();
  const logId = await lucent.latestLogId('openai', 'openai-chat');
  if (!logId) throw new Error('postAndAwaitLog: 未取到日志 id');
  return { status: res.status, body: res.body, logId };
}

/** 打开 Web UI，点开指定 log 的详情面板（停在默认 Request tab），返回详情面板定位器。 */
async function openDetail(page: Page, lucent: LucentStack, logId: string) {
  await page.goto(lucent.webBaseUrl);
  // 等自己的 log-row 出现（UI 初始加载最新 50 条，本条必在其中）再点
  const row = page.locator(`[data-testid="log-row"][data-logid="${logId}"]`);
  await expect(row).toBeVisible({ timeout: 10_000 });
  await row.click();
  const panel = page.getByTestId('detail-panel');
  await expect(panel).toBeVisible();
  return panel;
}

test.describe('详情面板 Request/Response Tab：多模式 + 边界', () => {
  test('chat-json 模式：Response tab 渲染非流式 completion，区别于 chat-sse', async ({ page, lucent }) => {
    const { logId } = await postAndAwaitLog(lucent, 'chat-json');
    await openDetail(page, lucent, logId);

    // 默认 Request tab 渲染请求体（确认详情真打开）
    await expect(page.getByTestId('request-body')).toBeVisible();

    // 切 Response tab：非流式 chat.completion 走 JSON 视图（JsonBlock）
    await page.getByTestId('tab-response').click();
    const responseBody = page.getByTestId('response-body');
    await expect(responseBody).toBeVisible();
    const respText = (await responseBody.textContent()) ?? '';

    // chat-json body 顶层可见标识（root + level 1 默认展开）：object=chat.completion、system_fingerprint
    expect(respText, '应渲染 chat.completion 对象').toContain('chat.completion');
    expect(respText, 'chat-json 独有 system_fingerprint 应可见').toContain('fp_e2e');
    // 对照 chat-sse：非流式不应出现 SSE chunk / data 帧
    expect(respText, '非 SSE 模式不应有 chat.completion.chunk').not.toContain('chat.completion.chunk');
    expect(respText, '非 SSE 模式不应有 data: 帧').not.toContain('data:');
  });

  test('JSON 视图：expand-all ↔ collapse-all 折叠/展开深层节点', async ({ page, lucent }) => {
    const { logId } = await postAndAwaitLog(lucent, 'chat-json');
    await openDetail(page, lucent, logId);
    await page.getByTestId('tab-response').click();
    const responseBody = page.getByTestId('response-body');
    await expect(responseBody).toBeVisible();

    // chat-json 的 choices[0].message.refusal 是深层键（level ≥ 3）。
    // react-json-view-lite 折叠时直接卸载子节点（渲染空 collapsedContent span），
    // 所以默认折叠（level < 2 展开）下 refusal 计数为 0。
    const refusal = responseBody.getByText('refusal');

    // 默认折叠态：expand-all 按钮在，refusal 不可见
    await expect(page.getByTestId('expand-all')).toBeVisible();
    await expect(refusal).toHaveCount(0);

    // 点 expand-all → 全展开：按钮转 collapse-all，深层键 refusal 出现
    await page.getByTestId('expand-all').click();
    await expect(page.getByTestId('collapse-all')).toBeVisible();
    await expect(refusal).toBeVisible();

    // 点 collapse-all → 回折叠：按钮转 expand-all，refusal 再次消失
    await page.getByTestId('collapse-all').click();
    await expect(page.getByTestId('expand-all')).toBeVisible();
    await expect(refusal).toHaveCount(0);
  });

  test('边界：4xx 错误响应，detail 面板不崩，头部显示错误状态 + Response 渲染错误体', async ({ page, lucent }) => {
    const { status, logId } = await postAndAwaitLog(lucent, 'error-400');
    expect(status, '代理应透传上游 400').toBe(400);

    const panel = await openDetail(page, lucent, logId);
    // 面板渲染不崩
    await expect(panel).toBeVisible();
    // 头部状态徽标显示 400
    const headerText = (await panel.textContent()) ?? '';
    expect(headerText, '头部应显示 400 状态码').toContain('400');

    // Response tab 渲染上游错误体（OpenAI error 对象）
    await page.getByTestId('tab-response').click();
    const responseBody = page.getByTestId('response-body');
    await expect(responseBody).toBeVisible();
    const respText = (await responseBody.textContent()) ?? '';
    expect(respText, '应渲染错误体含 error 字段').toContain('error');
  });

  test('边界：5xx 错误响应，detail 面板不崩，头部显示错误状态 + Response 渲染错误体', async ({ page, lucent }) => {
    const { status, logId } = await postAndAwaitLog(lucent, 'error-500');
    expect(status, '代理应透传上游 500').toBe(500);

    const panel = await openDetail(page, lucent, logId);
    await expect(panel).toBeVisible();
    const headerText = (await panel.textContent()) ?? '';
    expect(headerText, '头部应显示 500 状态码').toContain('500');

    await page.getByTestId('tab-response').click();
    const responseBody = page.getByTestId('response-body');
    await expect(responseBody).toBeVisible();
    const respText = (await responseBody.textContent()) ?? '';
    expect(respText, '应渲染错误体含 error 字段').toContain('error');
  });

  test('边界：空 response body，detail 面板不崩', async ({ page, lucent }) => {
    const { status, logId } = await postAndAwaitLog(lucent, 'empty');
    expect(status, '代理应透传上游 200').toBe(200);

    const panel = await openDetail(page, lucent, logId);
    // 面板渲染不崩
    await expect(panel).toBeVisible();

    // Response tab：空 body 不应让面板崩（走 JsonBlock 空内容或无响应体态）
    await page.getByTestId('tab-response').click();
    await expect(page.getByTestId('response-body')).toBeVisible();
  });
});
