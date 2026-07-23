## Why

详情页 Context 标签页右侧的详情卡片（系统提示词每段、对话历史每个 content block、每个工具描述）
只有正文、没有复制入口。用户想逐段复制某一段时无从下手——目前只能整块/整页复制，粘出来是
一坨混在一起的文本，分不清哪段是哪段。

需求是「每一段内容各自配一个复制按钮，点一下只复制这一段，而非整块复制」。

## What Changes

纯新增，不动现有数据流、不动提取口径、不动转发/body 重写/DB。

- **`src/components/viewer/detail/shared.tsx`**：`CopyButton` 增加可选 `testId` prop，
  透传到按钮 `data-testid`。其余两个调用方（Request/Response tab 的 body 复制）不传，行为零变更。
- **`src/components/viewer/detail/ContextTab.tsx`**：`ContextDetailCard` 头部由「有 label/tag 才渲染」
  改为「始终渲染」——头部左侧放可选 label/tag，右侧放一个 `CopyButton`。这样无 label/tag 的卡片
  （单段 system、文本块、工具描述）也能稳定挂上复制按钮。`onCopy` 走现成 `copyText`
  （带回退、不产生 unhandled rejection），返回真实结果，CopyButton 仅在真正写入剪贴板时显「已复制」。
  - 每张卡片各自一个按钮、各自复制自己的 `card.content`，互不影响——逐段而非整块。
  - `ContextDetailCard` 仍包 `React.memo`，`onCopy` 用 `useCallback`（依赖 `card.content`），
    card 引用稳定时照常跳过重渲染，不触发 markdown 重解析（保 #16 的优化）。
- **`e2e/context-card-copy.spec.ts`**（新增）：一条 e2e，造出三类卡片，分别点各自的复制按钮 →
  等「已复制」反馈出现（只有真写入剪贴板才会显）→ 读剪贴板断言 == 该段原文。覆盖 segment / text / tool 三 kind。

## Impact

- **受影响代码**：
  - `src/components/viewer/detail/shared.tsx`：`CopyButton` 加 `testId`。
  - `src/components/viewer/detail/ContextTab.tsx`：`ContextDetailCard` 头部常驻 + 复制按钮。
  - `e2e/context-card-copy.spec.ts`：新增 e2e。
- **不改**：context 提取口径、数据模型、转发/body 重写、DB schema、KV-Cache、其余 tab。
- **新增 testid**：`context-card-copy`（复用现有 kebab-case 字面量约定，与 `context-card`/`context-item` 一致）。
- **风险**：低。头部从「条件渲染」变「常驻」，单段 system / 文本块 / 工具描述卡片多出一行头部
  （仅承载复制按钮），是预期内的视觉变化，也是本次需求本身。现有 e2e（system-prompt-segments /
  detail-kvcache-context-meta / search）全部回归通过，未破断言。
