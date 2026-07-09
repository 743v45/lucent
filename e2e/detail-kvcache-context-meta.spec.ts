/**
 * 详情面板 KV-Cache / Context / Meta Tab 交互 spec（F3，TAE-62）
 *
 * 种子 spec（seed.spec.ts）覆盖 Request/Response tab；detail-request-response.spec.ts
 * 补了 Response 的多模式 + 边界。本 spec 补剩下三个 tab 的交互：KV-Cache / Context / Meta。
 *
 * 覆盖（按功能 issue TAE-50 判断要点，以功能改完后的实际行为为准）：
 *  - KV-Cache tab：命中态渲染（Anthropic 显式缓存：命中率大数字 + 堆叠条 + 块级「命中」标签），
 *    以及无缓存请求的空态。
 *  - Context tab：context-item 渲染上下文条目 + 统计卡 + 选中项右侧出详情。
 *  - Meta tab：渲染元信息（模型 / 端点协议 / 耗时 / 流式 / token）。
 *  - 三 tab 切换各自正确渲染、互不串内容。
 *
 * 数据来源说明（不瞎编）：OpenAI 自动缓存的 cache 命中走不进 KV-Cache tab——经实测
 * buildContextFromRequest 归一化 SSE usage 时丢掉 prompt_tokens_details.cached_tokens，
 * OpenAI 请求在 KV-Cache tab 恒为空态。所以「命中态」用 Anthropic 显式缓存构造
 * （body 带 cache_control + usage 带 cache_read），这是 detail 面板块级渲染唯一能命中的路径，
 * 由共享 mock 上游新增的 sse-hit mode 造出。空态用 OpenAI chat-sse（cached_tokens=0）。
 *
 * 结构照抄 seed.spec.ts，复用 e2e/fixtures.ts 的 lucent fixture（隔离栈），不重造。
 * testid 一律复用现有契约：log-row / detail-panel / tab-${key} / context-item，不新增。
 */
import { test, expect } from './fixtures';
import type { LucentStack } from './fixtures';
import type { Page } from '@playwright/test';
import type { AnthropicResponseMode, OpenAIResponseMode } from '../tests/e2e-helpers';

// mock key，绝不硬编码真 key（task 安全要求）。代理只转发明文，不校验 key。
const OAI_HEADERS = { authorization: 'Bearer sk-mock-ui-e2e' };
const ANTH_HEADERS = { 'x-api-key': 'sk-mock-ui-e2e', 'anthropic-version': '2023-06-01' };

// KV-Cache 命中态请求体：system / message / tool 各带 cache_control 标记（块级渲染的前提），
// 多轮对话造出 Context 的统计 + 分组。
const ANTH_BODY_WITH_CACHE = {
  model: 'claude-sonnet-4-20250514',
  max_tokens: 64,
  system: [{ type: 'text', text: 'You are a helpful assistant.', cache_control: { type: 'ephemeral' } }],
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'Remember the secret code 42.', cache_control: { type: 'ephemeral' } }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Got it.' }] },
    { role: 'user', content: [{ type: 'text', text: 'What was the code?' }] },
  ],
  tools: [{
    name: 'bash', description: 'Run a shell command.',
    input_schema: { type: 'object', properties: { command: { type: 'string' } } },
    cache_control: { type: 'ephemeral' },
  }],
};

// OpenAI 富 Context 请求体：system 消息 + 多轮 + tools，造出 Context 统计卡 + 三个分组。
const OAI_BODY_RICH_CONTEXT = {
  model: 'gpt-4o',
  max_tokens: 1,
  messages: [
    { role: 'system', content: 'You are a concise coding assistant.' },
    { role: 'user', content: 'List files.' },
    { role: 'assistant', content: 'I would run ls.' },
    { role: 'user', content: 'Do it.' },
  ],
  tools: [{ type: 'function', function: { name: 'list_files', description: 'List files in cwd' } }],
};

/** 切上游模式 → 发请求穿代理 → 等新日志落库 → 返回最新日志 id。
 *  worker-scoped 单栈下日志跨用例累积，故记下发请求前已知的同类 id，轮询到「新的」id 再取。 */
