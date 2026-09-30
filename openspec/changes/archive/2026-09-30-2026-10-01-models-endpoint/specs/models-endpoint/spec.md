## ADDED Requirements

### Requirement: 代理 SHALL 识别 models 列表路径并转发

代理 SHALL 识别以下 models 列表请求路径并转发上游,不再返回 404 `unsupported endpoint path`:

- `/{name}/v1/models` 与 `/{name}/models`(预设 provider)
- `/custom/{name}/v1/models` 与 `/custom/{name}/models`(自定义 provider)

匹配 SHALL 采用 stripped path 全等(去 `/v1` 前缀后恰为 `/models`),不模糊匹配;query string SHALL 原样透传;HTTP method 不限(标准为 GET)。

**Rationale:** AI 客户端接入 provider 前普遍先调 `/v1/models` 拉模型列表,404 导致自定义 provider 无法被此类客户端接入。内置与自定义 provider 在代理层本就一视同仁,统一支持即同时覆盖。

#### Scenario: 预设 provider 的 /v1/models 转发成功
- **WHEN** 客户端 `GET /{name}/v1/models`,且该 provider 存在至少一个非 null endpoint
- **THEN** 代理 SHALL 转发到上游 `{baseUrl}/models` 并把上游响应(状态码 + body)原样返回
- **AND** 上游收到的 path SHALL 为 `/v1/models`

#### Scenario: /custom 变体与无版本前缀形式
- **WHEN** 客户端分别请求 `GET /custom/{name}/v1/models` 与 `GET /{name}/models`
- **THEN** 两者 SHALL 与 `GET /{name}/v1/models` 行为一致(转发上游 `/models`)

#### Scenario: query string 透传
- **WHEN** 客户端 `GET /{name}/v1/models?limit=2`
- **THEN** 上游收到的完整 URL SHALL 带 `?limit=2`

#### Scenario: 非法 provider 名不变
- **WHEN** 客户端请求 `/{name}/v1/models` 但 `{name}` 不存在
- **THEN** 代理 SHALL 返回 404 `provider '{name}' not found`(与现有行为一致)

### Requirement: models 上游目标 SHALL 默认 OpenAI 优先,并支持 `?protocol=` 显式隔离

models 端点协议无关,路径不含协议信息。目标解析规则:

- **默认**(请求无 `protocol` 参数):按 `openai-chat` → `openai-responses` → `anthropic-messages` 顺序取 provider 中第一个非 null endpoint(OpenAI list 格式是生态事实标准,聚合中转几乎统一返回此格式);
- **显式隔离**(query 参数 `protocol=<p>`):`anthropic` 或 `anthropic-messages` → anthropic-messages endpoint;`openai` → openai 系(`openai-chat` → `openai-responses` 顺序取首个非 null);协议 id 全名(`openai-chat` / `openai-responses` / `anthropic-messages`)精确指定对应 endpoint;
- 指定(或默认解析)目标 endpoint 为 null 时 SHALL 返回 404 `provider '{name}' does not support models`(显式指定时同样 404,不静默回退其他协议);
- `protocol` 值非法时 SHALL 返回 400;
- `protocol` 参数 SHALL 在转发前从 query 剥离,不透传上游;其余 query 参数原样透传。

**Rationale:** OpenAI 与 Anthropic 的 `/v1/models` 路径相同但响应格式不同,代理透明转发不转换格式——默认 OpenAI 优先贴合生态现实;`?protocol=` 提供隔离的显式指定,两种 models 格式可分别稳定获取,且不引入新配置项或新路径。

#### Scenario: 默认优先 OpenAI 系
- **WHEN** provider 的 `openai-chat` 与 `anthropic-messages` endpoint 均非 null,客户端请求 models 路径且不带 `protocol` 参数
- **THEN** 代理 SHALL 固定转发到 `openai-chat` endpoint 的 `{baseUrl}/models`

