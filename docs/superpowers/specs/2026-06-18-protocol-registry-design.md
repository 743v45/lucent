# 三协议 Registry 单源设计

> 日期: 2026-06-18
> 状态: 设计已确认,待写实现计划
> 关联 openspec change: `openspec/changes/2026-06-18-protocol-registry/`

## 背景与问题

Lucent 支持三个上游协议:`anthropic-messages`、`openai-chat`、`openai-responses`。

调研发现现状是**"半个 Registry"**:

- `server/endpoint-registry.ts` + `server/endpoint-handlers.ts` 已经把三协议的 **path 匹配 + SSE 结构化提取 + context 提取** 收口了,通过 `registerEndpoint()` 在模块加载时注册。这是好的。
- 但协议的**身份维度**(id / label / path 字面量 / test model / schema 引用)**散落在 6 处**:

| 维度 | 现在在哪 | 问题 |
|---|---|---|
| `EndpointType` 联合类型 | `src/types.ts` + `server/types.ts` **两份重复** | 加协议要改两处,可能漂移 |
| `ENDPOINT_TYPES[]` / `ENDPOINT_LABELS` | 同上两份 | 同上 |
| path → type 检测 | `context-extractors.detectEndpointType` **重写一遍** path 映射 | 与 `endpoint-handlers.matchPath` 是两套规则,漂移温床 |
| `TEST_MODELS` | `server/constants.ts` | 孤儿常量 |
| 配色 | `src/constants/protocol-colors.ts` | 前端独立,合理保留 |
| preset baseUrl | `src/constants/presets.ts` | 已有 `provider-baseurl` spec 约束 |
| schema 参考 | `docs/protocols/*.md` | 已是权威库,但跟代码无引用关系 |

**两个具体风险**:

1. **两套 path 规则**:`endpoint-registry.matchPath` 接收已去 `/v1` 前缀的 stripped path(`/messages`),而 `detectEndpointType` 接收完整 URL 自己拆 `/custom/{name}/` + 判断 `/v1/messages`。path 字面量(`/messages` vs `/v1/messages`)在两处各自维护,改一处忘改另一处就会静默漂移。
2. **tsconfig 隐患**:`shared/sse-events.ts` 前后端共用,但 `tsconfig.json` 的 `include` 是 `["src", "server", "bin"]`,**没有 `shared`**。现在能跑是因为 src/server 通过相对路径 import 时顺带编译了它,但单独跑 `tsc` 或某些工具链配置下可能漏掉。

## 设计目标

把三协议的**身份维度**收口到 `shared/protocols.ts` 单源,使:

- 加新协议的改动面最小化(身份维度定义改 1 处,运行时逻辑改 1 处)
- path → protocol 检测只有一套规则
- `EndpointType` 联合类型不再手写,从 registry 派生
- 顺手修掉 tsconfig 未 include `shared` 的隐患

**不做的事(YAGNI)**:
- 不重构 SSE 提取 / context 提取的**函数体**——它们带 `acc`/`body` 参数的业务逻辑,留在 `server/endpoint-handlers.ts`,只是 path pattern 从 registry 读
- 不收口配色/icon——纯前端关注点,留 `src/constants/protocol-colors.ts`
- 不收口 preset baseUrl——已由 `provider-baseurl` spec 管控,且 baseUrl 是 per-provider 而非 per-protocol

## 方案: `shared/protocols.ts` 单源 + 派生

延续 `shared/sse-events.ts` 已建立的"跨端共享放 shared"先例(不是新发明)。

### 数据模型 — `ProtocolDescriptor`

新建 `shared/protocols.ts`,核心是纯数据描述符表:

```typescript
// shared/protocols.ts
export const PROTOCOL_REGISTRY = {
  'anthropic-messages': {
    id: 'anthropic-messages',
    label: 'Anthropic Messages',
    /** 去掉 /v1 前缀后的 path，协议认领依据（registry.matchPath + detect 共用单源） */
    strippedPaths: ['/messages'],
    /** 测试连接用的廉价模型 */
    defaultTestModel: 'claude-sonnet-4-20250514',
    /** 对应 docs/protocols/ 的权威 schema 文档 */
    schemaDocRef: 'docs/protocols/01-anthropic-messages.md',
  },
  'openai-chat': {
    id: 'openai-chat',
    label: 'OpenAI Chat',
    strippedPaths: ['/chat/completions', '/completions'],
    defaultTestModel: 'gpt-4o-mini',
    schemaDocRef: 'docs/protocols/02-openai-chat-completions.md',
  },
  'openai-responses': {
    id: 'openai-responses',
    label: 'OpenAI Responses',
    strippedPaths: ['/responses'],
    defaultTestModel: 'gpt-4o-mini',
    schemaDocRef: 'docs/protocols/03-openai-responses.md',
  },
} as const;

export type ProtocolId = keyof typeof PROTOCOL_REGISTRY;
export const PROTOCOL_IDS = Object.keys(PROTOCOL_REGISTRY) as ProtocolId[];
```

**不变量**:`strippedPaths` 不得跨协议重叠(否则 `inferEndpointTypeFromPath` 遍历时会误判)。

### 派生关系

**`EndpointType` 收口**(消除两份手写联合类型):

