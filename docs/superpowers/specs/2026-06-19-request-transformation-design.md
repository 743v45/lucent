# 请求变换设计文档

> 最后更新：2026-06-19
> 范围：代理服务器对客户端请求的路由解析、URL 变换、Header 变换、Body 透传，及 Provider 配置如何决定请求从进来到出去的完整变换过程。

---

## 1. 概述

Lucent 是一个**透明代理**，坐在 AI 工具（Claude Code / Codex / Cursor 等）和上游大模型 API（Anthropic / OpenAI / 自定义）之间。

核心原则：**请求 Body 和鉴权头一个字不改**。Proxy 只替换目标 URL、强制 `identity` 解压，中间用 `x-lucent-*` 临时头接力日志信息（发给上游前已清除）。

---

## 2. 服务架构

```
┌──────────────────────────────────────────────────────────────────┐
│                        Lucent 进程                                 │
│                                                                   │
│  端口 :7048 — Proxy Server (proxy.ts)                             │
│    接收客户端请求，路由到上游 API                                    │
│                                                                   │
│  端口 :7049 — Express Web UI (index.ts + routes/)                │
│    管理面板 + 日志查询 API                                         │
│                                                                   │
│  globalThis.fetch monkey-patch (interceptor.ts)                   │
│    拦截 Proxy 发出的 fetch 调用，捕获请求/响应写入 JSONL 日志       │
│                                                                   │
└──────────────────────────────────────────────────────────────────┘
```

### 2.1 启动顺序

```
1. Config.loadConfig()              → 读取 ~/.lucent/config.json
2. Config.resolveEffectiveConfig()   → 环境变量覆盖 → ResolvedConfig
3. LogWriter.init() + LogReader.init()
4. startProxyServer({ port: 7048 })  → Node HTTP Server
5. setupInterceptor()               → monkey-patch globalThis.fetch
6. server.listen(7049)              → Express Web UI
```

---

## 3. 配置

### 3.1 配置文件

**位置**: `~/.lucent/config.json`

```json
{
  "host": "127.0.0.1",
  "proxyPort": 7048,
  "webPort": 7049,
  "providers": [
    {
      "id": "uuid-1",
      "name": "anthropic",
      "presetName": "anthropic",
      "endpoints": {
        "anthropic-messages": "https://api.anthropic.com/v1",
        "openai-chat": null,
        "openai-responses": null
      }
    },
    {
      "id": "uuid-2",
      "name": "my-custom",
      "endpoints": {
        "anthropic-messages": "https://my-gateway.example.com/api",
        "openai-chat": "https://another-api.example.com/v1",
        "openai-responses": null
      }
    }
  ]
}
```

### 3.2 Provider 结构

每个 Provider 声明三个端点类型（**必填**，不支持时为 `null`）：

| 端点类型 | 协议 | 匹配路径 (去 /v1 后) |
|---|---|---|
| `anthropic-messages` | Anthropic Messages | `/messages` |
| `openai-chat` | OpenAI Chat Completions | `/chat/completions`, `/completions` |
| `openai-responses` | OpenAI Responses | `/responses` |

### 3.3 预设 vs 自定义 Provider

| 维度 | 预设 Provider | 自定义 Provider |
|---|---|---|
| `presetName` | 有 (如 `"anthropic"`) | 无 |
| `name` | 必须等于 `presetName` | 任意 `[a-zA-Z0-9_-]{1,32}` |
| 路径前缀 | `/{name}/...` | `/custom/{name}/...` |
| 配置方式 | 默认种子 + Web UI 修改端点 | Web UI 新增 |

**为什么需要 `/custom/` 路径前缀**：预设 provider 的 name 是保留名（如 `"anthropic"`），自定义 provider 不能占用保留名。`/custom/` 前缀让路径层区分，避免冲突。代码中两者 lookup 完全等价，都走 `findProviderByName(config, name)`。

### 3.4 环境变量覆盖

优先级：环境变量 > 配置文件 > 默认值

