## Why

`remove-delta-storage` change 删除了 delta 机制,确立了"请求 body 必须原样
落盘"的新契约(见 `openspec/specs/log-integrity/spec.md`)。但
`openspec/specs/e2e-verification/spec.md`(验收工具契约)当时只覆盖到 URL
拼接/路由,没有覆盖日志完整性——验收工具里没有断言"日志 body 完整",
所以这类 bug 不会被 `npm run verify:e2e` 抓住。

本 change 给 `e2e-verification` spec 补 2 条 Requirement,对应已加进
`scripts/verify-e2e.mjs` 的场景 11-12。

## What Changes

- `openspec/specs/e2e-verification/spec.md` 新增 2 条 Requirement(MODIFIED):
  - 验收脚本必须断言连续请求的日志 body.messages 完整
  - 验收脚本必须断言日志无 delta 残留字段
- `scripts/verify-e2e.mjs` 已经实现(场景 11-12),本 change 仅 spec 化
- 不引入新代码

## Capabilities

### Modified Capabilities
- `e2e-verification`: 加 2 条 Requirement(日志完整性验收)

## Impact

- 受影响代码: 无
- 受影响 spec: `openspec/specs/e2e-verification/spec.md`(+2 Requirement)
- 受影响测试: 无(`scripts/verify-e2e.mjs` 已含场景 11-12)
- 不影响 runtime 行为、API、依赖
