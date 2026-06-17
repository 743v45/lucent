## Why

用户报告 bug：Web UI Request/Response tab 的 JsonBlock 把 `messages` 数组里的对象渲染成 `{}`，无法看到每条 message 的 `role` 和 `content`。

根因：`src/constants.ts` 的 `JSON_COLLAPSED_EXPAND_LEVEL = 2`，配合
`react-json-view-lite` 的 `shouldExpandNode` 行为：
- level 0（根 `{}`）→ 展开
- level 1（数组）→ 展开
- level 2（数组里的对象）→ **折叠成 `{}`** ← bug
- level 3+ → 折叠

设计动机是"避免大 body 全展开卡顿"，但折叠得太狠——message 字段完全看不到。

## What Changes

- 新增 `JsonBlock.expandAll` prop（boolean）
- 新增 `DetailPanel.expandAll` state（按 request/response 维度）
- 新增 `ExpandAllButton` 组件（紧跟现有 CollapseButton），在 Request/Response
  tab 的 body 工具栏显示「展开全部 / 收起全部」
- 点「展开全部」后 JsonBlock 强制 `shouldExpandNode` 永远 true
- 拟入 `verify:custom` 加 2 个防回归断言：
  - 默认折叠: `messages:[{},{}]`（保留默认行为）
  - 点展开: messages 数组里能看到 role 字段（无 JsonBlock 折叠 bug）

## Capabilities

### Modified Capabilities
- `protocol-chain-verification`: 加 JsonBlock 展开/收起契约

## Impact

- 受影响代码: `src/components/viewer/DetailPanel.tsx`（+~30 行: prop, state, button, 按钮接线）
- 受影响测试: `scripts/verify-custom-providers-e2e.mjs`（+2 断言/供应商/协议/模式 = 20 个新验收点，60 → 80）
- 不影响 runtime 行为 / API / 依赖
- 性能: 默认折叠不变，大 body 仍受 JSON_COLLAPSED_EXPAND_LEVEL=2 保护
- 用户主动「展开全部」才会全展开（可能卡顿，但用户主动触发可接受）
