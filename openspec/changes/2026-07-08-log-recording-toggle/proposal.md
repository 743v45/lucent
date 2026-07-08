## Why

Lucent 现在是「全量记录」——每个穿越代理的请求都会写 SQLite（`log-writer.writeLogEntry`
→ `insertLog`）。但调试转发链路、跑压测、或者只是想让真实上游流量穿过而不落库时，用户
没有「只过路、不记录」的出口：要么停掉整个代理（连转发也没了），要么事后手动清库。

TAE-76 要的就是这个出口：顶栏加一个独立两态开关，关掉后**转发链路完全照旧**，只停掉
「落库」。开关状态持久化进 `~/.lucent/config.json`，重启不丢；默认仍是全量记录（现状）。
lead 已拍板：默认 `logRecording=true`，支持 env `LUCENT_LOG_RECORDING` 覆盖（走现有 env 优先级），
关记录不要二次确认，切换弹轻 toast。

## What Changes

### 后端

- **config（[`server/config.ts`](../../server/config.ts)）**
  - `ProxyConfig` 加可选字段 `logRecording?: boolean`（缺省视为 `true`，向后兼容老配置文件）。
  - `ResolvedConfig` 加必填 `logRecording: boolean`。
  - `resolveEffectiveConfig()` 用新 `parseEnvBool('LUCENT_LOG_RECORDING', raw.logRecording ?? true)`
    解析，优先级 **env > 配置文件 > 默认 true**（与 `logDir`/`dbPath`/`logRetentionDays` 同一套）。
  - `buildDefaultConfig()` 显式写 `logRecording: true`（新装的 config.json 可见、可改）。
  - `validateConfig()` 允许该字段缺省，存在时必须是 boolean（防拼错静默失效，与 bodyRewrites 同风格）。
  - 新增运行时 live getter `isLogRecording(): boolean`——每次实时解析（env ?? config ?? true），
    反映 toggle 改动，给热路径门控用。
  - 新增 `setLogRecording(value): { recording, envLocked }`——写 `config.logRecording` + `saveConfig`，
    返回**有效值**与「是否被 env 锁定」。env 锁定时写入仍落盘（保留用户意图，等 env 去掉后生效），
    但有效值不变。

- **记录 gate（[`server/services/log-writer.ts`](../../server/services/log-writer.ts)）**
  - 在 `writeLogEntry` 顶部加 `if (!isLogRecording()) return`——**单一咽喉点**，一次性盖住
    `interceptor.ts` 全部 5 个 `writeLogEntry` 调用点（流式成功/流式失败/非流式/非流式失败/异常路径）
    及未来新增调用点。
  - **不散射 5 处 `if`**：咽喉点优于在 interceptor 里逐处判断（少错、单源、易审）。
  - **SSE 推送**：`routes/logs.ts` 的实时推送本就是未接通的骨架（`sseClients` 已移除，仅保活心跳，
    见文件 TODO）——「不写库」即「无可推之物」，咽喉点 gate 已满足「停掉 SSE 推送」。无需额外改动。

- **转发链路（`server/proxy.ts` / body 重写）**：**零改动**。开关只门控写库，转发、URL 组合、body
  重写照旧读 config 执行。流式响应仍 `tee()`（对客户端字节透明），只是 log 那一支最终不落库。

- **状态 + 切换端点（[`server/routes/status.ts`](../../server/routes/status.ts)）**
  - `GET /api/status` 增 `logRecording`（有效值）+ `logRecordingEnvLocked`（env 是否锁定）。
  - 新增 `POST /api/recording`，body `{ recording: boolean }` → 调 `Config.setLogRecording` →
    返回 `{ success, recording, envLocked }`。
  - **端点形态决策**：单开 `/api/recording`，不复用 config/provider update。理由：它是和
    `/api/enable` `/api/disable` 同性质的「运行态开关」，放 status router 里对称；而 provider/bodyRewrites
    的 PUT 带严格结构校验，混进去语义不干净。

### 前端

- **类型/API（[`src/types.ts`](../../src/types.ts) / [`src/utils/api.ts`](../../src/utils/api.ts)）**
  - `ProxyStatus` 加 `logRecording?: boolean` / `logRecordingEnvLocked?: boolean`。
  - `getProxyStatus` 返回类型同步；新增 `setLogRecording(recording)` 封装 `POST /api/recording`。