| 环境变量 | 覆盖字段 |
|---|---|
| `LUCENT_HOST` | `host` |
| `LUCENT_PROXY_PORT` | `proxyPort` |
| `LUCENT_WEB_PORT` | `webPort` |
| `LUCENT_LOG_DIR` | `logDir` |
| `LUCENT_LOG_RETENTION_DAYS` | `logRetentionDays` |
| `LUCENT_MAX_LOG_FILE_SIZE` | `maxLogFileSize` |

---

## 4. 请求路径变换

### 4.1 路径格式

```
预设 Provider:    POST http://127.0.0.1:7048/{name}/v1/{endpoint-path}
自定义 Provider:  POST http://127.0.0.1:7048/custom/{name}/v1/{endpoint-path}
```

### 4.2 解析流程

```
请求 URL: /anthropic/v1/messages
                    │
                    ▼
          正则: /^\/(?:custom\/)?([a-zA-Z0-9_-]+)(\/.*)$/
                    │
          ┌─────────┴──────────┐
          │                    │
  providerName="anthropic"  rest="/v1/messages"
          │                    │
          ▼                    ▼
  findProviderByName()   inferEndpointType(rest)
          │                    │
          │                    ▼
          │            去 /v1 → "/messages"
          │            match registry → "anthropic-messages"
          │                    │
          ▼                    ▼
  endpoints: {            provider.endpoints["anthropic-messages"]
    "anthropic-messages":  │
      "https://api.anthropic.com/v1"          │
    ...                           │
  }                                 ▼
                                  "https://api.anthropic.com/v1"
                                        │
                                        ▼
                              baseUrl + apiPath
                              = "https://api.anthropic.com/v1" + "/messages"
                              = "https://api.anthropic.com/v1/messages"
```

### 4.3 变换公式

```
上游 URL = provider.endpoints[endpointType] + apiPath

其中:
  endpointType = inferEndpointType(rest)    ← 从 rest 推断协议类型
  apiPath      = rest 去掉前导 /v1           ← 避免与 baseUrl 中的 /v1 重复
  baseUrl      = provider.endpoints[endpointType]  ← 已含版本路径
```

---

## 5. 三协议变换对照

### 5.1 Anthropic Messages

```
进: POST 127.0.0.1:7048/anthropic/v1/messages
       Authorization: Bearer sk-ant-xxxx
       Content-Type: application/json
       Body: {"model":"claude-sonnet-4","messages":[...],"stream":true}

出: POST https://api.anthropic.com/v1/messages
       Authorization: Bearer sk-ant-xxxx     ← 不变
       Accept-Encoding: identity             ← 改写
       Body: {"model":"claude-sonnet-4",...} ← 不变
```

### 5.2 OpenAI Chat Completions

```
进: POST 127.0.0.1:7048/openai/v1/chat/completions
       Authorization: Bearer sk-proj-xxxx
       Content-Type: application/json
       Body: {"model":"gpt-4o","messages":[...],"stream":true}

出: POST https://api.openai.com/v1/chat/completions
       Authorization: Bearer sk-proj-xxxx     ← 不变
       Accept-Encoding: identity             ← 改写
       Body: {"model":"gpt-4o",...}          ← 不变
```

### 5.3 OpenAI Responses

```
进: POST 127.0.0.1:7048/openai/v1/responses
       Authorization: Bearer sk-proj-xxxx
       Content-Type: application/json
       Body: {"model":"gpt-4o","input":"hello","stream":true}

出: POST https://api.openai.com/v1/responses
       Authorization: Bearer sk-proj-xxxx     ← 不变
       Accept-Encoding: identity             ← 改写
       Body: {"model":"gpt-4o",...}          ← 不变
```

### 5.4 自定义 Provider

```
进: POST 127.0.0.1:7048/custom/my-custom/v1/chat/completions
       Authorization: Bearer sk-my-key
       Body: {"model":"gpt-4o","messages":[...]}

出: POST https://another-api.example.com/v1/chat/completions
       Authorization: Bearer sk-my-key      ← 不变
       Accept-Encoding: identity            ← 改写
       Body: {"model":"gpt-4o",...}         ← 不变
```

**三协议在 proxy/interceptor 层完全一样**——只靠 `endpointType` 路由到不同的 `baseUrl`。差异只在 SSE 解析阶段（`shared/sse-events.ts` 按 `endpointType` 分路）。

