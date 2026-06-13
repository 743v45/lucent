# 使用说明改造设计文档

> 日期：2026-06-13
> 状态：定稿待 review
> 范围：仅使用说明（应用内 `UsageGuide` 弹窗 + `README.md`）

## 1. 背景与问题

用户反馈「使用说明得改改、布局很差、用法好像也理解错了」。经审查三个具体病灶：

### 1.1 用法错了

`src/components/common/UsageGuide.tsx:71` 给用户生成的接入地址用 `/api/{供应商名}` 前缀，但 server 实际路由只认 `/{name}` 或 `/custom/{name}`（见 `server/proxy.ts:34` 与 `server/index.ts:108`）。`/api/` 是 Web UI 内部 API 路由（如 `/api/logs`），不参与代理转发——照弹窗配必连不上。

### 1.2 布局差

原弹窗用 antd `<Collapse>` 折叠面板把接入指令收起来；首屏只显示一段介绍文案。用户要点开才看到内容，挡视线。

### 1.3 品牌名不一致

`UsageGuide.tsx:90` 写「AgentProxy」，而 `README.md` / `UI_DESIGN.md` 用「Lucent」。站内出现两个名字。

附带发现：`README.md:72-83` 一律写 `/custom/{供应商名}`，对自定义供应商对，对预设供应商又错（预设无前缀）。和 1.1 同源，但表达在文档侧。

## 2. 目标与非目标

### 2.1 目标

- 接入地址的"真相"统一为 server 实际行为（见 §3）
- 应用内弹窗单页平铺所有接入指令，按客户端分组
- README 文档与弹窗口径一致
- 站内品牌名统一为 Lucent

### 2.2 非目标（明确不做）

- 主界面布局（App / DetailPanel / KV-Cache 面板）不动
- 响应式断点不动
- 颜色 token / 尺寸 token 统一不动
- `SettingsModal` 内部不动（仅被"去配置"按钮复用打开）
- 不加 FAQ / 调试指引 / 客户端配置示例（保持精简）
- 不加 Loading skeleton / 动画等润色

## 3. 接入地址规则（真相来源）

来源：`server/index.ts:108-115` + `server/proxy.ts:34`

| 供应商类型 | Base URL 格式 |
|-----------|---------------|
| 预设供应商（有 `presetName`） | `http://{host}:{port}/{name}` |
| 自定义供应商 | `http://{host}:{port}/custom/{name}` |
| OpenAI 端点（`openai-chat` / `openai-responses`） | 上述规则 + `/v1` 后缀 |

- `host` / `port`：调 `getProxyStatus()` 取 `status.host` / `status.proxyPort`，与现状一致
- `name` / `presetName` 判定：取 `provider.presetName` 字段，遵循 server 端语义

## 4. 弹窗改造（`src/components/common/UsageGuide.tsx`）

### 4.1 移除

- 移除 antd `Collapse` 折叠面板
- 移除每行「client 标签 + 命令 + 上游 URL」三段式中的 client 标签组（改为顶部按客户端分组）
- 移除 `import { Collapse } from 'antd'`（若不再使用）
- 移除「AgentProxy」文案

### 4.2 文案

弹窗主体两段：

1. **第一段**（一句）：Lucent 是 AI API 代理。在「配置」中添加供应商，设置环境变量指向本代理即可。
2. **第二段**（规则提示）：预设供应商无前缀；自定义供应商加 `custom/`；OpenAI 端点需加 `/v1` 后缀。

### 4.3 排版

单页平铺，不折叠。结构：

```
[标题] 使用说明
[段落1] 一句介绍
[段落2] 三条规则提示

────────────────────
Claude Code
[export ANTHROPIC_BASE_URL=http://...:7048/glm        ] [复制]
[export ANTHROPIC_BASE_URL=http://...:7048/custom/my  ] [复制]
────────────────────
Codex / OpenAI
[export OPENAI_BASE_URL=http://...:7048/openai/v1      ] [复制]
────────────────────
```

每个客户端组：
- 只在该组有至少一个端点时显示
- 标题用 `h3` 样式（`text-text-primary font-[560]`）
- 每行：`code`（完整 export 命令，`font-mono`）+ 复制按钮
- 行右上角可保留小字「→ 上游」原 URL（与现状一致，保留诊断信息），但默认弱化

### 4.4 无供应商状态

保留说明文案，新增「去配置」按钮（antd `Button type="primary" size="small"`）：
- 点击：先调 `props.onClose()` 关弹窗，再触发打开 `SettingsModal` 的入口
- 实现：通过回调注入。`UsageGuide` 增加可选 prop `onOpenSettings?: () => void`；`App.tsx` 把现有的 settings 打开处理函数传入

