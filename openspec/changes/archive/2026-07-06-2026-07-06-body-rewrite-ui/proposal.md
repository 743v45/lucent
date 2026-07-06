## Why

body 重写引擎（[`body-rewrite`](../../openspec/specs/body-rewrite/spec.md) capability）已
落地并 archive，但用户只能**手编 `~/.lucent/config.json`** 来增删改规则——这把一个本该
轻量的脱敏出口变成了「改文件 → 校验 → 重启心智负担」的流程，并且：

- 手编 JSON 容易漏字段、写错 `fieldPath`/`pattern`，要等下次请求甚至启动时
  `validateBodyRewrites` 才报错，反馈链太长。
- 调正则尤其需要**即时反馈**：用户写 `x-anthropic-billing-header:[^;]*;` 时，最想知道的是
  「这段样例文本跑完到底替换成什么」——没有试跑预览，只能盲打、发请求、看日志回溯。

所以需要在已落地的引擎之上叠加一层 **Web UI 动态配置**：顶栏独立按钮打开
`BodyRewriteModal`，列表式增删改规则、字段失焦自动保存、试跑预览即时显示替换结果，
CRUD 经 REST API 落到 config，proxy 每请求读最新 config → **保存即生效，无需 reload**。
本层只改配置入口，**不改引擎语义、透明性、副作用**。

## What Changes

- **后端 CRUD route**：新增
  [`server/routes/body-rewrites.ts`](../../server/routes/body-rewrites.ts)，挂载到
  [`server/routes/index.ts`](../../server/routes/index.ts)，提供四个端点：
  - `GET /api/body-rewrites` → 返回 `BodyRewriteRule[]`
  - `POST /api/body-rewrites` → 新增（`id` 后端生成，不接受客户端 id）
  - `PUT /api/body-rewrites/:id` → 更新（`id` 路径锁定，不可改）
  - `DELETE /api/body-rewrites/:id` → 删除
- **config CRUD helper**：
  [`server/config.ts`](../../server/config.ts) 加 `getBodyRewrites` /
  `addBodyRewrite` / `updateBodyRewrite` / `deleteBodyRewrite`，内部走
  `validateBodyRewrites` + `saveConfig`（写回 `~/.lucent/config.json`）。
- **前端 Modal**：新增
  [`src/components/settings/BodyRewriteModal.tsx`](../../src/components/settings/BodyRewriteModal.tsx)，
  列表式编辑 `name`/`enabled`/`fieldPath`/`pattern`/`flags`/`replacement`，字段失焦自动
  PUT 保存；新增规则走 POST，删除走 DELETE。
- **顶栏入口**：
  [`src/App.tsx`](../../src/App.tsx) 顶栏加独立按钮
  （`WrenchScrewdriverIcon`，`title="Body 重写规则"`），点击打开 BodyRewriteModal；与
  其它配置入口平级，不嵌入既有 Settings modal。
- **试跑预览**：Modal 内输入样例文本，前端用规则的 `pattern`+`flags`（缺省 `g`）构造
  `RegExp` 本地 `replace`，即时显示结果；非法正则 / 非法 flags 显示错误提示而非崩溃。
- **前端 API 封装**：
  [`src/utils/api.ts`](../../src/utils/api.ts) 加 `listBodyRewrites` /
  `createBodyRewrite` / `updateBodyRewrite` / `deleteBodyRewrite`；
  [`src/types.ts`](../../src/types.ts) 加 `BodyRewriteRule` 副本（与
  [`server/types.ts`](../../server/types.ts) 同构）。
- **E2E 验收**：新增
  [`scripts/verify-body-rewrite-ui-e2e.ts`](../../scripts/verify-body-rewrite-ui-e2e.ts) +
  `npm run verify:body-rewrite-ui`（`package.json` 已加）。
- **文档**：更新
  [request-transformation-design §7.3](../../docs/superpowers/specs/2026-06-19-request-transformation-design.md#L271)
  加「UI 动态配置」小节。

## Capabilities

### New Capabilities
无。

### Modified Capabilities
- `body-rewrite`：扩展 UI 动态配置范围。新增契约：顶栏独立按钮入口、`BodyRewriteModal`
  CRUD 交互、REST API 四端点（GET/POST/PUT/DELETE `/api/body-rewrites[/:id]`）、`id` 后端
  生成且 PUT 不可改、字段失焦自动保存、前端试跑预览（`RegExp` 构造 + `replace` 即时显
  示）、非法正则前端报错不崩溃、CRUD 经 `saveConfig` 落盘且 proxy 每请求读最新 config
  （保存即生效，无 reload）。本扩展**不修改**引擎既有的 8 条 Requirement（规则结构 /
  fieldPath 语法 / 子串替换语义 / flags 约束 / 顺序级联 / 零命中透明 / 失败回退 / 严格
  校验），UI 仅是配置入口。

## Impact

- **受影响代码**：
  - [`src/App.tsx`](../../src/App.tsx)：顶栏加独立按钮（WrenchScrewdriverIcon）。
  - [`src/utils/api.ts`](../../src/utils/api.ts)：4 个 CRUD 封装函数。
  - [`src/types.ts`](../../src/types.ts)：`BodyRewriteRule` 副本。
  - [`server/routes/index.ts`](../../server/routes/index.ts)：挂载 body-rewrites router。
  - [`server/config.ts`](../../server/config.ts)：4 个 CRUD helper（复用
    `validateBodyRewrites` + `saveConfig`）。
- **新增文件**：
  - [`server/routes/body-rewrites.ts`](../../server/routes/body-rewrites.ts)：CRUD route。
  - [`src/components/settings/BodyRewriteModal.tsx`](../../src/components/settings/BodyRewriteModal.tsx)。
  - [`scripts/verify-body-rewrite-ui-e2e.ts`](../../scripts/verify-body-rewrite-ui-e2e.ts)。
- **受影响 npm scripts**：`package.json` 新增 `verify:body-rewrite-ui`。
- **不改变**：引擎语义（子串替换 / flags 缺省 g / 顺序级联）、默认零变化与字节透明、
  失败回退铁律、严格校验规则、KV-Cache/agent 分类等副作用（这些副作用由引擎固有，
  UI 只是更方便地触发它们——Modal 内仍需对 `system[0].text` 类规则提示 cache 影响）。
- **新增风险（UI 特有）**：
  - 试跑预览在前端用与后端**相同语义**的 `new RegExp(pattern, flags ?? 'g')` 跑，前后端
    必须一致，否则预览与实际效果不符（契约已锁定一致）。
  - `id` 后端生成 → 客户端 POST 后必须以响应里的 `id` 为准刷新本地列表，避免用临时 id
    发后续 PUT/DELETE 失败。
- **不影响**：响应 body 重写、协议路由、Header 变换、三协议路径解析、proxy 请求转发路径
  （CRUD 只动 config 文件，转发路径仍按引擎既有逻辑读 config）。
