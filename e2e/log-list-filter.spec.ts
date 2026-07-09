/**
 * 日志列表与多维筛选 交互 spec（对应 TAE-61，功能① TAE-48 已 done）
 *
 * 复用 e2e/fixtures.ts 的隔离栈（mock 上游 + 临时 config + 随机端口 + 起 backend + vite
 * dev），不重造。覆盖 TAE-48 的判断要点里**当前实际存在**的行为：
 *   - 列表渲染：agent 类型 / 状态码 / 耗时 / 流式标记
 *   - 按供应商下拉筛选（排除 + 计数交叉）
 *   - 按协议下拉筛选（排除 → 空态）
 *   - 筛选态 localStorage 持久化（刷新仍在）
 *   - 视图切换 timeline↔session（无丢条/重条 + 同 thread 归一组）
 *   - 加载更多（>PAGE_SIZE 分页）
 *   - 加载态（首屏拉取期间「加载中」）
 *
 * ⚠️ 不覆盖「自动滚动」：TAE-48 查明 useAutoScrollToBottom 是死代码、/api/logs/stream
 * SSE 推送「未接通」（server/routes/logs.ts 路由自述），且列表「最新在上」，新日志需
 * 手动刷新才出现——该功能不存在，lead 已起 TAE-64（只清死代码、不实现）。按本 issue
 * 「以功能改完后的实际行为为准」的要求，不写臆造断言。
 *
 * 隔离注意：fixture 是 worker 级（workers:1），兄弟 spec 的日志会在同一后端累积。
 * 故计数敏感的断言一律用「专属 provider=beta」（只有本文件造 beta 日志）+ /api/logs
 * 交叉，而非假定空库。
 */
import { test, expect, type LucentStack } from './fixtures';
import type { Page } from '@playwright/test';

// mock key，绝不硬编码真 key（代理只透传、不校验 key）。
const OAI_HEADERS = { authorization: 'Bearer sk-mock-ui-e2e' };

/** 发一条 openai-chat 请求穿过代理，落到指定 provider 名下；mode 决定上游回包形状。 */
async function sendChat(
  lucent: LucentStack,
  provider: string,
  opts: { mode?: string; system?: string; content?: string } = {},
): Promise<void> {
  lucent.upstream.setMode(opts.mode ?? 'chat-json');
  const messages: Array<{ role: string; content: string }> = [];
  if (opts.system) messages.push({ role: 'system', content: opts.system });
  messages.push({ role: 'user', content: opts.content ?? 'log-list-filter probe' });
  await lucent.postThroughProxy(`/${provider}/v1/chat/completions`, OAI_HEADERS, {
    model: 'gpt-4o',
    max_tokens: 1,
    messages,
  });
}

/** 经 AntD Select 选一个下拉项：点开 → 在可见 dropdown 里按文本点中。 */
async function pickOption(page: Page, selectTestId: string, optionText: string): Promise<void> {
  await page.getByTestId(selectTestId).click();
  const dropdown = page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)');
  await expect(dropdown).toBeVisible();
  await dropdown.locator('.ant-select-item').filter({ hasText: optionText }).first().click();
}

/** 当前列表里所有可见 log-row 的 id。 */
async function visibleRowIds(page: Page): Promise<string[]> {
  return page.locator('[data-testid="log-row"]').evaluateAll((els) =>
    els.map((e) => (e as HTMLElement).getAttribute('data-logid') || '').filter(Boolean),
  );
}

/** 后端已落库的 beta 日志（只有本文件造 beta，故计数确定）。 */
async function betaLogs(lucent: LucentStack): Promise<Array<Record<string, unknown>>> {
  return (await lucent.readLogEntries()).filter((l) => l.providerName === 'beta');
}

