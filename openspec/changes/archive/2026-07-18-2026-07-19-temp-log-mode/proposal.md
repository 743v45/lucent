## Why

Lucent 现在的日志开关是二态 `logRecording: boolean`——要么「全量落库」（true，按保留期清理），要么
「只过路不记」（false）。但调试转发链路、压测、或临时排查一个问题时，用户要的是**第三种状态**：短时
记录一阵（几分钟到半小时），自动清掉，**不污染存档库**。

现在的两态逼用户二选一：开 archive 记一堆压测垃圾进去（事后得手动清 / 等保留期），或开 off 啥也记不着、
抓不到现场。临时模式（temporary）填这个空——每条带 TTL（默认 30 分钟，可调短到几分钟），到期由独立
定时器（每 1 分钟）自动删，**切换模式不动已有数据**（已写入的临时日志按各自 TTL 继续过期）。

核心约束：清理彻底（不吃内存）、前端不堆积（软上限 + 渲染过滤已过期 + 服务端 loadLogs 已删 → 无幽灵条目）。

lead 已拍板的关键决策见设计文档决策表（expiresAt 注入咽喉点 `writeLogEntry` / 临时清理只 DELETE
不 VACUUM / 新增 `LUCENT_LOG_MODE` + 兼容 `LUCENT_LOG_RECORDING` / config.json 读时映射写时归一 /
API 前端一刀切 logMode / 删除 `WHERE expires_at IS NOT NULL` 护存档 / 前端软上限 500）。

## What Changes

### 后端

- **config 三态化（[`server/config.ts`](../../server/config.ts)）**
  - `ProxyConfig.logRecording: boolean` → `logMode: 'off'|'temporary'|'archive'`（+ `tempLogTtlMinutes?: number`，
    旧 `logRecording` 标 `@deprecated` 仅读兼容）；`ResolvedConfig` 同步必填两字段。
  - env 主入口换 `LUCENT_LOG_MODE`（三态白名单），保留 `LUCENT_LOG_RECORDING` 兼容
    （true→archive / false→off，无法表达 temporary）；新增 `LUCENT_TEMP_LOG_TTL_MINUTES`。
    优先级见 `resolveLogModeFromEnv`：**LUCENT_LOG_MODE > LUCENT_LOG_RECORDING > config.logMode > 默认 archive**，
    非法 env 值回退下一级不抛错（防拼错让进程起不来）。
  - `loadConfig` 读时兼容映射：旧 config.json 只有 `logRecording` → 映射成 logMode 后 `delete logRecording`
    （内存归一）；`setLogMode` 写盘只留 logMode（旧字段自然消亡，不丢用户磁盘配置）。
  - 运行时 live getter `getLogMode()`（热路径门控用，每次实时解析）+ `logModeEnvOverridden()`
    （env 锁定态，UI 禁用用）+ `setLogMode(mode, ttl?)`（持久化，返回有效值 + envLocked）。

- **db schema（[`server/services/db.ts`](../../server/services/db.ts)）**
  - `logs` 表加 `expires_at TEXT` 列：NULL=存档不过期，ISO 时间戳=临时到期。部分索引
    `idx_logs_expires ... WHERE expires_at IS NOT NULL`（只索引临时行，存档行不进索引、清理扫描不碰）。
  - 老库幂等迁移：`openDb` 里 `pragma table_info(logs)` 探测，无 `expires_at` 则
    `ALTER TABLE ADD COLUMN` + 补索引（`CREATE TABLE IF NOT EXISTS` 对已存在的旧表不会加列，故 ALTER 补；
    探测避免重跑报错）。
  - 新增 `deleteExpiredLogs(db, nowISO)`：镜像 `deleteOldLogs`（事务 + 级联 log_bodies + 手动删 FTS），
    **WHERE `expires_at IS NOT NULL AND expires_at < ?`**——NULL（存档）绝不误删。

- **写入门控 + 注入 + 临时清理（[`server/services/log-writer.ts`](../../server/services/log-writer.ts)）**
  - `writeLogEntry` 咽喉点：`getLogMode()==='off'` 短路（替换旧 `!isLogRecording()`）；**temporary 模式
    注入 `entry.expiresAt = now + ttl`**（`RawLogEntry.expiresAt?: string`，由 db.ts `toLogParams` 映射到
    `expires_at`）。TTL 是写入决策，和 mode 门控同处一个咽喉点，不散到 buildRequestEntry。
  - 新增 `cleanupExpiredLogs()`：调 `deleteExpiredLogs(getDb(), nowISO)` + `invalidateReaderCache()`，
    **不 VACUUM**（每分钟跑会卡代理，空间回收靠 24h 保留期清理的 VACUUM + WAL 增量页复用）。

