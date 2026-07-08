## Why

Lucent 现在对每条请求只记一个 `duration`，且对流式响应口径是错的：拦截器在「上游响应头到达」那一刻就把 `duration` 定死（`await fetch` 一 resolve 就赋值），流体还没开始消费。一个跑 30 秒的流式回答，日志里 `duration` 可能只显示几百毫秒。

更关键的是完全没有「首 token 时延」（TTFT）。本项目的上游是 reasoning 模型，prefill（首 token 前的等待）才是大头延迟，没有 TTFT 就看不出来慢在「等首 token」还是「吐字慢」。owner 已拍板（见 issue 评论）：

1. TTFT 起点 = **客户端请求到达代理**（不是拦截器发起 fetch），符合「发出请求→首 token」语义。
2. 第一版就细分 **首思考 token / 首回答 token**——reasoning 模型 thinking 与 answer 两段延迟差很大，分开才有诊断价值。
3. 第一刀范围 = **TTFT + 修 duration 口径 + tokens/s**；p50/p95/p99 分位数聚合排第二轮（不在本 change）。

本 change 把这三协议（anthropic-messages / openai-chat / openai-responses）的「首 token / 思考 token / 回答 token」判定口径**写死在 spec**，避免实现期返工；同时把流式 `duration` 口径 bug 一起修掉。

## What Changes

### 1. 新增请求起始时间戳透传（TTFT 起点 = 客户端请求到达代理）

- `server/proxy.ts`：请求处理器入口记 `reqStartMs = Date.now()`，随现有 `x-lucent-*` header 组一起注入上游请求头 `x-lucent-req-start-ms`（字符串）。
- `server/interceptor.ts`：读出该 header 解析为 `reqStartMs`；**缺失/非法时回退**到拦截器自身的 fetch 起始时间（兼容不走 proxy.ts 的直连 fetch）。随其它 `x-lucent-*` header 一起从发往上游的请求头里剔除（不外泄给上游）。
- `reqStartMs` 是运行期记账字段，**不持久化**进 JSONL（最终落盘的是派生的 `ttft*` 派生量与修正后的 `duration`）。

### 2. TTFT 测量层 = 后台 SSE 收集器（`server/sse-extractor.ts`）

- 在 `collectSSELinesInBackground` 逐事件读流循环里，对每个事件做 token-bucket 分类，记录三类「首次到达」墙钟时刻：`firstThinkingAt` / `firstAnswerAt` / `firstTokenAt`（前两者取早者）。
- 派生并写入 entry（单位 ms，整数）：
  - `ttftFirstTokenMs = firstTokenAt − reqStartMs`
  - `ttftThinkingMs = firstThinkingAt − reqStartMs`
  - `ttftAnswerMs = firstAnswerAt − reqStartMs`
  - 三者均为 optional——流被截断/空答/无对应内容时留空（`undefined`，落盘省略字段）。
- **时钟**：统一 `Date.now()` 墙钟，与现有 `duration` 同源（沿用既有口径，NTP 跳变的既有 caveat 不变）。
- **测量在 tee 出来的后台副本流上做，完全不碰客户端透传主链路**，零额外延迟、零风险（与现有 SSE 收集同样的副链路定位）。

### 3. token-bucket 分类单源（`shared/sse-events.ts`）

- 新增纯函数 `classifySSEEventTokenBucket(eventType, data, endpointType) -> { thinking: boolean, answer: boolean }`，返回该事件是否携带**非空**思考 delta / 回答文本 delta。前后端共用，避免口径漂移。
- 收集器复用此函数；不再在收集器里手写协议判断。**三协议判定口径见 spec.md，是本 change 的核心契约。**

### 4. 修流式 `duration` 口径

- `duration` 统一改为「请求到达 → 响应体完全消费」的墙钟：
  - 流式：流关闭（done / 超时 / 超限 / 错误）时刻 − `reqStartMs`，在收集器完成路径定值。
  - 非流式：响应体读完（`handleNormalResponse` 的 `await cloned.text()` 之后）− `reqStartMs`。
- ⚠️ **口径变更需确认（见下方 Decision）**：非流式也会从「响应头到达」改为「响应体读完」，数值会略增（多了 body 读取时间，对小块 JSON 通常毫秒级）。统一口径更正确，但若 owner 想严格限定「只改流式」，可收敛。

### 5. tokens/s（流式专属）

- `tokensPerSecond = output_tokens / ((duration − ttftFirstTokenMs) / 1000)`，保留 1 位小数。
- 守卫：`ttftFirstTokenMs` 缺失 / `duration ≤ ttftFirstTokenMs` / `output_tokens === 0` → 留空。
- 语义：decode 阶段吞吐（首 token 之后的生成速度）。reasoning 模型的 `output_tokens` 含思考 token，故此值是「含思考的总生成吞吐」——一旦上游提供思考/回答分桶 token 计数，第二轮再拆。**非流式不计算 tokens/s**（无 prefill/decode 分解意义），留空。

