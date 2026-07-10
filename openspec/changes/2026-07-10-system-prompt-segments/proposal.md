## Why

log 详情 Context 面板里「系统提示词」永远只显示 1 条，但真实请求里 `body.system` 经常是
多段（Anthropic 把多个 cache 边界拆成独立 text block，Claude Code / bigmodel 也会传多段）。
现状是提取器把多段 `join('\n')` 拼成单串，前端写死 `count={1}` 只渲染一项——用户看到的
「一段 5546 字符」其实是三段被压扁，丢失了段结构。

复现日志（宿主机 7049，Anthropic Messages，GLM 走 bigmodel anthropic 端点）`body.system` 是 3 段
text block（70 / 62 / 5412 字符，后两段带 `cache_control: ephemeral`），前端却显示 1 条。
根因是三处串起来的：提取器 join、数据模型是单字符串、前端写死 1。

lead 已拍板方向：**保留多段，按「段」口径渲染**。`cache_control`（ephemeral）属于 KV-Cache 口径，
不在本变更范围内（见 `kvcache.ts`，它直接读 `body.system` 的 `cache_control`，与本次提取互不依赖）。

## What Changes

数据形状定为 **`systemPrompt: string → string[]`**（每段一个元素，单源，无重复串）。
不新增 `systemPrompts` 字段、不保留旧拼接串——拼接串的唯一消费者是 FTS 与一个写而不读的
`systemPromptLength`，两者都能从段数组派生，没必要双写。

### 后端

- **提取器（[`server/context-extractors.ts`](../../server/context-extractors.ts)）**
  - `ExtractedContext.systemPrompt?: string` → `string[]`。
  - **Anthropic**：`body.system` 是数组 → 每个 `type:'text'` block 的 `text` = 一段（保序，N 段就 N 个元素）；
    `body.system` 是字符串 → `[s]` 单段；过滤后空 → `undefined`。
  - **OpenAI Chat**：**修掉只留第一段的 bug**——遍历全部 messages，每条 `role:'system'` 消息产出一段
    （字符串 content 直接成段；数组 content 把其 text block 在段内 `join('\n')`），多条 system 消息保序入数组。
  - **OpenAI Responses**：`body.instructions` 字符串 → `[instructions]` 单段（语义本就是单段）。
  - 顶部 debug 日志 `systemPromptLen=%d` 改为段总长（`join('\n').length`），描述不漂。

- **并行注册（[`server/endpoint-handlers.ts`](../../server/endpoint-handlers.ts)）**
  - 三个 `extractContext` 注册体与 `context-extractors.ts` 是双胞胎实现（虽 `extractContextByEndpoint`
    当前无调用方，但同构是维护前提，避免日后接线时两份口径分叉）。同步改成产出 `string[]`。

- **类型 + 重建（[`src/types.ts`](../../src/types.ts) / [`server/types.ts`](../../server/types.ts) /
  [`server/services/log-reader.ts`](../../server/services/log-reader.ts)）**
  - `ContextData.systemPrompt` / `LogEntry.context.systemPrompt` → `string[]`。
  - `ContextSummary.systemPromptLength` 字段**保留**（契约形状不变，兑现 log-reader.ts 顶部
    「前端契约 + context 口径不变」不变量），口径改为段总长 `systemPrompt.join('\n').length`
    （单段时与旧值一致，多段时含 `\n` 分隔——与旧 join 口径同形）。该字段当前无任何读取方
    （前端 / KV-Cache 都不用），属待用契约，保留以免动 summary 形状。
  - `buildContextFromRequest`：`attach` 处用 `systemPrompt?.length ? { systemPrompt } : {}`；
    空判 `!systemPrompt` → `!systemPrompt?.length`。

- **FTS 索引（[`server/services/db.ts`](../../server/services/db.ts) `buildSearchText`）**
  - `parts.push(extracted.systemPrompt)` → `parts.push(...extracted.systemPrompt)`：把每段都喂进搜索文本
    （单段时行为等价；多段时三段都可被搜中，比只搜拼接串更准）。

### 前端

