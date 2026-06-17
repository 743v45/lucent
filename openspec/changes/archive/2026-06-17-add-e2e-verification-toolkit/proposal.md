## Why

`openspec/specs/verification-workflow/spec.md` 的第 3 条 Requirement
（"Runtime-affecting changes MUST be verified end-to-end against a real
process"）目前**没有可复用的工具支撑**——本会话两次端到端验收都是写
一次性 `/tmp/*.mjs` 脚本，跑完即删。下次想验证任何 runtime 改动（路由、
URL 拼接、provider 模型、协议处理），又得从零写一遍。

这是 spec 有约束、工程无支撑的典型缺口。本 change 把"启动服务 +
mock 上游 + 发真实请求"沉淀为项目内的可执行脚本，让 verification-
workflow 的第 3 条 Requirement 有可被任何人/任何 AI 工具调用的落地形态。

## What Changes

- 新增 `scripts/verify-e2e.mjs`：可独立运行的端到端验收脚本
  - **固定场景**（不参数化），但**覆盖全**——10 个场景覆盖本会话踩过的所有坑
  - 隔离环境：临时 config dir + 随机端口 + mock 上游
  - 退出码 0 = 绿，非 0 = 失败
- 新增 `npm run verify:e2e` 脚本入口
- 新增 `README.md`「端到端验收」章节，说明何时跑、怎么跑、看什么
- 不引入新依赖（用 Node 内置 `http`/`child_process`）

## Capabilities

### New Capabilities
- `e2e-verification`: 端到端验收工具的存在、运行方式、覆盖场景

### Modified Capabilities
无（与 `verification-workflow` capability 互补：前者定义"该做什么"，本 capability 定义"用什么工具做"）。

## Impact

- 受影响代码：无（不改产品逻辑）
- 受影响测试：无（本脚本独立于 vitest 套件，CI 上可并行跑）
- 受影响文档：`README.md` 加一节
- 受影响 npm scripts：`package.json` 加 `verify:e2e`
- 不影响 runtime 行为、API、依赖
- 适用场景：任何 runtime-affecting 改动（路由、URL 拼接、provider 模型、协议处理）的端到端验收
