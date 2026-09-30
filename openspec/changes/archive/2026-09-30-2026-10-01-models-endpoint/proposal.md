## Why

代理对 `GET /{name}/v1/models`(models 列表)一律返回 404 `unsupported endpoint path`——`inferEndpointType` 只认三协议聊天端点(`shared/protocols.ts` 的 strippedPaths),`/models` 被挡在路径推断层。**内置与自定义 provider 行为完全一致,都没支持**;但 AI 客户端(Claude Code / opencode / Cherry Studio 等)接入任意 provider 前普遍会先调 `/v1/models` 拉模型列表做校验与展示,404 直接导致这些客户端无法接入自定义 provider。需要统一支持 models 端点,自定义 provider 自然覆盖。

同时,现有 e2e 的标准 mock 上游(`tests/e2e-helpers.ts` 的 `createMockUpstream`)按 URL 子串分流,只认 `/messages` `/chat/completions` `/responses`,`/models` 直接 404——测试 models 转发前必须先扩展它,这也是本 change 的验收基建。

## What Changes

### 代理转发(server/proxy.ts)

- 新增 models 端点旁路:路径 `/{name}/v1/models`、`/{name}/models` 及 `/custom/{name}/` 变体不再 404,转发到上游 `{baseUrl}/models`(去 `/v1` 前缀规则与聊天端点一致,`baseUrl` 必须含 `/v1`,见 provider-baseurl spec)。
- query string 原样透传(如 `?limit=20`);HTTP method 不限(标准为 GET),与代理透明转发语义一致。
- 上游目标解析(models 协议无关,无路径信息可推断协议):**默认 OpenAI 优先**——按 `openai-chat` → `openai-responses` → `anthropic-messages` 顺序取第一个非 null endpoint(OpenAI list 格式是生态事实标准,聚合中转几乎统一返回此格式);三个全 null → 404 `provider 'X' does not support models`。
- **显式协议隔离**:`GET .../v1/models?protocol=<p>` 限定转发目标——`anthropic` / `anthropic-messages` → anthropic-messages endpoint;`openai` → openai 系(openai-chat → openai-responses);协议 id 全名(`openai-chat` / `openai-responses` / `anthropic-messages`)精确指定。指定协议的 endpoint 为 null → 404;非法值 → 400。`protocol` 参数转发前从 query 剥离,不透传上游。这样 OpenAI 与 Anthropic 两种 models 格式可分别获取,互不干扰。
- 转发语义与聊天端点完全一致:鉴权头纯透传、body 重写链路对 GET 空 body 自然跳过、超时/断开传播复用现有护栏。
- **不注入** `x-lucent-endpoint`(`EndpointType` 保持协议纯净,不往联合类型塞 `'models'`);`x-lucent-provider` 照常注入。

### 路径字面量单源(shared/protocols.ts)

- `MODELS_PATH = '/models'` 常量在 `shared/protocols.ts` 唯一声明(协议无关端点,不进 PROTOCOL_REGISTRY 的 strippedPaths——那会破坏"strippedPaths 无交集/协议身份"约束),`proxy.ts` 及测试从此引用,遵守 protocol-model spec 的"path 字面量单源"原则。

### 日志记录(server/interceptor.ts)

- models 代理流量正常落日志:`providerName` 记录;`endpointType`/`apiType` 为空(拦截器对 null 已容错),按 URL 识别;响应为普通 JSON,走既有 `handleNormalResponse` 链路,无需改动拦截器代码。

### mock 上游(tests/e2e-helpers.ts)

- `createMockUpstream` 支持 `/models`:
  - `auto` 模式:URL 含 `/models` → 返回 OpenAI list 格式 `{ object: 'list', data: [{ id, object: 'model', ... }] }`(生态事实标准,聚合中转普遍返回此格式);
  - `anthropic` 固定格式实例 → Anthropic 格式(`{ data: [{ id, type: 'model', display_name }] }`);
  - `openai` 固定格式实例 → OpenAI list 格式;
  - 新增 `setModels(ids: string[])` 配置模型 id 列表,默认一组固定示例 id。

### 设置界面映射说明(src/components/settings/SettingsModal.tsx)

- provider 展开编辑区的"**上游接入地址**"标题旁新增提示图标(圆圈叹号 `InfoCircleOutlined` + antd `Tooltip`),hover 展示地址关联说明与配置用法映射:
  - 上游地址语义:真实 API 的 base URL,须含 `/v1`(与 provider-baseurl spec 一致);
  - 下游 → 上游映射:客户端把"下游接入地址"配置为 baseUrl,代理按 `/v1` 去重规则转发(下游 `/{name}/v1/xxx` → 上游 `{baseUrl}/xxx`),鉴权头原样透传;
  - models 行为:`/v1/models` 默认转发到 OpenAI 系端点(OpenAI list 格式),`?protocol=` 可显式指定协议。
- 仅展示层改动,不改任何交互逻辑。

### 不做(明确出 scope)

- **测试连接不改**:`routes/providers.ts` 的连接测试继续用 `defaultTestModel` 发最小聊天请求。改为 `GET /models`(零 token)是行为变更,值得单独 change,本 change 不动。
- **不提供独立 mock CLI**:现有 `createMockUpstream` 已是所有 e2e 的统一 mock 基建,扩展它即可满足验收;独立可跑的 mock 服务如有需要另提。
- UI 不动(provider 编辑/详情无需感知 models 端点)。

## Capabilities

### New Capabilities
- **models-endpoint**:代理对 models 列表端点的识别、目标解析(默认 OpenAI 优先 + 显式协议隔离)、透明转发契约,及设置界面接入地址映射说明(见 `specs/models-endpoint/spec.md`)。

### Modified Capabilities
无(转发行为纯增量,聊天端点路径与行为不变)。

## Impact

- **受影响代码**:
  - [`shared/protocols.ts`](../../../shared/protocols.ts):导出 `MODELS_PATH` 常量(纯新增)。
  - [`server/proxy.ts`](../../../server/proxy.ts):models 路径识别 + 目标解析旁路(聊天端点链路不动)。
  - [`src/components/settings/SettingsModal.tsx`](../../../src/components/settings/SettingsModal.tsx):上游接入地址旁提示图标 + Tooltip(纯展示)。
  - [`tests/e2e-helpers.ts`](../../../tests/e2e-helpers.ts):mock 上游支持 `/models` + `setModels`。
  - [`tests/`](../../../tests/):新增 models 转发 e2e(转发、query 透传、`?protocol=` 隔离、全 null 404、/custom 变体、日志落库)+ 单测(路径识别、优先级解析、字面量单源断言)+ Playwright UI 断言(tooltip 展示)。
- **不改**:`shared/protocols.ts` 的 `PROTOCOL_REGISTRY` 与 `strippedPaths`、`EndpointType` 类型、三协议 handler/extractor、`routes/providers.ts`、拦截器、其余 UI(仅 SettingsModal 加提示图标)。
- **新增风险**:
  - **models 格式歧义**:同一 provider 多 endpoint 时返回哪个协议的 models 列表由优先级决定——默认 OpenAI 系优先(生态事实标准),需要 Anthropic 格式时用 `?protocol=` 显式隔离。透明代理不转换格式,格式由所转发上游决定。
  - **路径误伤**:`/models` 是常见前缀子串(如未来某协议出现 `/models/xxx`),旁路匹配用全等(stripped 后恰为 `/models`),不模糊匹配,规避误伤。