- **类型（[`src/types.ts`](../../src/types.ts)）**：`ContextData.systemPrompt?: string[]`。
- **Context 面板（[`src/components/viewer/DetailPanel.tsx`](../../src/components/viewer/DetailPanel.tsx)）**
  - `SelectedItem` 的 `systemPrompt` 分支加 `index: number`（与 `tool`/`message` 一致）。
  - 「系统提示词」分组 `count={data.systemPrompt.length}`；按段数渲染 N 个 `ContextListItem`，
    label 形如 `#1 · <段首预览>`（段首取首个非空行截断；空段回退 `#N`），`isSelected` 按段 index 命中。
  - `getSelectedContent('systemPrompt')` 返回**选中那一段**的文本，title `系统提示词 #N`。
  - 默认选中首个段（有段时）；空态判定从 `data.systemPrompt` 真值改为 `?.length`。

### 不动

- **`body.messages` 里的 `role:'system'` 消息**（bigmodel 把 Claude Code agent-types 段当 message 传）：
  它确实是 messages 数组的一条，显示在「对话历史」里是正确的。本次只对齐 `body.system`，
  不把 messages 里的 system 并入「系统提示词」分组（如要并入另开 issue 找 lead 议）。
- **KV-Cache / `cache_control`**：`kvcache.ts` 独立读 `body.system` 的 cache 标记，与本次提取互不依赖。
- **转发链路 / body 重写 / DB schema**：零改动。`context` 在读路径由 `buildContextFromRequest` 从
  原始 `body` 实时重建（非持久化），所以历史日志刷新即按新「段」口径呈现，无需迁移。

## Capabilities

### New Capabilities
无。

### Modified Capabilities
- **context 提取契约（事实契约，散落在 `context-extractors` / `log-reader`，无独立 spec 文件）**：
  `systemPrompt` 由单字符串改为段数组。Anthropic `body.system` 数组逐段保留；OpenAI Chat 多 system
  消息逐条保留（修原先只留首条的丢弃 bug）；Responses `instructions` 仍单段。三种协议统一按「段」口径。
- **前端 Context 面板**：「系统提示词」分组按段数渲染 N 条，`count` = 段数；选中展示对应段文本。

## Impact

- **受影响代码**：
  - [`server/context-extractors.ts`](../../server/context-extractors.ts)：3 个 extractor + 类型 + debug 日志。
  - [`server/endpoint-handlers.ts`](../../server/endpoint-handlers.ts)：3 个 `extractContext` 注册体同步。
  - [`src/types.ts`](../../src/types.ts) / [`server/types.ts`](../../server/types.ts)：`systemPrompt` 类型 `string → string[]`。
  - [`server/services/log-reader.ts`](../../server/services/log-reader.ts)：attach / 空判 / `systemPromptLength` 口径。
  - [`server/services/db.ts`](../../server/services/db.ts)：`buildSearchText` 展开多段。
  - [`src/components/viewer/DetailPanel.tsx`](../../src/components/viewer/DetailPanel.tsx)：`SelectedItem` + 分组渲染 + 选中取段。
  - [`tests/context-extractors.test.ts`](../../tests/context-extractors.test.ts) / [`tests/log-reader.test.ts`](../../tests/log-reader.test.ts)：补多段 + 单段反向用例。
  - [`e2e/system-prompt-segments.spec.ts`](../../e2e/system-prompt-segments.spec.ts)：新增 Context 面板段数断言。
- **不改**：KV-Cache、转发/body 重写、DB schema、`systemPromptLength` 字段存在性（只改口径）。
- **新增风险**：
  - **类型从 string 变 string[] 是破坏性契约变更**：但所有生产者（3 个 extractor）与所有消费者
    （FTS / 前端 / 写而不读的 length）都在本变更内同步改完；`context` 非持久化（读路径实时重建），
    无历史数据迁移负担。唯一带旧 string `context.systemPrompt` 的是 `tests/mock-log-data.jsonl` 预置 fixture，
    无任何测试读取它，保留不影响——已核对。
  - **OpenAI Chat 多 system 消息**：原先第 2 条起被 `continue` 丢弃，本次全保留。属正向修复，
    但若有调用方依赖「只看到第一条」会被打破——经查无此依赖（FTS 反而因此更全）。