## 5. README 改造（`README.md`）

### 5.1 「使用方法」三步（`README.md:55-96`）

- **GLM 示例（`L72-83`）**：分两套示例
  - 预设供应商 GLM：`export ANTHROPIC_BASE_URL=http://127.0.0.1:7048/glm`
  - 自定义供应商：保留 `/custom/{供应商名}` 写法
- 加一句 OpenAI 端点 `/v1` 后缀的说明
- 三步走的话术保持

### 5.2 其他章节

- 「快速开始」端口（7048 / 7049）现状已对，不改
- 品牌名 Lucent 现状已对，不改
- 「界面说明」「CLI 命令」与本次改造无关，不改

## 6. 文件改动清单

| 文件 | 改动类型 | 说明 |
|-----|---------|------|
| `src/components/common/UsageGuide.tsx` | 重构 | 移除 Collapse、按客户端分组、改文案、品牌 Lucent、加 onOpenSettings |
| `src/App.tsx` | 小改 | 把 `setSettingsOpen(true)` 之类的现有 handler 透传给 `UsageGuide` |
| `README.md` | 小改 | 使用方法区分预设/自定义、加 OpenAI `/v1` 说明 |

不引入新依赖。

## 7. 验收标准

### 7.1 弹窗验收

- [ ] 打开使用说明弹窗，**首屏**即看到所有客户端组的接入指令（不再折叠）
- [ ] 弹窗文案中无「AgentProxy」（grep `UsageGuide.tsx` 应为 0 命中）
- [ ] 无供应商时，显示「去配置」按钮，点击后 SettingsModal 打开且弹窗关闭
- [ ] 复制按钮行为：点击后 toast「已复制到剪贴板」+ 图标切换到 ✓（与现状一致）
- [ ] 至少配了 1 个预设 + 1 个自定义 + 1 个 OpenAI 端点的场景下，弹窗内容正确分组

### 7.2 接入地址正确性（核心）

- [ ] 预设供应商生成的 Base URL = `http://{host}:{port}/{name}`，**无** `/api/` 也**无** `/custom/`
- [ ] 自定义供应商生成的 Base URL = `http://{host}:{port}/custom/{name}`
- [ ] OpenAI 端点生成的 Base URL 末尾带 `/v1`
- [ ] 端到端验证：用弹窗复制的命令在 shell 里 `echo $ANTHROPIC_BASE_URL`，再触发一次 Claude Code 请求，日志面板能看到该请求

### 7.3 README 验收

- [ ] README「使用方法」里，路径示例与 §3 规则一致
- [ ] README 与弹窗在「OpenAI `/v1`」的提示上一致

### 7.4 不变性

- [ ] 主界面布局（App / DetailPanel / KV-Cache）UI 与改造前像素一致
- [ ] 颜色 / 尺寸 token 未引入新硬编码
- [ ] 无新依赖

## 8. 风险与回滚

- 弹窗是高频功能但改动面小（单文件），回滚成本低
- README 改动只在文档，零运行时风险
- 若 §7.2 端到端验证失败，弹窗仍是降级为修地址（最小修复），不阻塞整体

## 9. 测试覆盖

按 CLAUDE.md「审查落到测试」要求：

- 新增 `integration-tests/usage-guide.spec.ts`（Playwright E2E）：
  - 打开使用说明 → 断言无 `/api/` 出现在 DOM
  - 断言至少一个客户端组标题存在
  - 无供应商状态 → 断言「去配置」按钮存在并可点击
  - 端到端：用 `export` 的命令验证请求经代理转发
- 现有 `tests/` 下的单元测试不受影响（UsageGuide 无独立单测，仅 E2E 覆盖）

## 10. 设计决策记录

| 决策 | 备选 | 选这个的原因 |
|-----|-----|-------------|
| 按客户端分（Claude Code / Codex） | 按供应商分 / 混合 | 用户视角"我要用某个客户端"更直接 |
| 平铺完整 export 命令（A 方案） | 三列网格（B 方案） | 复制即用最直接，避免漏拼 |
| 加「去配置」按钮 | 只文案 | 有引导比纯文案强 |
| 不加 FAQ/示例/调试 | 丰富内容 | 保持精简；YAGNI |
| 弹窗与 README 一起改 | 只改弹窗 | 文档侧也有一致性 bug，根因同源 |

## 11. 不做的事（再次明确）

- 不重做整体主界面布局
- 不动 KV-Cache 面板
- 不动 SettingsModal 内部
- 不做响应式
- 不动 token 系统