- **独立清理定时器（[`server/index.ts`](../../server/index.ts)）**
  - 镜像 `retentionTimer`（24h）加 `tempCleanupTimer`：每 `TEMP_LOG_CLEANUP_INTERVAL_MS`（60s）跑
    `cleanupExpiredLogs`，**启动清一次**（不等首个 tick），`unref()` 不阻止退出，`shutdownServer` 里 `clearInterval`。

- **状态 + 切换端点（[`server/routes/status.ts`](../../server/routes/status.ts)）**
  - `GET /api/status` 暴露 `logMode` / `logModeEnvLocked` / `tempLogTtlMinutes`（替换旧 `logRecording` 二字段）。
  - `POST /api/recording` body 改 `{ logMode, tempTtlMinutes? }` → 调 `Config.setLogMode` →
    返回 `{ success, logMode, envLocked }`。**一刀切 logMode，不保留别名**（单人项目无外部消费者）。

### 前端

- **类型/API（[`src/types.ts`](../../src/types.ts) / [`src/utils/api.ts`](../../src/utils/api.ts)）**
  - `ProxyStatus` 的 `logRecording?` → `logMode?` / `logModeEnvLocked?` / `tempLogTtlMinutes?`；
    `setLogRecording(recording)` → `setLogMode(mode, ttl?)`。

- **顶栏三态开关（[`src/App.tsx`](../../src/App.tsx)）**
  - 二态 toggle（单 `EyeSlashIcon`）→ **antd `Segmented` 三态**（只过路 / 临时 / 存档）；**临时态内联一个
    `InputNumber` 改 TTL**（分钟，≥1）。切换无二次确认，弹轻 toast；`logModeEnvLocked=true` 时 Segmented
    禁用 + tooltip 提示被 env 锁定（点击给 `message.warning` 而非静默）。

- **不堆积（[`src/hooks/useLogs.ts`](../../src/hooks/useLogs.ts) / [`src/components/dashboard/LogListPanel.tsx`](../../src/components/dashboard/LogListPanel.tsx)）**
  - `useLogs` 软上限 500（列表不无限涨）+ **渲染时过滤已过期**（`expires_at < now` 的条目不渲染）；
    服务端 `loadLogs` 已删的不会下发 → 无幽灵条目。
  - `LogListPanel` 给临时条目加视觉标记（时钟角标 / dim），区分存档 vs 临时。

### 验收 / 副修

- **db 清理测试（[`tests/db.test.ts`](../../tests/db.test.ts)）**：镜像 `deleteOldLogs — 级联清理` 用例，加
  `deleteExpiredLogs` 用例——插几条（一条 `expires_at` 已过期、一条 NULL 存档、一条未到期临时），断言
  只删过期的、存档与未到期不动、log_bodies/FTS 级联清（搜不到）。
- **端到端三态场景（[`scripts/verify-e2e.mjs`](../../scripts/verify-e2e.mjs)）**：把现有场景 13-15（二态 recording）
  扩成三态——temporary 发请求 → 计数 +1 且条目带 TTL；切 off → 转发照旧且计数不增；切 archive → 计数 +1 无 TTL。
  反向用例（off 不增）配正向对照（archive/temporary 必增），否则「计数不变」可能是请求没到、空过断言。
- **e2e fixture 同步**：`/api/recording` body 由 `{recording}` 改 `{logMode, tempTtlMinutes?}`、`/api/status`
  字段换 `logMode`/`logModeEnvLocked`/`tempLogTtlMinutes`，脚本里 `setRecording`/`getStats` 工具与 13-15 断言
  一并改名同步（防冷启 flake）。
- **修文档 drift（[`docs/log-storage-design.md`](../../docs/log-storage-design.md)）**：L21/L53 的「30 天」→「3 天」
  （代码真相 `LOG_RETENTION_DAYS = 3`）；logs 表描述补 `expires_at`；配置表补 `LUCENT_LOG_MODE` /
  `LUCENT_TEMP_LOG_TTL_MINUTES`；补一段临时 TTL 清理（每分钟、只 DELETE 不 VACUUM）与保留期清理
  （每 24h、DELETE+VACUUM）并存说明。
