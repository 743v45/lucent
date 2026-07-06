## Why

Web UI 的 **Context tab** 点击「对话历史」里**带工具调用的 assistant 消息**(即 `content: null` 的回合)时,整页白屏崩溃:

```
Uncaught TypeError: Cannot read properties of undefined (reading 'map')
    at index-CabgZRsl.js:46:550   (ContextTab.getSelectedContent, message 分支)
```

根因有两层:

1. **服务端 extractor 不一致(根因)**:`server/context-extractors.ts` 三个协议 extractor 对 `content` 的归一化处理不统一:
   - `extractAnthropicMessages`(`:94`):`content: msg.content == null ? [] : msg.content` ✅ 已归一化
   - `extractOpenAIChat`(`:130-131`):`content: msg.content` ❌ 原样透传
   - `extractOpenAIResponses`(`:159-161`):`content: item.content` ❌ 原样透传

   OpenAI Chat 规范里,**assistant 发起 tool_calls 时 `content` 字段为 `null`**(实测见 `tests/e2e-helpers.ts:576` 的 `delta: { role: 'assistant', content: null, tool_calls: [...] }`;完整 non-stream 响应同理)。这条 null 一路透传到 `log.context.messages[i].content`,违反类型契约 `ContextMessage.content: string | ContentBlock[]`(`src/types.ts:228`,承诺永不为空)。

2. **前端缺兜底(崩溃点)**:`src/components/viewer/DetailPanel.tsx` 的 `ContextTab.getSelectedContent()`(`:966-985`)只判 `typeof msg.content === 'string'`,剩余分支直接假设是数组并 `.map()`:
   ```ts
   const contentText =
     typeof msg.content === 'string'
       ? msg.content
       : msg.content           // ← 默认「非 string 即数组」
           .map((block) => {...})  // ← content 为 null/undefined 时炸
   ```
   任何 `content` 非字符串又非数组的消息(历史脏数据、未来 extractor 漏网)点开即崩。

崩溃场景吻合用户报告:「detail 里 context 对话历史,第二个 assistant 点开报错」——第二条 assistant 正是发起工具调用的回合。

## What Changes

**根因修复(服务端,兑现契约)** —— `extractOpenAIChat` / `extractOpenAIResponses` 像 Anthropic extractor 一样把 `null`/`undefined` content 归一化为空数组:

- `extractOpenAIChat`(`context-extractors.ts:128-131`):`content: msg.content == null ? [] : msg.content`
- `extractOpenAIResponses`(`context-extractors.ts:159-162`):`content: item.content == null ? [] : item.content`

**纵深防御(前端,永不白屏)** —— `ContextTab.getSelectedContent()` 的 `message` 分支补兜底,即使收到脏数据也不崩:

- `DetailPanel.tsx:966-985`:`typeof msg.content === 'string'` 分支不变;数组分支加 `Array.isArray` 守卫,非数组回退 `String(msg.content ?? '')`

**不**改的:数据形状、`NormalizedMessage.content` 类型签名(契约本就承诺非空,只是 OpenAI 两个 extractor 没兑现)、Anthropic extractor、KV-Cache 提取、其它 Tab、HTTP API、日志读写。

## Capabilities

### Modified Capabilities
- `log-integrity` —— 新增「context extractor MUST 把每条 message 的 `content` 归一化为 `string | ContentBlock[]`,不得透传 `null`/`undefined`」的硬约束(兑现既有 `ContextMessage.content` 类型契约)。原 verbatim body / JSONL 格式约束不变。

### New Capabilities
无。

## Impact

- **受影响代码**:
  - 改 `server/context-extractors.ts`(2 个 extractor 各 1 行归一化)
  - 改 `src/components/viewer/DetailPanel.tsx`(message 分支加 `Array.isArray` 守卫)
- **受影响测试**:新增 extractor + `buildContextFromRequest` 单测覆盖 OpenAI chat/responses 的 `content: null` assistant 消息(先红);`npm test` 必须绿
- **不变量**:
  - 三个协议 extractor 产出的 `messages[*].content` 永远满足 `string | ContentBlock[]`,无 `null`/`undefined`
  - Context tab 点击任意 message(含历史脏数据)不再抛异常,空 content 显示为空内容而非白屏
- **历史数据**:旧日志里已写入的 `content: null` 不回填(只读快照),由前端兜底吸收——点开显示空内容,不再崩
- **不影响**:HTTP API 形状、日志文件格式、Anthropic 协议、KV-Cache、轮转/清理