---

## 6. Header 变换：变 vs 不变

### 6.1 透传（不变）

Proxy 不修改以下请求头：

| 请求头 | 说明 |
|---|---|
| `Authorization` | Bearer Token / API Key 原样 |
| `Anthropic-API-Key` | Anthropic 专用 key 原样 |
| `Content-Type` | `application/json` 原样 |
| `User-Agent` | 客户端 UA 原样（拦截器用于 `identifyClient`） |
| `Anthropic-Version` | Anthropic API 版本原样 |
| 其他所有请求头 | 原样透传 |

### 6.2 改写

| 请求头 | 变换 |
|---|---|
| `Host` | **删除**（不发给上游） |
| `Content-Length` | **删除**（`fetch` 自动重新计算） |
| `Accept-Encoding` | 改写为 `identity`（强制上游不压缩，以便拦截器读取 body） |

### 6.3 临时注入（Proxy → Interceptor 接力）

以下头由 Proxy 注入、Interceptor 读取后在发给上游前删除：

| 请求头 | 值 | 用途 |
|---|---|---|
| `x-lucent-trace` | `'true'` | 标记这是代理转发的请求 |
| `x-lucent-provider` | Provider name | 传递路由结果给拦截器 |
| `x-lucent-endpoint` | Endpoint type | 传递协议类型给拦截器 |

**上游永远看不到这些头。**

---

## 7. Body 变换

### 7.1 默认：一字不改

**默认行为：Body 一个字不改。**

Proxy 读取请求 body（限制 `MAX_REQUEST_BODY_SIZE` = 50MB），透传给 `fetch()`。拦截器解析 body 用于日志记录但不修改原始 body。未配置 body 重写规则时，body 缓冲区按**引用**原样传给上游（`===` 恒等，字节级透明、零拷贝）。

### 7.2 可选：opt-in body 重写规则引擎

当用户显式在 `~/.lucent/config.json` 顶层配置 `bodyRewrites: BodyRewriteRule[]` 且数组非空时，Proxy 在**body 读取后、`fetch()` 前**调用重写引擎（[`server/body-rewriter.ts`](../../../server/body-rewriter.ts)）：

- **规则结构**：`BodyRewriteRule { id, name?, enabled?, fieldPath, pattern, flags?, replacement }`（见 [`server/types.ts`](../../../server/types.ts)）。
- **fieldPath 语法**：对象键 `a.b.c` + 数组下标 `a[0].b` 混合，定位到 JSON body 里的目标位置。
- **替换语义**：对 fieldPath 定位到的 **string 叶子值**做子串替换
  `value.replace(new RegExp(pattern, flags ?? 'g'), replacement)`，保留未匹配部分；非 string 叶子 / 不存在的路径跳过。
- **flags 缺省 `g`**：脱敏 safe-by-default，默认替换全部命中而非只替换首个；`flags` 仅允许 `[gimsuy]*`。
- **顺序级联**：多条规则按数组顺序应用，前一条输出是后一条输入；`enabled: false` 跳过。
- **零命中字节透明**：全部规则都没命中任何叶子时，返回原 buffer 引用（`===` 恒等），零拷贝、零重序列化。
- **失败回退**：三层异常保护（JSON 解析失败 / 规则抛错 / 缓冲区回写失败）——任一异常都回退原 body，**不阻断请求**。
- **严格校验**：`validateBodyRewrites` 禁未知键、`id` 非空、`fieldPath` 可解析、`RegExp` 可构造、`flags ∈ [gimsuy]*`；校验失败走 `loadConfig` 现有非法配置路径（备份 `config.json.bak` 后回退默认 providers）。

典型用例：脱敏 Claude Code 注入 `system[0].text` 的计费头
（`x-anthropic-billing-header: cc_version=...; cc_entrypoint=cli;`）。

