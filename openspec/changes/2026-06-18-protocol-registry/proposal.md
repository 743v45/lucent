## Why

Lucent 支持三个上游协议(`anthropic-messages`、`openai-chat`、`openai-responses`),但协议的**身份维度**(id / label / path 字面量 / test model / schema 引用)散落在 6 处,且其中存在两套独立的 path 规则:

- `src/types.ts` + `server/types.ts` **各自手写了一份完全相同的** `EndpointType` 联合类型、`ENDPOINT_TYPES` 数组、`ENDPOINT_LABELS`——加协议要改两处,可能漂移
- `context-extractors.detectEndpointType` 内部**重写了一遍** path → protocol 映射(`/v1/messages` → `anthropic-messages` 等),与 `endpoint-handlers.registerEndpoint` 里 `matchPath` 的 stripped path(`/messages`)**是两套独立硬编码**,改一处忘改另一处会静默漂移
- `server/constants.TEST_MODELS` 是孤儿常量,跟协议定义无关联
- `shared/sse-events.ts` 前后端共用,但 `tsconfig.json` 的 `include` 是 `["src","server","bin"]`,**漏了 `shared`**——目前靠相对路径 import 顺带编译,单独 `tsc` 下有漏编译风险

注:`server/endpoint-registry.ts` + `server/endpoint-handlers.ts` 其实已经是"半个 Registry"——path 匹配 + SSE 提取 + context 提取的**行为**已收口。本 change 补的是**身份维度**的收口,并把已有的行为注册表与身份注册表对齐到同一组 path 字面量。

## What Changes

- 新增 `shared/protocols.ts` —— `PROTOCOL_REGISTRY` 纯数据描述符表,每个协议声明 `id` / `label` / `strippedPaths[]` / `defaultTestModel` / `schemaDocRef`
- `src/types.ts` + `server/types.ts` 的 `EndpointType` / `ENDPOINT_TYPES` / `ENDPOINT_LABELS` / `isEndpointType` 改为从 `PROTOCOL_REGISTRY` 派生(消除两份手写联合类型)
- `endpoint-handlers` 注册时 `matchPath` 改读 `PROTOCOL_REGISTRY[type].strippedPaths`
- `context-extractors.detectEndpointType` 删除内部硬编码 path,拆出 strippedPath 后委托 registry 的 `inferEndpointTypeFromPath`(旧日志 fallback 兼容逻辑保留,仅匹配源换成 registry)
- `server/constants.TEST_MODELS` 删除,调用方改读 `PROTOCOL_REGISTRY[type].defaultTestModel`
- `tsconfig.json` `include` 加 `"shared"`

**不**改的:配色/icon(前端关注点)、preset baseUrl(已由 `provider-baseurl` spec 管)、SSE/context 提取函数体(业务逻辑非身份维度)、`docs/protocols/` schema 库、HTTP API、runtime 行为。

## Capabilities

### New Capabilities
- `protocol-model` —— 三协议身份维度的单源契约(id / label / strippedPaths / defaultTestModel / schemaDocRef 由 `shared/protocols.ts` 唯一定义)

### Modified Capabilities
无。`provider-baseurl`(管 baseUrl 拼接)、`protocol-chain-verification`(管验收脚本契约)均不受影响。

## Impact

- **受影响代码**:
  - 新增 `shared/protocols.ts`
  - 改 `src/types.ts`、`server/types.ts`(EndpointType 派生化)
  - 改 `server/endpoint-handlers.ts`(matchPath 读 registry)
  - 改 `server/context-extractors.ts`(detectEndpointType 委托 registry)
  - 改 `server/constants.ts`(删 TEST_MODELS)、`server/routes/providers.ts`(改读 registry)
  - 改 `tsconfig.json`(include 加 shared)
- **受影响测试**:全套 `verify:*` 必须绿——path 单源是回归高风险点(`detectEndpointType` 与 `matchPath` 两套规则合并,必须端到端兜底)
- **不变量**:`strippedPaths` 不得跨协议重叠(否则 `inferEndpointTypeFromPath` 遍历误判)
- **不影响**:runtime 行为、HTTP API 形状、UI 配色、preset baseUrl、`docs/protocols/` 内容、依赖