### 6. 日志形状 & 读取透传

- `RawLogEntry` 与 `LogEntry`（`server/types.ts`）新增 optional 字段：`ttftFirstTokenMs?` / `ttftThinkingMs?` / `ttftAnswerMs?` / `tokensPerSecond?`（camelCase，沿用 LogEntry 既有命名风格；tokenUsage 的 snake_case 契约不受影响）。
- `server/services/log-reader.ts` 的 `normalizeLogEntry`：在 flat→nested 显式映射分支补上这四个字段的透传（与 `duration`/`tokenUsage` 同级）；已嵌套的早返回分支天然保留。旧日志无此字段 → 缺省 → UI 显示 n/a，不做迁移。

### 7. UI 最小落点（v1）

- 详情面板把 `ttftFirstTokenMs` / `ttftThinkingMs` / `ttftAnswerMs` / `tokensPerSecond` 暴露为带 `data-testid` 的可读元素（`ttft-first-token` / `ttft-thinking` / `ttft-answer` / `tokens-per-second`），供 e2e 断言与用户直读。精确排版留给实现，但**值必须经 `/api/logs` 可查、UI 必须可见**。

## Capabilities

### New Capabilities
- `stream-timing`：流式响应的首 token 时延（TTFT，分思考/回答）、修正后的全量 `duration`、生成吞吐 tokens/s 的测量口径、单源 token-bucket 分类、请求起始时间戳透传协议，以及对应的日志字段与 UI 暴露契约。

### Modified Capabilities
无。`log-integrity` 的现有 Requirement（body 逐字、无 delta 元数据、标准 JSONL、无二级分隔符转义）**一条都不动**——`duration` 的语义改变是给 `stream-timing` 新增不变量（见 spec），`log-integrity` 现有契约里并未约束 `duration` 的含义。本 change 不动日志文件格式、不动分隔符、不引入 delta 字段。

## Impact

- **受影响代码**：`server/proxy.ts`（注入起始时间戳 header）、`server/interceptor.ts`（读 header + 回退 + 剥离）、`server/sse-extractor.ts`（收集器记 TTFT + 修流式 duration）、`server/interceptor.ts` 非流式分支（duration 改为 body 读完后定值）、`shared/sse-events.ts`（新增 `classifySSEEventTokenBucket` 单源函数）、`server/types.ts`（新增 4 个 optional 字段）、`server/services/log-reader.ts`（normalizeLogEntry 透传新字段）、前端 `src/components/viewer/DetailPanel.tsx` 及类型（展示新字段）。
- **受影响不变量**：不动 `log-integrity` / `protocol-model` / `provider-baseurl` 等任何已落地 spec 的现有 Requirement——token-bucket 分类是新增独立函数（不改 PROTOCOL_REGISTRY / EndpointType 派生），`duration` 语义变更落为 `stream-timing` 的新不变量而非改 `log-integrity`。
- **受影响测试**：新增 `classifySSEEventTokenBucket` 单测（三协议 thinking/answer/neither 矩阵）；扩展现有 `verify-openai-chat-e2e` / `verify-openai-responses-e2e` / `verify-anthropic-e2e` 断言流式请求的 `ttftFirstTokenMs > 0 && < duration`、`tokensPerSecond > 0`、以及「流式 duration > ttftFirstTokenMs」（证明 duration 不再只是响应头时间）。既有断言 `duration` 数值的用例可能需按新口径微调。
- **runtime/API/依赖**：无新依赖；`/api/logs` 返回体新增 optional 字段（向后兼容，旧消费者忽略未知字段）。
- **真实数值验收**：`scripts/record-newapi-e2e.ts`（`npm run record:newapi`，真实 reasoning 上游）可顺带打印 TTFT 实测值作为人读证据（需 `OPENAI_API_KEY` + 活上游，受环境门控）；mock 上游的 `verify:*` 链路证明接线与正确性。
- **非目标（显式排除）**：p50/p95/p99 分位数聚合、stats 接口改造、KV-cache↔TTFT 相关性面板、思考/回答分桶 token 计数——均排第二轮。

## Decision（需 owner/lead 确认一项）

**`duration` 口径是「流式+非流式统一改」还是「只改流式」？** 本 spec 默认统一改（更正确、避免两套定义）。若 owner 想严格限定只改流式（非流式维持现状以缩窄影响面），实现期收敛即可，不影响其余契约。这是 spec 里唯一留给人的取舍，其余口径全部写死。