> ⚠️ **关键副作用（opt-in 固有代价，配置前必须知晓）**：
> 1. 🔴 **破坏上游 KV-Cache**：重写位于缓存前缀内的字段（典型 `system[0].text` 带 `cache_control` 断点）→ Anthropic 按字节寻址 cache miss → `cache_read` 归零、重新 `cache_creation`。Lucent 本地不算哈希，无法在代理端规避。
> 2. 🔴 **改变 agent 分类 / threadId**：interceptor 的 `classifyAgent` / `identify` 跑在重写后 body 上 → 激进脱敏可能误分类子 agent、切会话线索。
> 3. 🟢 JSONL 日志记录的是**重写后** body（脱敏场景通常正合意图）；命中后 body 会被 `JSON.stringify` 紧凑化（空白变化）；用户自配 `pattern` 的 ReDoS 风险自负。

### 7.3 UI 动态配置（BodyRewriteModal）

引擎本身只读 `~/.lucent/config.json`，但手编 JSON 反馈链长、调正则无即时预览。所以叠加一层 Web UI 动态配置，**不改引擎语义**，只改配置入口：

- **入口**：[`src/App.tsx`](../../../src/App.tsx) 顶栏独立按钮（`WrenchScrewdriverIcon`，`title="Body 重写规则"`），与 Settings 平级，点击打开 [`BodyRewriteModal`](../../../src/components/settings/BodyRewriteModal.tsx)。
- **CRUD API**：[`server/routes/body-rewrites.ts`](../../../server/routes/body-rewrites.ts) 挂载在 [`server/routes/index.ts`](../../../server/routes/index.ts)，四端点：
  - `GET /api/body-rewrites` → `BodyRewriteRule[]`
  - `POST /api/body-rewrites` → 新增，`id` 后端生成、不接受客户端 id
  - `PUT /api/body-rewrites/:id` → 更新，`id` 路径锁定不可改
  - `DELETE /api/body-rewrites/:id` → 删除
- **config helper**：[`server/config.ts`](../../../server/config.ts) 的 `getBodyRewrites`/`addBodyRewrite`/`updateBodyRewrite`/`deleteBodyRewrite` 复用 `validateBodyRewrites` + `saveConfig`，写回 `~/.lucent/config.json`。
- **Modal 编辑**：列表式编辑 `name`/`enabled`/`fieldPath`/`pattern`/`flags`/`replacement`，字段**失焦自动 PUT 保存**；新增走 POST、删除走 DELETE。
- **试跑预览**：Modal 内输入样例文本，前端用 `new RegExp(pattern, flags ?? 'g')` 本地 `replace` 即时显示结果——与后端引擎**同语义**（WYSIWYG）；非法正则 / 非法 flags 在预览区显示错误提示，不崩溃。
- **生效**：CRUD 内部 `saveConfig` 落盘，proxy **每请求读最新 config** → 保存即对后续请求生效，**无需 reload**。
- **前端封装**：[`src/utils/api.ts`](../../../src/utils/api.ts) 的 `listBodyRewrites`/`createBodyRewrite`/`updateBodyRewrite`/`deleteBodyRewrite` + [`src/types.ts`](../../../src/types.ts) 的 `BodyRewriteRule` 副本（与 [`server/types.ts`](../../../server/types.ts) 同构）。

> ⚠️ UI 只是更方便地配置规则，**不消除**引擎固有的 KV-Cache / agent 分类副作用（见 §7.2）。对 `system[0].text` 类规则，cache 影响依然存在；前后端必须保持 `RegExp` 构造同语义，否则预览与实际效果不符。

---

## 8. 完整变换流水线

