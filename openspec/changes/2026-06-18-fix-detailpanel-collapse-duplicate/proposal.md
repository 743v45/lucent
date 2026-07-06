## Why

Detail 面板 Body 区(Request / Response tab)当前有**两个功能重复的折叠按钮**,且其中一个存在「点了没反应」的 bug。

两个按钮都作用于同一个 `JsonView` 的 `shouldExpandNode`(`src/components/viewer/DetailPanel.tsx:454`):

```ts
shouldExpandNode={expandAll ? () => true : (level) => collapsed ? level < JSON_COLLAPSED_EXPAND_LEVEL : true}
```

- **CollapseButton**(标签「折叠 / 展开」)→ 切换 `bodyCollapsed`
- **ExpandAllButton**(标签「展开全部 / 收起全部」)→ 切换 `expandAll`

状态矩阵(默认 `bodyCollapsed=true, expandAll=false`):

| bodyCollapsed | expandAll | 实际渲染 | 两个按钮的标签 |
|---|---|---|---|
| `true` | `false` | 折叠到第 2 层 | `[展开全部] [展开]` |
| `false` | `false` | **全展开** | `[展开全部] [折叠]` |
| `*` | `true` | **全展开** | `[收起全部] [折叠]` |

两个问题:

1. **重复**:点「展开」(bodyCollapsed→false)和点「展开全部」(expandAll→true)渲染结果完全一样,都是 `() => true` 全展开。用户看到两个标签不同、效果相同的按钮,无法区分。
2. **失效按钮**:点过「展开全部」后 state 为 `bodyCollapsed=false, expandAll=true`。此时点「收起全部」(expandAll→false)进入 `collapsed ? level<2 : true` 分支,但 `bodyCollapsed` 仍是 `false`,结果**仍然全展开**——「收起全部」是 no-op,点了没反应。

来历:`ExpandAllButton` 由 commit `e80151d`("JsonBlock 加「展开全部」按钮")引入,本意补一个"强制全展开"入口,但与既有 `CollapseButton` 撞车,没统一 state。

## What Changes

**删除** 整条 `expandAll` 链路,**保留并修正**既有的单一「折叠 / 展开」按钮:

- 删除组件 `ExpandAllButton`(`DetailPanel.tsx:82-92`)及其两处使用(`RequestTab` / `ResponseTab`)
- 删除 `DetailPanel` 的 `expandAll` state、`toggleExpandAll` 及其对两个 Tab 的 prop 透传
- 删除 `RequestTab` / `ResponseTab` / `RequestTabProps` / `ResponseTabProps` / `JsonBlock` 上的 `expandAll` 字段与 `onToggleExpandAll` 回调
- `JsonBlock` 的 `shouldExpandNode` 简化为单一 collapsed 控制:`(level) => collapsed ? level < JSON_COLLAPSED_EXPAND_LEVEL : true`

**不**改的:`bodyCollapsed` 的语义、默认值(`true` = 折叠到第 2 层,避免大 body 全展开卡顿)、`CollapseButton` 的「折叠 / 展开」标签与行为、CopyButton、SSE 视图切换、其它 Tab。

## Capabilities

### Modified Capabilities
无(本仓库无 UI 相关 spec;`e2e-verification` 涉及的 testid 不含 `expand-all` / `collapse-all`,已确认无测试引用这两个 testid)。

### New Capabilities
无。

## Impact

- **受影响代码**:`src/components/viewer/DetailPanel.tsx`(单文件)
- **受影响测试**:无单测直接覆盖;e2e 脚本(`scripts/verify-*.ts`)未引用 `expand-all` / `collapse-all` testid
- **修复后的不变量**:Body 区折叠 / 展开由**单一按钮**控制,「折叠」↔「展开」在任何状态下点击都立即生效,不再出现两个效果相同的按钮或点了没反应的按钮
- **不影响**:数据形状、日志读写、HTTP API、其它 Tab、KV-Cache / Context 分组折叠(各自独立 state)
