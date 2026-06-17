## Why

Lucent 是一个透明代理，URL 拼接规则（"baseUrl 怎么拼上协议路径"）是系统的核心不变量，但目前**没有任何地方**把这条规则写成"可测试的需求"——它散落在 `server/proxy.ts:210-212` 的注释里、`README.md` 的路径规则表里、以及几处 e2e 测试的隐含假设里。

后果是历史上已经出现过两次相关 bug：
- 首次启动种子默认值的 `https://api.anthropic.com` 漏写 `/v1`
- `server/routes/providers.ts` 的「测试连接」硬拼 `/v1/messages`，对含 `/v1` 的 baseUrl 产生 `/v1/v1/messages`

两次都是「隐含约定 + 无 spec 保护」的产物。本 change 把拼接规则以及 4 个官方供应商的 baseUrl 形态写进 openspec，从机制上保证未来加 preset / 改拼接代码时有人能查"对不对"。

## What Changes

- 新增 `provider-baseurl` capability，定义**上游 baseUrl 必须含版本路径**的契约
- 新增 `proxy-url-composition` 行为规则：proxy 主转发 + 测试连接**都**按同一条规则拼 URL
- 记录 4 个**已核实**的官方供应商真实 endpoint URL，作为 spec 的场景化验收数据
- 暂不记录 Perplexity（用户调研中，证据未到）
- **不引入新代码改动**（仅写 spec；现有 e2e + 已修代码已满足这些 requirement）

## Capabilities

### New Capabilities
- `provider-baseurl`: 4 个已核实官方供应商的 baseUrl 形态 + URL 拼接核心规则

### Modified Capabilities
无（这是新增 spec，不改任何现有 capability）。

## Impact

- 受影响代码：仅供未来 review 参照（拼接规则已在 `server/proxy.ts:210-212` 和 `server/routes/providers.ts:194-225` 实现并 e2e 覆盖）
- 受影响文档：
  - `README.md:70-92`（路径规则表）已与本 spec 一致
  - `src/constants/presets.ts` 中 4 家官方预设的 baseUrl 与本 spec 一致
- 受影响测试：
  - `tests/provider-e2e.test.ts`「测试连接」3 用例（baseUrl 含 /v1 场景）
  - `tests/provider-e2e.test.ts`「首次启动」1 用例（种子默认值含 /v1）
- **不进版本库**：`~/.lucent/config.json`（在 .gitignore 里）；本地用户配置修复由用户在 spec 之外手动处理
- 不影响 runtime 行为、API、依赖