```
Client                         Proxy (:7048)                    Upstream
  │                                  │                              │
  │  POST /anthropic/v1/messages     │                              │
  │  Host: 127.0.0.1:7048            │                              │
  │  Authorization: Bearer sk-...    │                              │
  │  Content-Type: app/json          │                              │
  │  Accept-Encoding: gzip           │                              │
  │  Body: {...}                     │                              │
  │─────────────────────────────────►│                              │
  │                                  │  1. 解析 name + rest          │
  │                                  │  2. lookup provider           │
  │                                  │  3. infer endpointType        │
  │                                  │  4. 拼 upstream URL           │
  │                                  │                              │
  │                                  │  变换后:                      │
  │                                  │  Host: (删除)                  │
  │                                  │  Authorization: Bearer sk-... │ ← 不变
  │                                  │  Content-Type: app/json       │ ← 不变
  │                                  │  Accept-Encoding: identity    │ ← 改写
  │                                  │  Content-Length: (删除)       │
  │                                  │  x-lucent-trace: true         │ ← 注入
  │                                  │  x-lucent-provider: ...       │ ← 注入
  │                                  │  x-lucent-endpoint: ...       │ ← 注入
  │                                  │  Body: {...}                  │ ← 不变
  │                                  │                              │
  │                                  │  fetch() ── interceptor ──┐  │
  │                                  │    (删除 x-lucent-* 头)    │  │
  │                                  │                            │  │
  │                                  │  到上游时:                  │  │
  │                                  │  Authorization: Bearer ...  │ ← 不变
  │                                  │  Content-Type: app/json     │ ← 不变
  │                                  │  Accept-Encoding: identity  │ ← 改写
  │                                  │  Body: {...}                │ ← 不变
  │                                  │  (无 x-lucent-* 头)         │ ← 已删
  │                                  │                            │  │
  │                                  │◀────────────────────────────┘  │
  │                                  │   SSE / JSON Response          │
  │                                  │                              │
  │                                  │  body.tee():                  │
  │                                  │    A → 透传客户端 (原样)       │
  │                                  │    B → 后台解析 → JSONL 日志   │
  │                                  │                              │
  │◀──────── SSE stream (原样) ──────│                              │
```

---

## 9. 拦截器过滤逻辑

`globalThis.fetch` monkey-patch 的拦截条件：

```
1. 有 x-lucent-internal 或 x-cc-viewer-internal 头？ → 放行 (内部请求)
2. 有 x-lucent-trace=true 头？ → 拦截 (代理转发)
3. URL 包含 'anthropic' / 'claude' / 'openai'？ → 拦截 (直接调用)
4. 否则 → 放行
```

**场景 2** 是 Proxy 转发的请求（最常见），**场景 3** 是 AI 工具直接调用上游 API 的情况（绕过 Proxy，但拦截器仍能捕获日志）。

---

## 10. 关键文件索引

| 文件 | 职责 |
|---|---|
| `server/proxy.ts` | 路径解析、Provider 查找、URL 变换、Header 注入 |
| `server/interceptor.ts` | fetch 拦截、日志捕获、x-lucent-* 清除 |
| `server/config.ts` | Provider CRUD、配置加载与环境变量覆盖 |
| `server/endpoint-registry.ts` | `inferEndpointTypeFromPath()` 路由匹配 |
| `shared/protocols.ts` | 三协议身份单源（`strippedPaths` 定义匹配路径） |
| `server/constants.ts` | 端口、trace header 名、限制值等常量 |

---

## 11. 设计决策记录

| 决策 | 原因 |
|---|---|
| Body 一字不改 | 代理是透明的，上游不应该感知经过代理 |
| 可选 body 重写（opt-in `bodyRewrites`） | 脱敏等需求需出口，但保持默认透明：未配置/零命中字节级不变（原 buffer 引用），失败回退原 body 不阻断；严格校验禁未知键 |
| UI 动态配置（BodyRewriteModal） | 引擎落地后需 Web 可视化增删改规则 + 试跑预览调正则：顶栏独立入口、失焦自动保存、前后端 RegExp 同语义、`saveConfig` 即生效无 reload |
| `Accept-Encoding: identity` | 拦截器需要读取原始 body 做日志；如果上游 gzip，拦截器无法解析 |
| `x-lucent-*` 临时头接力 | Proxy 和 Interceptor 在同一进程但不同模块，Header 是最轻量的通信方式 |
| 发给上游前清除 `x-lucent-*` | 避免上游收到非标准头导致兼容性问题 |
| `/custom/` 路径前缀 | 区分预设和自定义 Provider，保留名冲突保护 |
| baseUrl 含 `/v1` | 与上游官方文档一致，proxy 端去重 `/v1` 避免 `//v1/v1/` |
| `strippedPaths` 单源 | `shared/protocols.ts` 中声明，路由匹配 / SSE 提取 / 测试连接三端共用 |