```typescript
// src/types.ts 和 server/types.ts 都改成:
import { ProtocolId, PROTOCOL_IDS, PROTOCOL_REGISTRY } from '../shared/protocols.js';

export type EndpointType = ProtocolId;
export const ENDPOINT_TYPES: EndpointType[] = PROTOCOL_IDS;
export const ENDPOINT_LABELS: Record<EndpointType, string> =
  Object.fromEntries(PROTOCOL_IDS.map(id => [id, PROTOCOL_REGISTRY[id].label])) as Record<EndpointType, string>;
```

两份 types 文件仍各自存在(它们还装着各自运行时的其他类型),但协议相关的**联合类型源头**变成 shared——保证一致。

**path 单源**:

- `endpoint-handlers` 注册时,`matchPath` 改成 `descriptor.strippedPaths.includes(strippedPath)`
- `context-extractors.detectEndpointType` 删掉内部硬编码 path,拆出 strippedPath 后委托 `inferEndpointTypeFromPath(strippedPath)`(registry 已有的函数)
- **旧日志兼容路径保留**:`url.includes('/v1/messages')` 这种 fallback 是为了读历史日志(无 endpointType 字段),原样保留,只是匹配常量从 registry 派生
- 结果:`/messages`、`/chat/completions`、`/completions`、`/responses` 这几个字面量全项目只出现在 `shared/protocols.ts` 一处

**`TEST_MODELS` 并入**:

- `server/constants.ts` 删除 `TEST_MODELS`
- `server/routes/providers.ts` 三处调用改用 `PROTOCOL_REGISTRY[type].defaultTestModel`

**tsconfig**:`include` 加 `"shared"`,消除现有隐患。

### 刻意不进 registry 的东西

| 项 | 去向 | 理由 |
|---|---|---|
| 配色 hex/className | 留 `src/constants/protocol-colors.ts` | 纯前端关注点,Tailwind className 不应进跨端层 |
| icon 组件 | 留 `src/components/common/ProtocolIcon.tsx` | 同上 |
| preset baseUrl | 留 `src/constants/presets.ts` | per-provider 而非 per-protocol,已有 `provider-baseurl` spec |
| SSE 提取函数体 | 留 `server/endpoint-handlers.ts` | 带 acc/body 参数的业务逻辑,非身份维度 |
| context 提取函数体 | 留 `server/endpoint-handlers.ts` | 同上 |

## 迁移步骤

分 4 个独立 commit,每个可单独验证,降低 bisect 成本。

### Commit 1 — 新建 `shared/protocols.ts`(纯新增,零回归)

- 写 `PROTOCOL_REGISTRY` + `ProtocolId` + `PROTOCOL_IDS`
- tsconfig `include` 加 `"shared"`
- 验证:`npx tsc --noEmit` 通过

### Commit 2 — `EndpointType` 派生化(核心)

- `src/types.ts` 和 `server/types.ts` 的 `EndpointType` / `ENDPOINT_TYPES` / `ENDPOINT_LABELS` / `isEndpointType` 改为从 `PROTOCOL_REGISTRY` 派生
- 两份 types 仍各自存在,只是联合类型源头变 shared
- 验证:`tsc --noEmit` + `npm run test:run`

### Commit 3 — path 单源 + `TEST_MODELS` 并入(高风险)

- `endpoint-handlers` 的 `matchPath` 改读 registry 的 `strippedPaths`
- `context-extractors.detectEndpointType` 删除内部硬编码 path,委托 registry
- `server/constants.TEST_MODELS` 删除,改读 registry
- 验证:**全套 verify**(两套 path 规则合并,必须端到端兜底):
  - `npm run verify:e2e`(路由/URL 拼接层)
  - `npm run verify:anthropic` / `verify:openai-chat` / `verify:openai-responses`(三协议五环节)
  - `npm run verify:custom` / `verify:custom-errors`(自定义供应商多协议)

### Commit 4 — openspec change proposal + archive

- 提 `openspec/changes/2026-06-18-protocol-registry/`(proposal.md + .openspec.yaml)
- `openspec validate` → 实现已完成 → `openspec archive`
- 落地成 `openspec/specs/protocol-model/spec.md`

## 回归风险点

1. **旧日志兼容路径**:`detectEndpointType` 的 `url.includes('/v1/messages')` fallback 是为了读历史日志(无 endpointType 字段)。改写后这个逻辑必须保持,只是匹配常量从 registry 派生。
2. **`/completions` 别名**:`strippedPaths` 数组里 openai-chat 有两个元素(`/chat/completions` + `/completions`)。`inferEndpointTypeFromPath` 遍历时要保证 chat 的两个 path 都能命中。
3. **Map 遍历顺序**:`endpoint-handlers` 的 `registerEndpoint` 调用顺序决定 registry Map 的遍历顺序。目前无 path 冲突,但"strippedPaths 不得跨协议重叠"作为不变量写入 spec,防未来漂移。

## openspec proposal

见 `openspec/changes/2026-06-18-protocol-registry/proposal.md`。落地 spec 将成为 `openspec/specs/protocol-model/spec.md`。

## 验证策略

- Commit 1-2:`tsc --noEmit` + `npm run test:run`(单测/e2e 套件)
- Commit 3:**全套 verify**(`verify:e2e` + 三协议 `verify:*` + `verify:custom*`),任一红则不进 Commit 4
- Commit 4:`openspec validate 2026-06-18-protocol-registry` 过 + archive 成功