async function postAndAwaitLog(
  lucent: LucentStack,
  opts: {
    upstream: 'openai' | 'anthropic';
    mode: OpenAIResponseMode | AnthropicResponseMode;
    path: string;
    headers: Record<string, string>;
    body: unknown;
    provider: string;
    endpoint: string;
  },
): Promise<string> {
  const up = opts.upstream === 'anthropic' ? lucent.upstreamAnthropic : lucent.upstream;
  up.reset();
  up.setMode(opts.mode);
  const knownIds = new Set(
    (await lucent.readLogEntries())
      .filter((e) => e.providerName === opts.provider && e.endpointType === opts.endpoint)
      .map((e) => e.id),
  );
  await lucent.postThroughProxy(opts.path, opts.headers, opts.body);
  await expect
    .poll(
      async () => {
        const id = await lucent.latestLogId(opts.provider, opts.endpoint);
        return id && !knownIds.has(id) ? id : false;
      },
      { timeout: 5000, message: '新日志应落库（区分于既有累积日志）' },
    )
    .toBeTruthy();
  const logId = await lucent.latestLogId(opts.provider, opts.endpoint);
  if (!logId) throw new Error('postAndAwaitLog: 未取到日志 id');
  return logId;
}

/** 打开 Web UI，点开指定 log 的详情面板，停在默认 Request tab。 */
async function openDetail(page: Page, lucent: LucentStack, logId: string) {
  await page.goto(lucent.webBaseUrl);
  const row = page.locator(`[data-testid="log-row"][data-logid="${logId}"]`);
  await expect(row).toBeVisible({ timeout: 10_000 });
  await row.click();
  const panel = page.getByTestId('detail-panel');
  await expect(panel).toBeVisible();
  return panel;
}