#### Scenario: 默认回退唯一非 null endpoint
- **WHEN** provider 仅 `anthropic-messages` endpoint 非 null
- **THEN** models 请求(无 `protocol`)SHALL 转发到该 endpoint

#### Scenario: 全 null endpoint
- **WHEN** provider 三个 endpoint 均为 null,客户端请求其 models 路径
- **THEN** 代理 SHALL 返回 404 `provider '{name}' does not support models`

#### Scenario: protocol=anthropic 显式隔离
- **WHEN** 客户端请求 `/{name}/v1/models?protocol=anthropic`,且 `anthropic-messages` endpoint 非 null
- **THEN** 代理 SHALL 转发到 anthropic-messages endpoint(返回 Anthropic 格式 models)
- **AND** 上游收到的 query SHALL NOT 含 `protocol` 参数

#### Scenario: 显式指定但 endpoint 不支持
- **WHEN** 客户端请求 `?protocol=anthropic` 但 provider 的 anthropic-messages endpoint 为 null
- **THEN** 代理 SHALL 返回 404,SHALL NOT 回退到其他协议 endpoint

#### Scenario: 非法 protocol 值
- **WHEN** 客户端请求 `?protocol=bogus`
- **THEN** 代理 SHALL 返回 400

#### Scenario: 其余 query 参数不受影响
- **WHEN** 客户端请求 `/{name}/v1/models?limit=2&protocol=openai`
- **THEN** 上游收到的 query SHALL 为 `?limit=2`(`protocol` 剥离,`limit` 透传)

### Requirement: models 转发 SHALL 保持透明语义并遵守字面量单源

models 转发 SHALL 与聊天端点共享同一套透明语义:鉴权头纯透传不修改、响应头/body 原样返回、复用既有超时与断开传播护栏。代理 SHALL NOT 在转发头注入 `x-lucent-endpoint`(`EndpointType` 保持协议身份纯净,models 不得进入协议联合类型);`x-lucent-provider` SHALL 照常注入。

`/models` 路径字面量 SHALL 在 `shared/protocols.ts` 唯一声明导出(如 `MODELS_PATH`),`proxy.ts` 与测试从此引用;MUST NOT 在其他业务文件硬编码。该常量 MUST NOT 加入任何协议的 `strippedPaths`(models 是协议无关端点,进入 strippedPaths 会破坏 protocol-model spec 的协议身份与无交集约束)。

**Rationale:** 透明是代理的核心契约;models 端点只是新增一条可识别路径,不引入第二套转发语义。字面量单源延续 protocol-model spec 的防漂移原则。

#### Scenario: 鉴权头透传
- **WHEN** 客户端带 `x-api-key` / `authorization` 头请求 models 路径
- **THEN** 上游收到的请求 SHALL 原样携带这些头

#### Scenario: lucent 内部头不泄露给上游
- **WHEN** models 请求经代理转发
- **THEN** 上游收到的请求头 SHALL NOT 含 `x-lucent-provider`、`x-lucent-endpoint` 及代理追踪头

#### Scenario: EndpointType 保持协议纯净
- **WHEN** 审查 `server/types.ts` 与 `shared/protocols.ts`
- **THEN** `EndpointType` / `ProtocolId` SHALL NOT 含 `'models'` 成员
- **AND** `PROTOCOL_REGISTRY` 各协议的 `strippedPaths` SHALL NOT 含 `/models`

#### Scenario: models 字面量单源
- **WHEN** 全项目搜索 models 路径字面量 `'/models'`
- **THEN** 业务代码(proxy.ts 等)SHALL 从 `shared/protocols.ts` 的导出常量引用
- **AND** 测试文件可引用同一常量

### Requirement: models 代理流量 SHALL 正常落日志

models 请求经代理转发后 SHALL 与聊天流量一样写入请求日志:`providerName` 正确记录;`endpointType` / `apiType` SHALL 为空(协议维度不适用);响应为普通 JSON 时走既有非流式记录链路。

