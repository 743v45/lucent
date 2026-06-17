## Why

本项目之前的工作里出现了一个模式：**claim 没经过 verification 验证**——agent 说"改完了"但其实没跑测试、文档说"全绿"但没贴证据。

根因不是 agent 能力问题，是**没有项目级的硬规则**约束这类 claim 的形式。superpowers 的 `verification-before-completion` skill 是通用指引，但散落在 AI 工具调用层，没有沉淀到项目本地的 spec 里——新人 / 下一轮 agent / 不同 AI 工具都不会自动遵循。

本 change 把 verification 实践沉淀为 openspec `verification-workflow` capability，约束所有"完成 / 修复 / 验收"类 claim 的形式。

## What Changes

- 新增 `verification-workflow` capability，定义 4 条硬规则：
  1. 完成类 claim 必须有"运行测试 + 看到输出"作为前置证据
  2. TDD 红→绿循环必须可观测（红测试、修复、绿测试、还原修复再红）
  3. 影响 runtime 行为的改动必须做端到端验证（真实进程 + 真实 HTTP）
  4. 文档 / 配置文件改动必须回读交叉验证一致性
- **不引入新代码**，仅 spec 形式化既有实践
- **不影响** runtime 行为、API、依赖

## Capabilities

### New Capabilities
- `verification-workflow`: 4 条硬性 verification 规则（每条配场景化验收数据）

### Modified Capabilities
无。

## Impact

- 受影响文档：本 spec 自身是新的，下游无破坏
- 受影响代码：无
- 受影响测试：无（规则是给 AI agent 的人为约束，不是 vitest 测试）
- 不影响 runtime 行为、API、依赖
- 适用对象：所有在本项目工作的 AI agent（含 superpowers skill 启用时）