test.describe('日志列表与多维筛选', () => {
  test('列表渲染：agent 类型 / 状态码 / 耗时 / 流式标记', async ({ page, lucent }) => {
    lucent.upstream.reset();
    // 三条 beta 探针：200·main·非流式 / 500 / SubAgent
    await sendChat(lucent, 'beta', { mode: 'chat-json', content: 'LLF-RENDER-OK' });
    await sendChat(lucent, 'beta', { mode: 'error-500', content: 'LLF-RENDER-ERR' });
    await sendChat(lucent, 'beta', { mode: 'chat-json', system: 'cc_is_subagent=true', content: 'LLF-RENDER-SUB' });
    await expect.poll(async () => (await betaLogs(lucent)).length, { timeout: 10_000 }).toBeGreaterThanOrEqual(3);

    await page.goto(lucent.webBaseUrl);
    // 收窄到 beta：worker 共享后端里 openai 行可能来自兄弟 spec，只断言我这三条
    await pickOption(page, 'provider-filter', 'beta');
    await expect(page.getByTestId('log-row').first()).toBeVisible({ timeout: 15_000 });

    const beta = await betaLogs(lucent);
    const status = (l: Record<string, unknown>) => ((l.response as { status?: number })?.status);
    const okLog = beta.find((l) => l.agentType === 'main' && status(l) === 200);
    const errLog = beta.find((l) => status(l) === 500);
    const subLog = beta.find((l) => l.agentType === 'sub');
    expect(okLog, '应有一条 200·main beta 日志').toBeTruthy();
    expect(errLog, '应有一条 500 beta 日志').toBeTruthy();
    expect(subLog, '应有一条 SubAgent beta 日志').toBeTruthy();

    const okRow = page.locator(`[data-testid="log-row"][data-logid="${okLog!.id}"]`);
    const errRow = page.locator(`[data-testid="log-row"][data-logid="${errLog!.id}"]`);
    const subRow = page.locator(`[data-testid="log-row"][data-logid="${subLog!.id}"]`);

    // 200 · MainAgent 标签 · 非流式 JSON 标记 · 耗时（Nms 或 N.Ns）
    await expect(okRow.locator('[data-testid="log-status"]')).toHaveText('200');
    await expect(okRow).toContainText('MainAgent');
    await expect(okRow).toContainText('JSON');
    await expect
      .poll(async () => (await okRow.textContent()) ?? '', { timeout: 5_000 })
      .toMatch(/\d+ms|\d+\.\ds/);
    // 500 状态码
    await expect(errRow.locator('[data-testid="log-status"]')).toHaveText('500');
    // SubAgent 标签（靠 system 里的 cc_is_subagent=true 标记命中）
    await expect(subRow).toContainText('SubAgent');
  });

  test('按供应商筛选：beta 下拉只留 beta 行（排除 openai）', async ({ page, lucent }) => {
    lucent.upstream.reset();
    // 自带一条 openai 日志：单跑本 spec 时兄弟 spec 没跑、库里没 openai 行，
    // 排除断言会退化成 beta==all。造一条 openai 保证「排除」可证。
    await sendChat(lucent, 'openai', { content: 'LLF-PROV-OPENAI' });
    await sendChat(lucent, 'beta', { content: 'LLF-PROV-BETA' });
    await expect.poll(async () => {
      const all = await lucent.readLogEntries();
      return all.some((l) => l.providerName === 'beta') && all.some((l) => l.providerName === 'openai') ? 1 : 0;
    }, { timeout: 10_000 }).toBe(1);

    await page.goto(lucent.webBaseUrl);
    await expect(page.getByTestId('log-row').first()).toBeVisible({ timeout: 15_000 });
    const allCount = await page.getByTestId('log-row').count();
    expect(allCount, '全部视图至少含 openai + beta').toBeGreaterThan(1);

    // 选 beta
    await pickOption(page, 'provider-filter', 'beta');
    const betaVisible = await visibleRowIds(page);
    const betaExpected = (await betaLogs(lucent)).map((l) => l.id as string).sort();

    // 排除：beta 视图严格少于全部（openai 行被筛掉）
    expect(betaVisible.length, '选 beta 应排除 openai 行，严格少于全部').toBeLessThan(allCount);
    // 正确：可见 beta 行恰好等于后端 beta 集
    expect(betaVisible.slice().sort(), '可见 beta 行应与后端 beta 集一致').toEqual(betaExpected);
  });

  test('按协议筛选：OpenAI Chat 留行；Anthropic Messages → 空态（排除）', async ({ page, lucent }) => {
    lucent.upstream.reset();
    await sendChat(lucent, 'beta', { content: 'LLF-PROTO' });
    await expect.poll(async () => (await betaLogs(lucent)).length, { timeout: 10_000 }).toBeGreaterThanOrEqual(1);

    await page.goto(lucent.webBaseUrl);
    await expect(page.getByTestId('log-row').first()).toBeVisible({ timeout: 15_000 });

    // 选 OpenAI Chat：所有可见行都是 openai-chat
    await pickOption(page, 'endpoint-filter', 'OpenAI Chat');
    await expect(page.getByTestId('log-row').first()).toBeVisible({ timeout: 10_000 });
    const chatExpected = new Set(
      (await lucent.readLogEntries()).filter((l) => l.endpointType === 'openai-chat').map((l) => l.id as string),
    );
    const chatVisible = await visibleRowIds(page);
    expect(chatVisible.length, 'openai-chat 视图应至少 1 行').toBeGreaterThan(0);
    for (const id of chatVisible) {
      expect(chatExpected.has(id), `openai-chat 视图不该出现非 openai-chat 行 ${id}`).toBe(true);
    }

    // 选 Anthropic Messages：本环境无此协议日志 → 空态
    await pickOption(page, 'endpoint-filter', 'Anthropic Messages');
    await expect(page.getByTestId('log-empty')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('log-row')).toHaveCount(0);
  });

  test('筛选态持久化：beta 筛选刷新后仍在（localStorage）', async ({ page, lucent }) => {
    lucent.upstream.reset();
    await sendChat(lucent, 'beta', { content: 'LLF-PERSIST' });
    await expect.poll(async () => (await betaLogs(lucent)).length, { timeout: 10_000 }).toBeGreaterThanOrEqual(1);

    await page.goto(lucent.webBaseUrl);
    await expect(page.getByTestId('log-row').first()).toBeVisible({ timeout: 15_000 });
    await pickOption(page, 'provider-filter', 'beta');
    const before = (await visibleRowIds(page)).sort();

    // 筛选写入 localStorage
    await expect
      .poll(async () => page.evaluate(() => localStorage.getItem('lucent.providerFilter')), { timeout: 5_000 })
      .toBe('beta');

    await page.reload();
    await expect(page.getByTestId('log-row').first()).toBeVisible({ timeout: 15_000 });
    const after = (await visibleRowIds(page)).sort();
    expect(after, '刷新后筛选态保留，行集不变').toEqual(before);
    expect(await page.evaluate(() => localStorage.getItem('lucent.providerFilter')), 'localStorage 仍为 beta').toBe('beta');
  });

  test('视图切换 timeline↔session：无丢条/重条，同 thread 归一组', async ({ page, lucent }) => {
    lucent.upstream.reset();
    // 两条同首条 user 文本 → threadId 内容寻址相同 → session 视图归一组
    await sendChat(lucent, 'beta', { content: 'LLF-GROUP-PAIR same text' });
    await sendChat(lucent, 'beta', { content: 'LLF-GROUP-PAIR same text' });
    // 一条不同文本 → 另一组
    await sendChat(lucent, 'beta', { content: 'LLF-GROUP-SOLO different text' });
    await expect.poll(async () => (await betaLogs(lucent)).length, { timeout: 10_000 }).toBeGreaterThanOrEqual(3);

    await page.goto(lucent.webBaseUrl);
    await pickOption(page, 'provider-filter', 'beta');
    await expect(page.getByTestId('log-row').first()).toBeVisible({ timeout: 15_000 });

    // timeline：收行 id（无重条）
    await expect(page.getByTestId('view-timeline')).toBeVisible();
    const timelineIds = await visibleRowIds(page);
    expect(new Set(timelineIds).size, 'timeline 无重条').toBe(timelineIds.length);

    // 切 session：行集一致（无丢条）、无重条
    await page.getByTestId('view-session').click();
    const sessionIds = await visibleRowIds(page);
    expect(sessionIds.slice().sort(), 'session 与 timeline 行集一致（无丢条）').toEqual(timelineIds.slice().sort());
    expect(new Set(sessionIds).size, 'session 无重条').toBe(sessionIds.length);

    // 同 thread 的两条（同首条 user 文本）归到一个分组（count=2）。
    // 按标题精确定位本组：别的测试的 sub 日志会被 groupByThread 的 subAssign 附到某 main
    // 线程、偶发也凑出 count=2 组，不能笼统断言「任一 count=2 组」。
    const pairGroup = page.locator('[data-testid="session-group"]', { hasText: 'LLF-GROUP-PAIR' });
    await expect(pairGroup).toBeVisible();
    await expect(pairGroup).toHaveAttribute('data-count', '2');

    // 切回 timeline，行集仍一致
    await page.getByTestId('view-timeline').click();
    const backIds = await visibleRowIds(page);
    expect(backIds.slice().sort(), '切回 timeline 行集不变').toEqual(timelineIds.slice().sort());
  });

  test('加载更多：>PAGE_SIZE 分页，滚到底补齐', async ({ page, lucent }) => {
    lucent.upstream.reset();
    lucent.upstream.setMode('chat-json');
    // 干净起步：worker 共享后端里有兄弟测试累积的日志，清掉让「首屏正好 50」确定。
    await lucent.clearLogs();
    // 造 52 条 beta（最新），使总数 > PAGE_SIZE(50)
    for (let i = 0; i < 52; i++) {
      await lucent.postThroughProxy('/beta/v1/chat/completions', OAI_HEADERS, {
        model: 'gpt-4o',
        max_tokens: 1,
        messages: [{ role: 'user', content: `LLF-LOADMORE-${i}` }],
      });
    }
    await expect.poll(async () => (await betaLogs(lucent)).length, { timeout: 20_000 }).toBeGreaterThanOrEqual(52);

    await page.goto(lucent.webBaseUrl);
    await expect(page.getByTestId('log-row').first()).toBeVisible({ timeout: 15_000 });
    // 首屏 PAGE_SIZE=50
    await expect.poll(async () => page.getByTestId('log-row').count(), { timeout: 10_000 }).toBe(50);
    // hasMore=true → 「加载更多」按钮在（不点它：Playwright 会把它 scrollIntoView，
    // 那一下滚动本身就触发 onScroll 分页、把按钮 detach 掉，点击必失败。改走主路径——滚到底触发 onScroll）
    await expect(page.getByTestId('load-more-btn')).toBeVisible();

    const before = await page.getByTestId('log-row').count();
    // 滚到列表底部 → onScroll 触发 onLoadMore 补齐下一页
    await page.getByTestId('log-row').last().evaluate((el) => {
      let p = el.parentElement;
      while (p && getComputedStyle(p).overflowY !== 'auto') p = p.parentElement;
      if (p) p.scrollTop = p.scrollHeight;
    });
    await expect.poll(async () => page.getByTestId('log-row').count(), { timeout: 10_000 }).toBeGreaterThan(before);
    // 总数已 < 2 页，hasMore 转 false，按钮消失
    await expect(page.getByTestId('load-more-btn')).toHaveCount(0);

    // 收尾：52 条别留给后续 search.spec 的 keyset 分页（limit=2 翻 20 页=40 条封顶会翻不到头）。
    // search/seed 各自造数，清空不影响它们。
    await lucent.clearLogs();
  });

  test('加载态：首屏拉取期间显示「加载中」', async ({ page, lucent }) => {
    lucent.upstream.reset();
    await sendChat(lucent, 'beta', { content: 'LLF-LOADING' });
    await expect.poll(async () => (await betaLogs(lucent)).length, { timeout: 10_000 }).toBeGreaterThanOrEqual(1);

    // 卡住全部 /api/logs：loading 常驻、Spin 常驻，直到我们放行。
    // 用正则匹配（glob `**/api/logs**` 实测不命中）；StrictMode 下首屏会发两次 /api/logs，
    // 必须全卡，否则第二次会抢先 resolve、抢走 loading 态。比靠「延迟回包抢窗口」确定性高。
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    await page.route(/\/api\/logs/, async (route) => {
      await held;
      await route.continue();
    });
    await page.goto(lucent.webBaseUrl);
    await expect(page.getByTestId('log-loading')).toBeVisible({ timeout: 10_000 });
    release(); // 放行 → loading 清、行出现
    await expect(page.getByTestId('log-row').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('log-loading')).toHaveCount(0);
  });
});