**Rationale:** 全量记录是产品核心能力,models 流量不应成为记录盲区;拦截器对 `endpointType=null` 已容错,无需改动拦截器。

#### Scenario: models 请求落库
- **WHEN** 客户端 `GET /{name}/v1/models` 成功返回后查询日志
- **THEN** 日志中 SHALL 存在该条目,`providerName` 等于 `{name}`
- **AND** 其 `endpointType` / `apiType` SHALL 为空

### Requirement: 标准 mock 上游 SHALL 支持 models 响应

`tests/e2e-helpers.ts` 的 `createMockUpstream` SHALL 支持 `/models` 请求:

- `format: 'auto'`:URL 含 `/models` → 返回 OpenAI list 格式 `{ object: 'list', data: [{ id, object: 'model', created, owned_by }] }`(生态事实标准);
- `format: 'anthropic'`:`/models` → Anthropic 格式 `{ data: [{ id, type: 'model', display_name }], has_more: false }`;
- `format: 'openai'`:同 auto 的 OpenAI list 格式。

SHALL 提供 `setModels(ids: string[])` 配置响应中的模型 id 列表,未配置时返回一组固定默认示例 id;`reset()` SHALL 不清除 `setModels` 的配置。

**Rationale:** mock 上游是所有 e2e 的统一验收基建(models-endpoint 契约的验证依赖它),扩展而非另建 mock 服务,符合逻辑沉淀政策。

#### Scenario: auto 模式响应 models
- **WHEN** mock 上游(format auto)收到 `GET /v1/models`
- **THEN** SHALL 返回 200 + OpenAI list 格式 JSON
- **AND** `data[].id` SHALL 等于 `setModels` 配置(未配置时为默认示例 id)

#### Scenario: anthropic 格式实例响应 models
- **WHEN** mock 上游(format anthropic)收到 `GET /v1/models`
- **THEN** SHALL 返回 Anthropic 格式 models JSON(`data[].type === 'model'`)

#### Scenario: setModels 与请求记录
- **WHEN** 测试调用 `setModels(['m-a','m-b'])` 后请求 `/models`
- **THEN** 响应 `data[].id` SHALL 恰为 `['m-a','m-b']`
- **AND** 该请求 SHALL 出现在 mock 的 `requests` 记录中(与聊天请求同等记录)

### Requirement: 设置界面 SHALL 在上游接入地址旁提供地址关联与用法映射说明

设置弹窗(`SettingsModal`)provider 展开编辑区的"上游接入地址"标题旁 SHALL 展示提示图标(圆圈叹号形态,antd `InfoCircleOutlined`),hover 时展示说明,内容 MUST 覆盖:

1. **上游地址语义**:上游接入地址是真实 API 的 base URL,须含 `/v1`(与 provider-baseurl spec 一致);
2. **下游 → 上游映射**:客户端将"下游接入地址"配置为 baseUrl;代理按 `/v1` 去重规则转发(下游 `/{name}/v1/xxx` → 上游 `{baseUrl}/xxx`),鉴权头原样透传;
3. **models 行为**:`/v1/models` 默认转发到 OpenAI 系端点(OpenAI list 格式),`?protocol=` 可显式指定协议。

该改动 SHALL 为纯展示,不改变任何配置读写与转发行为。

**Rationale:** 上游/下游两个地址的映射关系(/v1 去重、路径拼接、鉴权透传、models 格式)是接入时最常见的困惑点,在配置入口处就地解释可减少误配。

#### Scenario: 提示图标存在且可触发说明
- **WHEN** 打开设置弹窗并展开任一 provider 的编辑区
- **THEN** "上游接入地址"标题旁 SHALL 存在提示图标
- **AND** hover 图标后 SHALL 出现说明内容,且内容包含 `/v1`、鉴权透传与 models 说明要点

#### Scenario: 纯展示不引入行为变化
- **WHEN** 审查该 UI 改动的 diff
- **THEN** SHALL NOT 修改 provider 配置的读写逻辑、代理转发逻辑或测试连接行为