test.describe('详情面板 KV-Cache / Context / Meta Tab', () => {
  test('KV-Cache tab：Anthropic 显式缓存命中态渲染（命中率 + 块级「命中」）', async ({ page, lucent }) => {
    const logId = await postAndAwaitLog(lucent, {
      upstream: 'anthropic', mode: 'sse-hit',
      path: '/anthropic/v1/messages', headers: ANTH_HEADERS, body: ANTH_BODY_WITH_CACHE,
      provider: 'anthropic', endpoint: 'anthropic-messages',
    });
    await openDetail(page, lucent, logId);

    // 切 KV-Cache tab
    await page.getByTestId('tab-kvcache').click();

    // 显式缓存模式徽标（KV-Cache tab 独有；头部 token 卡只显 read/create 数字，不显模式徽标）
    await expect(page.getByText('显式缓存')).toBeVisible();
    // 块级分组渲染：系统提示词分组标题（kvcache tab 上唯一——Context tab 未挂载，不与右侧详情标题撞）
    await expect(page.getByText('系统提示词')).toBeVisible();
    // 块带「命中」标签（kind=hit，仅 cache_read 命中且命中率≥70 才标；多处出现取首个）
    await expect(page.getByText('命中', { exact: true }).first()).toBeVisible();
  });

  test('KV-Cache tab：无缓存请求的空态（OpenAI 自动缓存本次未命中）', async ({ page, lucent }) => {
    const logId = await postAndAwaitLog(lucent, {
      upstream: 'openai', mode: 'chat-sse',
      path: '/openai/v1/chat/completions', headers: OAI_HEADERS,
      body: { model: 'gpt-4o', max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] },
      provider: 'openai', endpoint: 'openai-chat',
    });
    await openDetail(page, lucent, logId);
    await page.getByTestId('tab-kvcache').click();

    // 自动缓存模式徽标 + 空态文案（均 KV-Cache tab 独有；头部 token 卡不显这些）
    await expect(page.getByText('自动缓存')).toBeVisible();
    await expect(page.getByText('支持缓存但本次未命中')).toBeVisible();
  });

  test('Context tab：渲染 context-item + 统计卡 + 选中项出详情', async ({ page, lucent }) => {
    const logId = await postAndAwaitLog(lucent, {
      upstream: 'openai', mode: 'chat-sse',
      path: '/openai/v1/chat/completions', headers: OAI_HEADERS, body: OAI_BODY_RICH_CONTEXT,
      provider: 'openai', endpoint: 'openai-chat',
    });
    await openDetail(page, lucent, logId);
    await page.getByTestId('tab-context').click();

    // 统计卡 + 三个分组标题（避开「系统提示词」：右侧默认选中系统提示词，
    // 其详情标题也叫「系统提示词」，会与之撞名；用对话历史 / 可用工具 这两个唯一标题）
    await expect(page.getByText('总消息')).toBeVisible();
    await expect(page.getByText('对话历史')).toBeVisible();
    await expect(page.getByText('可用工具')).toBeVisible();
    // context-item 渲染：至少有对话历史的 3 条消息 + system + tool
    const items = page.getByTestId('context-item');
    await expect(items.first()).toBeVisible();
    expect(await items.count(), 'context-item 至少 4 条（3 消息 + system + tool 之中）').toBeGreaterThanOrEqual(4);

    // 选中可用工具项 → 右侧出该工具描述（交互：点击触发，内容点击前不在右侧）
    const toolItem = items.filter({ hasText: 'list_files' });
    await expect(toolItem).toBeVisible();
    await toolItem.click();
    await expect(page.getByText('List files in cwd')).toBeVisible();
  });

  test('Meta tab：渲染元信息（模型 / 端点协议 / 耗时 / 流式 / token）', async ({ page, lucent }) => {
    const logId = await postAndAwaitLog(lucent, {
      upstream: 'openai', mode: 'chat-sse',
      path: '/openai/v1/chat/completions', headers: OAI_HEADERS,
      body: { model: 'gpt-4o', max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] },
      provider: 'openai', endpoint: 'openai-chat',
    });
    await openDetail(page, lucent, logId);
    await page.getByTestId('tab-meta').click();

    const panel = page.getByTestId('detail-panel');
    const text = (await panel.textContent()) ?? '';
    // Meta 行渲染：模型、端点协议、耗时、流式、token（均来自日志实际 metadata / usage）
    expect(text, '应含模型 gpt-4o').toContain('gpt-4o');
    expect(text, '应含端点协议 openai-chat').toContain('openai-chat');
    expect(text, '应含耗时（ms）').toContain('ms');
    expect(text, '应含流式标记').toContain('流式');
    expect(text, '应含 Input Tokens 行').toContain('Input Tokens');
  });

  test('三 tab 切换：各自渲染自有内容、互不串台', async ({ page, lucent }) => {
    // 用 Anthropic 命中日志：三个 tab 都有富内容，便于用各自唯一标记判定串台
    const logId = await postAndAwaitLog(lucent, {
      upstream: 'anthropic', mode: 'sse-hit',
      path: '/anthropic/v1/messages', headers: ANTH_HEADERS, body: ANTH_BODY_WITH_CACHE,
      provider: 'anthropic', endpoint: 'anthropic-messages',
    });
    await openDetail(page, lucent, logId);

    // KV-Cache 唯一标记：「显式缓存」徽标（头部 token 卡不显模式徽标）；Context 唯一标记：context-item；Meta 唯一标记：「Agent 类型」
    const kvcacheMarker = page.getByText('显式缓存');
    const contextItems = page.getByTestId('context-item');
    const metaMarker = page.getByText('Agent 类型');

    // ① KV-Cache tab：显式缓存在，context-item 与 Agent 类型都不在
    await page.getByTestId('tab-kvcache').click();
    await expect(kvcacheMarker).toBeVisible();
    await expect(contextItems).toHaveCount(0);
    await expect(metaMarker).toHaveCount(0);

    // ② Context tab：context-item 在，显式缓存与 Agent 类型都不在
    await page.getByTestId('tab-context').click();
    await expect(contextItems.first()).toBeVisible();
    await expect(kvcacheMarker).toHaveCount(0);
    await expect(metaMarker).toHaveCount(0);

    // ③ Meta tab：Agent 类型在，显式缓存与 context-item 都不在
    await page.getByTestId('tab-meta').click();
    await expect(metaMarker).toBeVisible();
    await expect(kvcacheMarker).toHaveCount(0);
    await expect(contextItems).toHaveCount(0);
  });
});
