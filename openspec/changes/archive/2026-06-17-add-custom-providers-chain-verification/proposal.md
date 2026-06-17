## Why

`extend-chain-verification-to-all-protocols` change 覆盖了 3 协议 × 2 模式
× 5 环节 = 30 验收点，但每个 verify 脚本只针对**单个预设供应商**
(anthropic / openai)。

用户的实际使用场景是**自定义供应商** (hxy / hxy2) 接多个上游,且每个
供应商需要支持所有 3 协议(不能因为一个上游不支持某个协议就放弃整条
协议链路)。本 change 建立"1 个 mock upstream + 多供应商配齐 3 协议 +
5 环节全链路"的验收能力。

## What Changes

- 新增 `scripts/verify-custom-providers-e2e.mjs`:
  - 1 个 mock upstream 同时处理 anthropic/openai-chat/openai-responses 3 协议
  - 临时 config 把 hxy + hxy2 都配齐 3 协议(都指向 mock 上游)
  - 2 供应商 × 3 协议 × 2 模式 × 5 环节 = **60 验收点**全绿
- 新增 npm script `verify:custom`
- spec 加 1 条 Requirement: 自定义供应商多协议验收

## Capabilities

### Modified Capabilities
- `protocol-chain-verification`: 加自定义供应商多协议验收契约

## Impact

- 受影响代码: 无
- 受影响脚本: + verify-custom-providers-e2e.mjs
- 受影响 npm scripts: + verify:custom
- 不影响 runtime 行为、API、依赖
