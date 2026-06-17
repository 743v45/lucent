## Why

`openspec/specs/provider-baseurl/spec.md` 归档后含 5 条 Requirement / 17 条 Scenario。
其中**路由/拼接行为**的 13 条 Scenario 已被现有 e2e 测试覆盖
（`tests/provider-e2e.test.ts` 测试连接 3 条 + 首次启动 1 条 +
`tests/anthropic-e2e.test.ts` + `tests/providers-e2e.test.ts` URL 断言若干）。

但**配置预设值**的 4 条 Scenario 没有任何测试覆盖：
- `anthropic` preset 的 `anthropic-messages` baseUrl
- `openai` preset 的 `openai-chat` + `openai-responses` baseUrl
- `zhipu` preset 的两个端点 baseUrl
- 首次启动种子默认 baseUrl（含 /v1）

这是 spec 的薄弱面——纯静态断言（读代码值），却没人守着。

## What Changes

- 新增 `tests/provider-baseurl-spec.test.ts`：把 spec 里的 4 条"配置预设值"Scenario
  翻译成 vitest 静态断言（`expect(presets[...].endpoints[...]).toBe('...')`）
- **不引入**新依赖、不改产品代码
- 这层断言是"廉价但关键"的守门员：任何人未来误改 `presets.ts` 漏写 `/v1`、
  或改 `config.ts:buildDefaultConfig` 漏 `/v1`，CI 立刻红灯

## Capabilities

### New Capabilities
无（这是给现有 `provider-baseurl` capability 加测试覆盖，不是新增 capability）。

### Modified Capabilities
无（spec 文本本身不变；只是给 Scenario 加了机检）。

## Impact

- 受影响代码：无
- 受影响测试：新增 `tests/provider-baseurl-spec.test.ts`（静态断言，毫秒级）
- 不影响 runtime 行为、API、依赖
- 现有 315 个测试不动
