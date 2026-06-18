## Why

5 个 verify 脚本（端到端验收）各自维护一套 inline mock fixture,与
`tests/e2e-helpers.ts` 分叉出 21 处不一致（6 critical / 14 minor / 1 cosmetic）。
更严重的是：verify 脚本的断言只验「关键字存在」不验「格式完整」,
导致 fixture 错了也全绿——"234/234 全绿"是假象。

同时审计发现两个展示层缺口：
- UI 默认「结构化」视图丢失 SSE 的 ping/error 等元事件
- openai reasoning 提取不完整（chat 不处理 reasoning,responses 只认慧星云变体）

## What Changes

### 1. 统一 fixture 真相源（根除 21 处分叉）

- `createMockUpstream` 新增 `format: 'auto'` 模式:按 URL 自动分派 3 协议
  （`/messages`→anthropic, `/chat/completions`→openai-chat, `/responses`→openai-responses）
- 5 个 verify 脚本删 inline fixture,全部复用 `createMockUpstream`
- openai 错误体 type bug 自动消除（复用 `openaiErrorByStatus` 按 status 映射）

### 2. 加 schema 校验断言（消除假绿）

- `helpers.ts` 新增 3 个 `validate*Schema()` 函数:
  - `validateAnthropicBody(input, kind)` — 校验 SSE/JSON/error 三种
  - `validateOpenAIChatBody(input, kind)`
  - `validateOpenAIResponsesBody(input, kind)`
- 每个函数返回 `{ ok, errors[] }`,fixture 错了 errors 非空
- 5 个 verify 脚本各加 schema check（共 +43 个验收点）
- 断言有效性已验证:故意删 `service_tier` → JSON-⑥ 精确 FAIL

### 3. 修两个展示层缺口

- `DetailPanel.tsx`: SSE 默认视图 `'extracted'` → `'raw'`（原始 SSE 完整可见,含 ping/error）
- `sse-extractor.ts`: reasoning 提取补全
  - openai-chat: 加 `delta.reasoning_content` / `delta.reasoning`
  - openai-responses: 加标准 `response.reasoning.delta`（原有慧星云变体保留）

### 4. 脚本语言 .mjs → .ts

- 5 个 verify 脚本改 `.ts`,npm script `node` → `tsx`
- 类型安全,与 `server/index.ts` 一致

## Capabilities

### Modified Capabilities
- `protocol-chain-verification`: 加「verify 脚本必须复用 helpers.ts fixture +
  必须有 schema 校验断言」契约

## Impact

- 受影响代码: `tests/e2e-helpers.ts`（+auto 分派 +3 validate 函数）、
  5 个 verify 脚本（.mjs→.ts 重构）、`DetailPanel.tsx`（默认视图）、
  `sse-extractor.ts`（reasoning 提取）、`package.json`（npm script）
- 不影响代理服务运行时透传逻辑（server/ 不变）
- 验收点数: 234 → 277（+43 个 schema check）
- 单测 320/320 不回归
