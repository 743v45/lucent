## Why

`openspec/specs/e2e-verification/spec.md` 只覆盖 URL 拼接/路由层(verify-e2e.mjs),
没有覆盖"协议格式 + 日志 + API + Web UI 渲染"这条完整链路。delta bug
(remove-delta-storage change) 暴露了这条链路的脆弱——日志层能抓,但 UI
渲染是否正确没人测过。

用户报告 bug 时说"页面 body 展示异常",但当时没有任何工具能验证 Web UI
是否正确渲染。本 change 建立"协议链路验收"能力,从 anthropic-messages
协议开始走通完整 5 环节验收。

## What Changes

- 新增 `protocol-chain-verification` capability: 协议链路全链路验收契约
- 新增 `scripts/verify-anthropic-e2e.mjs`: anthropic-messages 全链路验收脚本
  - 5 环节 × 2 模式(流式 SSE + 非流式 JSON) = 10 个断言组
  - 用 playwright + data-testid 验证 Web UI 渲染
- 新增 npm script `verify:anthropic`
- 前端组件加 data-testid(5 处): LogRow / RequestTab body / ResponseTab body
  / ContextTab item(+data-role) / Tab 切换按钮
- vite.config.ts 参数化: proxy target 读 LUCENT_WEB_PORT,端口读 VITE_PORT
- 装 @playwright/test + chromium

## Capabilities

### New Capabilities
- `protocol-chain-verification`: 协议链路全链路验收契约(5 环节 + UI 渲染
  + data-testid 约束)

### Modified Capabilities
无。

## Impact

- 受影响代码: 5 个前端组件加 data-testid(纯属性,不改样式/逻辑);
  vite.config.ts 参数化(向后兼容,无 env 时用默认)
- 受影响依赖: + @playwright/test(devDep), chromium 二进制(~300MB 本地缓存)
- 受影响 npm scripts: + verify:anthropic
- 不影响 runtime 行为、API、现有测试
- 现有 verify:e2e 不受影响(两个脚本独立)
