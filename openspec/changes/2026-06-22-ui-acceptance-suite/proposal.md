## Why

项目现有 5 个 `verify:*` 脚本(`scripts/verify-{anthropic,openai-chat,openai-responses,custom,custom-errors}-e2e.ts`)覆盖了**协议链路的数据渲染**——通过 `chromium.launch()` + `getByTestId` 断言"数据有没有出现在 DOM 里"。但这套脚本对**交互行为和 UX 流程**基本是空白:

- **未覆盖的交互面**:
  - `SettingsModal`(`src/components/settings/SettingsModal.tsx`,665 行)—— provider 增删改、endpoint 编辑/测试/重置、URL 校验,**完全没测试**
  - `UsageGuide` modal —— 只测了纯函数 `buildAccessLines`,modal 打开/复制/跳转都没测
  - 顶栏三按钮(refresh / usage / settings)—— 无 testid、无测试
  - `LogListPanel` 的时间线↔会话切换、provider/endpoint 筛选、空/加载态、滚动加载—— 无测试
  - `DetailPanel` 的 KV-Cache tab、Meta tab、SSE 结构化↔原始 toggle —— 无测试
- **现有脚本的工程问题**:
  - 5 个脚本各自手搓 `chromium.launch()` + `spawn backend` + `spawn vite dev`,**没有 `playwright.config.ts`**;本地 `npx playwright test` 跑不起来,只能跑 npm 脚本
  - 全是单浏览器(只有 chromium),且每个 assertion block 独立 launch/close browser,无 fixture 复用
  - testid 选择器只有 5 个(`log-row` / `tab-{key}` / `request-body` / `response-body` / `context-item`),被 `protocol-chain-verification` spec 第 4 条 Requirement 当契约锁死;一旦 UI 交互要加测试,testid 就不够用

**结论**:协议链路那条线已经有契约保护;但"点按钮/填表单/切视图后 UI 行为对不对"这条线没有。需要一个**独立的 UI 测试套件**,既能进 CI 做防回归网,也能本地单跑调试。

## What Changes

### 新增:独立 Playwright UI 测试套件

**不动现有 5 个 `verify:*` 脚本**(它们是 `protocol-chain-verification` 契约的落地,继续作为"协议链路数据渲染"层)。新增第 4 层验收——**UI 交互与视觉层**——与之并列。

#### 1. 脚手架

- 新增 `playwright.config.ts`:单一 `project`(chromium),`webServer` 指向 `scripts/start-ui-env.ts`
- 新增 `scripts/start-ui-env.ts`:单进程拉起 backend(`tsx server/index.ts`)+ vite dev(`--port VITE_PORT --strictPort`)+ mock upstream(`createMockUpstream({ format: 'auto' })`)+ seed 一批 `.jsonl` 日志;监听 `SIGTERM` 优雅退出
- 这样本地 `npx playwright test` 开箱即跑,CI 同一套

#### 2. 目录结构

```
playwright.config.ts
scripts/start-ui-env.ts
tests/ui/
  ├── fixtures/
  │   ├── env.ts          # 全局 setup:seed 数据、page fixture 扩展
  │   └── seed.ts         # 构造覆盖各场景的 LogEntry JSONL
  ├── pages/              # Page Object
  │   ├── TopBar.ts
  │   ├── LogListPanel.ts
  │   ├── DetailPanel.ts
  │   ├── SettingsModal.ts
  │   └── UsageGuide.ts
  ├── *.spec.ts           # 8 个 spec 文件
  └── snapshots/          # toHaveScreenshot baseline,提交进 git
```

#### 3. testid 补齐(代码改动面)

按交互面分组,命名沿用现有 kebab-case(`log-row` / `tab-{key}` / `context-item`)。**动作各自独立 testid**,最细粒度最稳。

**顶栏** (`src/App.tsx`):`topbar-refresh` / `topbar-usage` / `topbar-settings`

**LogListPanel** (`src/components/dashboard/LogListPanel.tsx`):
- `loglist-view-timeline` / `loglist-view-session`(两个切换按钮)
- `loglist-filter-provider` / `loglist-filter-endpoint`(两个 Select)
- `loglist-count`(条数文本) / `loglist-empty`(空态)
- `loglist-session-group`(会话分组头,带 `data-threadid`)

**DetailPanel** (`src/components/viewer/DetailPanel.tsx`,现有 5 个保留):
- KV-Cache:`kvcache-hit-rate` / `kvcache-group`(带 `data-id`) / `kvcache-copy-all`
- Meta:`meta-row`(带 `data-key`)
- SSE toggle:`sse-toggle-structured` / `sse-toggle-raw`
- 通用:`copy-button`(带 `data-target`) / `collapse-button`(带 `data-target`)

**SettingsModal** (`src/components/settings/SettingsModal.tsx`,当前 0 testid):
- `settings-modal`
- `settings-preset-card`(带 `data-name`)
- `settings-custom-input` / `settings-custom-create` / `settings-custom-error`
- `settings-provider-card`(带 `data-name`) / `settings-provider-delete` / `settings-provider-rename`
- `settings-endpoint-input`(带 `data-endpoint`) / `settings-endpoint-test` / `settings-endpoint-reset` / `settings-endpoint-warning`
- `settings-copy-access-url`

**UsageGuide** (`src/components/common/UsageGuide.tsx`):
- `usage-guide-modal` / `usage-access-line`(带 `data-client`) / `usage-copy-line`(带 `data-client`) / `usage-goto-settings`

#### 4. spec 文件(8 个)