- **顶栏开关（[`src/App.tsx`](../../src/App.tsx)）**
  - 右上角操作区加第 5 个**两态 toggle**（heroicons `EyeSlashIcon`/`EyeIcon`）：
    - 记录中（`logRecording=true`）→ `EyeIcon`，常规色，tooltip「记录日志中（点击切到只过路）」。
    - 只过路（`logRecording=false`）→ `EyeSlashIcon`，高亮态（`text-brand-accent` + `bg-bg-active`），
      tooltip「只过路（不记录日志）」。
  - 点击即切（**无二次确认**），调 `setLogRecording(next)`，成功后更新本地态 + `message.success`
    轻 toast（「已切到只过路：转发照旧，不再记录日志」/「已恢复记录日志」）。
  - `logRecordingEnvLocked=true` 时按钮禁用 + tooltip 提示「被环境变量 LUCENT_LOG_RECORDING 锁定」，
    点击给 `message.warning`（而非静默）。
  - 初值随现有 `getProxyStatus` 拉取（App 已有该 effect，顺带取 `logRecording`）。

### 验收 / 副修

- **`scripts/verify-e2e.mjs`**：加记录开关场景，并把**陈旧的 11/12 场景**从「读 `.jsonl` 文件」
  改为「读 SQLite 后端」——存储早已切 SQLite（无双写），原 JSONL 读法在干净临时目录下永远 0 条，
  场景 11 现在**恒 FAIL**（baseline 已确认 `13/14 通过, 1 失败`，退出码 1）。本次随记录开关一起修：
  - 改用 `GET /api/logs/stats`（`totalEntries` = `SELECT COUNT(*) FROM logs`）做计数断言。
  - 新增**反向用例**：`POST /api/recording {recording:false}` → 发请求 → 断言上游**仍收到**（转发不变）
    **且** `totalEntries` 不增（SQLite 无新增行）；若 gate 失效、库里多了一行，**必须 FAIL、退出非 0**。
  - 配套正向对照：切回 `recording:true` → 发请求 → `totalEntries` 必增（证明非空判）。
- README 不涉及用户可见 URL/命令变化（开关是 UI 操作），无需改命令表。

## Capabilities

### New Capabilities
无（沿用现有 config / status / logging 能力面，不新增独立 spec capability）。

### Modified Capabilities
- **logging（事实契约，散落在 `log-writer` / `routes/logs`，无独立 spec 文件）**：新增「记录开关」
  行为契约——`ProxyConfig.logRecording`（boolean，缺省 true，env `LUCENT_LOG_RECORDING` 覆盖）；
  `writeLogEntry` 在 `logRecording=false` 时短路不落库；转发链路（proxy / body 重写）不受影响；
  `GET /api/status` 暴露有效值 + env 锁定态；`POST /api/recording` 切换并持久化；已有日志不清空。
- **`e2e-verification`**：verify-e2e.mjs 场景 11/12 由「读 JSONL」改为「读 SQLite stats/logs」，
  并新增「只过路 → 无新增行」反向断言（与 e2e-verification spec「断言可观测、失败退出非 0」一致）。

## Impact

- **受影响代码**：
  - [`server/config.ts`](../../server/config.ts)：`ProxyConfig`/`ResolvedConfig` 加字段 + env 解析 +
    `validateConfig` 放行 + `isLogRecording`/`setLogRecording`/`logRecordingEnvOverridden`。
  - [`server/services/log-writer.ts`](../../server/services/log-writer.ts)：`writeLogEntry` 顶部 gate。
  - [`server/routes/status.ts`](../../server/routes/status.ts)：`/api/status` 增字段 + 新增 `POST /api/recording`。
  - [`src/App.tsx`](../../src/App.tsx)：顶栏第 5 个 toggle 按钮 + 本地态 + toast。
  - [`src/types.ts`](../../src/types.ts) / [`src/utils/api.ts`](../../src/utils/api.ts)：类型 + `setLogRecording`。
  - [`scripts/verify-e2e.mjs`](../../scripts/verify-e2e.mjs)：场景 11/12 改 SQLite 读法 + 新增记录开关反向用例。
- **不改**：转发路径（`proxy.ts`）、URL 组合、body 重写引擎、保留期清理、SQLite schema、KV-Cache/agent
  分类等副作用（这些副作用由转发与提取链路固有，开关只决定要不要把结果落库）。
- **新增风险**：
  - **gate 放咽喉点 vs interceptor**：选咽喉点（`writeLogEntry`）后，流式响应的 `tee()` + SSE 后台提取
    仍会跑（CPU/缓冲开销），只是结果不落库。这是为「转发链路零改动、最低风险」付出的代价；属可接受
    的轻量开销，后续可单独优化（在 interceptor 提前短路、跳过 tee）。本提案不做，避免触碰转发路径。
  - **env 锁定语义**：env 设了之后，UI 开关写入的 config 值不立即生效（要等 env 去掉）。需靠
    `logRecordingEnvLocked` 让 UI 禁用 + 提示，避免用户以为开关坏了。
  - **反向用例非空判**：必须配正向对照（切回 true → 计数必增），否则「计数不变」可能是别的原因
    （如请求根本没到、isTest 被过滤），断言会空过。
