# protocol-model Specification

## Purpose
TBD - created by archiving change 2026-06-18-protocol-registry. Update Purpose after archive.
## Requirements
### Requirement: 协议身份维度 MUST 由 `shared/protocols.ts` 单源定义

系统 SHALL 在 `shared/protocols.ts` 导出一个 `PROTOCOL_REGISTRY` 常量,其类型为 `Record<ProtocolId, ProtocolDescriptor>`。每个 `ProtocolDescriptor` MUST 声明以下字段:`id`(协议标识)、`label`(展示名)、`strippedPaths`(去掉 `/v1` 前缀后的认领路径数组)、`defaultTestModel`(测试连接用的廉价模型)、`schemaDocRef`(对应的 `docs/protocols/` 文档路径)。

**Rationale:** 协议身份此前散落在 6 处,加协议要改 6 处且容易漂移。单源 registry 让"协议有哪些、每个协议长什么样"只有一处真相。

#### Scenario: 三个协议均已在 registry 注册
- **WHEN** 读取 `shared/protocols.ts`
- **THEN** `PROTOCOL_REGISTRY` MUST 包含键 `anthropic-messages`、`openai-chat`、`openai-responses`
- **AND** 每个条目 MUST 有非空的 `label`、`strippedPaths`(至少一个元素)、`defaultTestModel`、`schemaDocRef`

#### Scenario: registry 字段指向真实存在的 schema 文档
- **WHEN** 读取任一 descriptor 的 `schemaDocRef`
- **THEN** 该路径 MUST 指向 `docs/protocols/` 下真实存在的 markdown 文件

### Requirement: `EndpointType` 联合类型 MUST 从 registry 派生,不得手写

`src/types.ts` 和 `server/types.ts` 中的 `EndpointType` 类型、`ENDPOINT_TYPES` 数组、`ENDPOINT_LABELS` 映射、`isEndpointType` 类型守卫 SHALL 全部从 `PROTOCOL_REGISTRY` 派生(`type EndpointType = keyof typeof PROTOCOL_REGISTRY`),MUST NOT 出现手写的 `'anthropic-messages' | 'openai-chat' | 'openai-responses'` 联合字面量。

**Rationale:** 两份手写联合类型是历史漂移源(加协议忘改其中一份)。派生后,加协议只需改 registry 一处,两份 types 自动同步。

#### Scenario: 不存在手写协议联合类型
- **WHEN** 在 `src/types.ts` 或 `server/types.ts` 中搜索 `EndpointType` 的定义
- **THEN** 其定义 MUST 引用 `shared/protocols.ts` 导出的 `ProtocolId`
- **AND** MUST NOT 出现 `'anthropic-messages' | 'openai-chat' | 'openai-responses'` 字面量联合

#### Scenario: 两份 types 的 EndpointType 一致
- **WHEN** 比较 `src/types.ts` 与 `server/types.ts` 的 `ENDPOINT_TYPES`
- **THEN** 两者 MUST 引用同一个 `PROTOCOL_IDS` 派生源
- **AND** 两者的值 MUST 相等

### Requirement: path → protocol 检测 MUST 只有单一规则源

从请求路径推断协议类型的逻辑(`endpoint-handlers` 的 `matchPath` 与 `context-extractors.detectEndpointType`)SHALL 共用同一组 `strippedPaths` 字面量——即 `PROTOCOL_REGISTRY` 中各协议的 `strippedPaths` 字段。MUST NOT 在这两个文件或其他任何文件中重复硬编码 `/messages`、`/chat/completions`、`/completions`、`/responses` 等 path 字面量。

**Rationale:** 此前 `detectEndpointType`(判断 `/v1/messages`)与 `matchPath`(判断 `/messages`)是两套独立硬编码,职责不同但 path 字面量重复维护,是静默漂移温床。单源后两套逻辑共用同一组字面量,改一处即两处生效。

#### Scenario: strippedPath 字面量只出现在 registry
- **WHEN** 全项目搜索字符串字面量 `/messages`、`/chat/completions`、`/responses`
- **THEN** 这些字面量 MUST 只出现在 `shared/protocols.ts` 的 `strippedPaths` 定义中
- **AND** MUST NOT 出现在 `endpoint-handlers.ts`、`context-extractors.ts` 或其他业务代码中

#### Scenario: detectEndpointType 委托 registry
- **WHEN** `context-extractors.detectEndpointType` 拆出 strippedPath 后
- **THEN** 它 MUST 调用 registry 的 `inferEndpointTypeFromPath(strippedPath)` 而非内联 if 判断
- **AND** 旧日志兼容路径(`url.includes('/v1/messages')` 等 fallback)的匹配常量 MUST 从 registry 派生

### Requirement: `strippedPaths` 不得跨协议重叠

`PROTOCOL_REGISTRY` 中任意两个不同协议的 `strippedPaths` 数组 MUST 没有交集。`inferEndpointTypeFromPath` 依赖遍历 registry 返回第一个匹配项,若 path 跨协议重叠会导致误判。

**Rationale:** 这是不变量约束。当前三协议无冲突(`/completions` 仅 openai-chat 有),但需明文记录以防未来加协议时引入歧义 path。

#### Scenario: 注册时断言无重叠
- **WHEN** `shared/protocols.ts` 模块加载(或单元测试运行)
- **THEN** 所有协议的 `strippedPaths` 展平后 MUST 无重复元素

### Requirement: 测试连接模型 MUST 从 registry 读取

「测试连接」功能使用的廉价模型(`server/routes/providers.ts` 中的 probe 请求 model 字段)SHALL 从 `PROTOCOL_REGISTRY[type].defaultTestModel` 读取。`server/constants.ts` 中的 `TEST_MODELS` 常量 MUST 被删除。

**Rationale:** `TEST_MODELS` 此前是与协议定义无关联的孤儿常量,模型名与协议身份分两处维护。并入 registry 后,协议与其测试模型绑定定义。

#### Scenario: TEST_MODELS 常量已移除
- **WHEN** 搜索 `server/constants.ts`
- **THEN** MUST NOT 存在 `TEST_MODELS` 导出
- **AND** `server/routes/providers.ts` 的 probe 请求 MUST 引用 `PROTOCOL_REGISTRY[...].defaultTestModel`

### Requirement: `shared/` 目录 MUST 被 tsconfig 显式 include

`tsconfig.json` 的 `include` 字段 MUST 显式包含 `"shared"`,使 `shared/protocols.ts` 和 `shared/sse-events.ts` 在任何 `tsc` 调用下都被纳入编译。

**Rationale:** 此前 `shared/sse-events.ts` 前后端共用但未被 include,靠相对路径 import 顺带编译,单独 `tsc` 或某些工具链下有漏编译风险。本 change 顺手修掉。

#### Scenario: tsconfig include 包含 shared
- **WHEN** 读取 `tsconfig.json` 的 `include` 字段
- **THEN** 该数组 MUST 包含 `"shared"`