- README 不涉及用户可见 URL/命令变化（开关是 UI 操作），无需改命令表。

## Capabilities

### New Capabilities
- **`log-mode`**：日志记录三态模式（off / temporary / archive）+ temporary 模式 TTL 自动清理 + 立即清临时 +
  配置优先级与旧字段兼容 + 切换不动已有数据 + 前端不堆积 + status/recording 三态契约。稳定行为契约见
  [`specs/log-mode/spec.md`](specs/log-mode/spec.md)（8 个 Requirement，每个带 GIVEN/WHEN/THEN Scenario）。

### Modified Capabilities
- **`e2e-verification`**：verify-e2e.mjs 场景 13-15 由二态 recording 扩成三态 logMode（temporary 带 TTL /
  off 不增 / archive 无 TTL），与 spec「断言可观测、失败退出非 0」一致，反向用例配正向对照。

## Impact

- **受影响代码**：
  - [`server/config.ts`](../../server/config.ts)：`logMode`/`tempLogTtlMinutes` 字段 + env 解析 +
    `loadConfig` 兼容映射 + `getLogMode`/`setLogMode`/`logModeEnvOverridden`。
  - [`server/constants.ts`](../../server/constants.ts)：`TEMP_LOG_TTL_MINUTES` / `TEMP_LOG_CLEANUP_INTERVAL_MS`。
  - [`server/services/db.ts`](../../server/services/db.ts)：`expires_at` 列 + `idx_logs_expires` 部分索引 +
    `openDb` ALTER 迁移 + `deleteExpiredLogs`。
  - [`server/services/log-writer.ts`](../../server/services/log-writer.ts)：`writeLogEntry` 三态门控 +
    expiresAt 注入 + `cleanupExpiredLogs`。
  - [`server/index.ts`](../../server/index.ts)：`tempCleanupTimer`（启动清一次 + 每 60s + shutdown clearInterval）。
  - [`server/routes/status.ts`](../../server/routes/status.ts)：`/api/status` 三字段 + `POST /api/recording` body。
  - [`src/App.tsx`](../../src/App.tsx) / [`src/types.ts`](../../src/types.ts) / [`src/utils/api.ts`](../../src/utils/api.ts)：
    Segmented 三态 + TTL InputNumber + 类型 + `setLogMode`。
  - [`src/hooks/useLogs.ts`](../../src/hooks/useLogs.ts) / [`src/components/dashboard/LogListPanel.tsx`](../../src/components/dashboard/LogListPanel.tsx)：
    软上限 500 + 过期过滤 + 临时标记。
  - [`tests/db.test.ts`](../../tests/db.test.ts) / [`scripts/verify-e2e.mjs`](../../scripts/verify-e2e.mjs) /
    [`docs/log-storage-design.md`](../../docs/log-storage-design.md)：清理测试 + 三态 e2e + 文档 drift。
- **不改**：转发链路（[`server/proxy.ts`](../../server/proxy.ts)）零改动（开关只门控写库 + 注入 TTL，转发、
  URL 组合、body 重写照旧）；24h 保留期清理逻辑（`cleanupOldLogs` / `deleteOldLogs` / VACUUM）不变，只是
  多一个并行的每分钟临时清理；SQLite 三表结构（logs / log_bodies / logs_fts）只加一列。
- **新增风险**：
  - **每分钟定时器开销**：`tempCleanupTimer` 每 60s 一次 `SELECT rowid + DELETE`（命中部分索引，
    O(临时行数)），无 VACUUM 故无全库写锁；长驻进程累积开销可接受，最坏情况是临时行已到期但最多滞后 60s
    才删（可接受，前端渲染再过滤一道兜底）。
  - **env 锁定语义**：`LUCENT_LOG_MODE`（或兼容的 `LUCENT_LOG_RECORDING`）设了之后，UI 切换写入的 config
    值不立即生效（要等 env 去掉）。靠 `logModeEnvLocked` 让 Segmented 禁用 + 提示，避免用户以为开关坏了。
  - **临时数据与保留期清理的关系**：两条清理路径独立——临时清理按 `expires_at`（每分钟，只 DELETE），
    保留期清理按 `timestamp`（每 24h，DELETE+VACUUM）。存档行 `expires_at IS NULL` 不会被临时清理碰；
    临时行若没到期但早于保留期也会被保留期清理按 timestamp 删（早于 3 天的临时行本就该没）。两者 WHERE
    不交集，误删风险为零。