| spec 文件 | 覆盖场景 |
|---|---|
| `topbar.spec.ts` | 三按钮可点 + 各自打开对应 Modal |
| `loglist.spec.ts` | 列表渲染 / 空态 / 时间线↔会话切换 / provider 筛选 / endpoint 筛选 / 会话分组折叠 / 点 row 选中 / 滚动加载更多 / 视觉快照(空态/多条) |
| `detail-request-response.spec.ts` | Request-Body / Response-Body / SSE 结构化↔原始 toggle / copy / collapse / 视觉快照 |
| `detail-kvcache.spec.ts` | 命中率颜色阈值 / group 折叠 / 复制全部 / 各种空态分支 / 视觉快照 |
| `detail-meta.spec.ts` | 每行 MetaRow 渲染 / tooltip / error 行 / 视觉快照 |
| `detail-context.spec.ts` | Context 列表 + role / 折叠分组 / markdown 渲染(现有 context-item testid 的交互补充) |
| `settings.spec.ts` | 打开 Modal / preset 网格 / 创建 custom(名字校验:合法/非法/重复/保留名)/ 删除+确认 / 重命名 / endpoint URL 编辑+失焦保存+非法 URL 警告 / 测试连接结果渲染 / reset-to-default / 复制访问 URL / 视觉快照(preset 网格 + provider 展开卡) |
| `usage-guide.spec.ts` | 打开 Modal / 分组渲染 / 每行复制到剪贴板 / "去配置"跳转 Settings / 空态 / 视觉快照 |

(URL 参数同步 `?log=&tab=`、顶栏 refresh 后列表更新等跨组件流,合并进对应组件的 spec,不单开 cross-flow 文件,避免 spec 文件数膨胀。)

#### 5. seed 数据

`tests/ui/fixtures/seed.ts` 构造一批 `.jsonl` 日志条目,覆盖:
- 空 / 单条 / 多条
- SSE 流式 / 非流式 JSON
- 错误状态码(401 / 429 / 500)
- KV-Cache 命中 + 未命中(覆盖率分别跨过 `CACHE_HIT_RATE_GOOD_THRESHOLD` / `CACHE_HIT_RATE_BAD_THRESHOLD` 两个阈值)
- 多 provider × 多 endpoint(喂筛选下拉)
- 带 `threadId`(喂会话视图)

#### 6. npm 脚本

`package.json` 新增:
```json
"verify:ui": "playwright test",
"verify:ui:update": "playwright test --update-snapshots",
"verify:ui:report": "playwright show-report"
```

#### 7. OpenSpec 契约落地

- 走本 change proposal(`openspec/changes/2026-06-22-ui-acceptance-suite/`)经确认 → 实现 → 验证 → `openspec archive` 归档
- 归档后**新建** `openspec/specs/ui-acceptance/spec.md`:锁定 testid 清单(上面 4 类)、spec 文件清单(8 个)、webServer 约定、视觉快照 baseline 工作流
- **不**改 `protocol-chain-verification` spec(职责分离:它管协议链路数据渲染,新 spec 管 UI 交互与视觉)
- **修正**:`protocol-chain-verification` Requirement 8 描述的 Expand All / Collapse All 按钮已被 `2026-06-18-fix-detailpanel-collapse-duplicate` 移除,该 Requirement 已 stale。本 change 在归档时**顺带标注 Requirement 8 作废**(发现 stale 是补 UI 测试的自然副产品,不单开 change)

## Capabilities

### New Capabilities

- `ui-acceptance`(新 spec)—— UI 交互与视觉层的验收契约:testid 清单、spec 文件清单、webServer 约定、快照工作流

### Modified Capabilities

- 无。`protocol-chain-verification` 保持原职(协议链路数据渲染),只接受 stale 的 Requirement 8 标注(见 Impact)

## Impact

### 受影响代码

- **新增**:`playwright.config.ts` / `scripts/start-ui-env.ts` / `tests/ui/`(全部)/ `src/testids.ts`(testid 字符串常量单源)
- **改动(加 testid)**:`src/App.tsx` / `src/components/dashboard/LogListPanel.tsx` / `src/components/viewer/DetailPanel.tsx` / `src/components/settings/SettingsModal.tsx` / `src/components/common/UsageGuide.tsx`(组件 import `src/testids.ts` 的常量)
- **不改**:server/ 任何代码、日志读写、HTTP API、现有 5 个 verify 脚本

### 受影响测试 / 契约

- `protocol-chain-verification` spec Requirement 8(Expand All / Collapse All)与现状不符(按钮已删)。本 change 在归档时**顺带标注作废**,不单开 change(理由见上文 "OpenSpec 契约落地")
- 现有 5 个 verify 脚本引用的 5 个 testid 不变,无回归风险

### 不变量

- 现有 `verify:e2e` / `verify:anthropic` / `verify:openai-chat` / `verify:openai-responses` / `verify:custom` / `verify:custom-errors` 行为不变,退出码语义不变
- 现有 5 个 testid 的语义不变
- `~/.lucent/config.json` 不被任何测试碰(start-ui-env.ts 用临时 `LUCENT_CONFIG_DIR`)

### 风险与权衡

- **快照误报**:视觉快照对字体渲染、抗锯齿、OS 版本敏感。缓解:CI 跑在固定 Docker 镜像里;`verify:ui:update` 走 PR review 流程,baseline 改动必须人审
- **testid 维护成本**:细粒度 testid 多,改名要同步改 spec。缓解:**新建 `src/testids.ts` 把所有 testid 字符串集中成常量**,组件和 spec import 同一常量,改名只改一处
- **CI 时间**:8 个 spec × chromium 单浏览器,估计 +30-60s。可接受
- **mock upstream 单点**:`start-ui-env.ts` 一个 mock 服务 3 协议,跟现有 verify 脚本一致(`format: 'auto'` 已验证可行)
