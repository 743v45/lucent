# log-mode Specification

## Purpose
TBD - created by archiving change 2026-07-19-temp-log-mode. Update Purpose after archive.
## Requirements
### Requirement: logMode 三态门控写入（off / temporary / archive）
`ProxyConfig.logMode` SHALL 取值 `off` | `temporary` | `archive`（缺省 `archive`，保持原全量记录语义）。`writeLogEntry`（`server/services/log-writer.ts`）作为唯一咽喉点 MUST 按 mode 门控：`off` 短路不落库（转发链路照旧）；`temporary` 落库且注入 `expires_at`；`archive` 落库且 `expires_at` 为 NULL。门控 MUST 用运行时 live getter `getLogMode()`（每次实时解析，反映 toggle 改动），MUST NOT 缓存启动快照。

**Rationale:** 二态 `logRecording` 逼用户在「记一堆」与「啥也不记」间二选一，调试/压测无中间态。咽喉点门控一次性盖住 interceptor 全部 5 个 `writeLogEntry` 调用点 + 未来新增，避免散射 `if`。

#### Scenario: off 不落库，转发照旧
- **GIVEN** `logMode === 'off'`
- **WHEN** 一个请求穿越代理（上游收到、客户端收到响应）
- **THEN** SQLite 日志计数不增
- **AND** 上游请求/响应字节不受影响

#### Scenario: archive 落库且 expires_at 为 NULL
- **GIVEN** `logMode === 'archive'`
- **WHEN** 一个请求完成并写入日志
- **THEN** `logs.expires_at` MUST 为 NULL（存档，仅受保留期清理约束）

#### Scenario: temporary 落库且 expires_at 非空
- **GIVEN** `logMode === 'temporary'`
- **WHEN** 一个请求完成并写入日志
- **THEN** `logs.expires_at` MUST 为一个 ISO 时间戳（非 NULL）

### Requirement: temporary 模式的 expires_at 必须用实时 TTL 注入，TTL 允许 0（立即过期）

`writeLogEntry`（server/services/log-writer.ts）在 `temporary` 模式注入 `entry.expiresAt = ISO(now + ttlMinutes)`，其中 `ttlMinutes` 由运行时 live getter `getTempTtlMinutes()`（server/config.ts）决定（env `LUCENT_TEMP_LOG_TTL_MINUTES` > `config.tempLogTtlMinutes` > 默认 30）。`ttlMinutes` SHALL 为非负整数（`>= 0`，`validateConfig` 与 `getTempTtlMinutes` 均按 `>= 0` 校验/解析）：`0` 表示立即过期——注入的 `expires_at ≈ now`，写入后由独立清理定时器（每 `TEMP_LOG_CLEANUP_INTERVAL_MS`，默认 180s = 3 分钟）删除，等同「记完即清」。MUST NOT 使用 server 启动时的 `resolvedConfig` 快照——用户运行时改 TTL（顶栏 Popover 存活时长 InputNumber）必须立即反映到后续写入。

**Rationale:** `logMode` 走 `getLogMode()` 实时，若 TTL 读启动快照则两者不一致——用户前端改 TTL 后写入仍用旧值。TTL 允许 0 取代了原先的「立即清空临时日志」按钮（`DELETE /api/logs/temporary` / `purgeTemporaryLogs` / `deleteAllTemporaryLogs` / `api.clearTemporaryLogs` 已全部删除，无消费者）：用户要「记完即清」时设 TTL=0，由既有清理定时器消化，无需新增一条手动删除路径。e2e 回归断言（改 TTL→临时发请求→`expires_at` 距 now ≈ 新 TTL 分钟）专门守这条。清理定时器间隔默认值随定时器 Requirement 同步放宽至 3 分钟（180s）。

#### Scenario: 运行时改 TTL 后写入反映新值
- **GIVEN** `logMode === 'temporary'`，启动时 TTL=30
- **WHEN** 运行时 `setLogMode('temporary', 7)` 后发一个请求
- **THEN** 新日志的 `expires_at` 距 `now` 约 7 分钟（容差 ±2 分钟）
- **AND** MUST NOT 是约 30 分钟（旧快照值）

#### Scenario: TTL=0 写入立即过期
- **GIVEN** `logMode === 'temporary'`，`getTempTtlMinutes()` 返回 0（env `LUCENT_TEMP_LOG_TTL_MINUTES=0` 或 config `tempLogTtlMinutes: 0`）
- **WHEN** 一个请求完成并写入日志
- **THEN** 新日志的 `expires_at` 距 `now` 约 0 分钟（`expires_at ≈ now`）
- **AND** 下一次清理定时器扫描（最多滞后 `TEMP_LOG_CLEANUP_INTERVAL_MS`）时该行被删除

### Requirement: 临时日志由独立定时器按 expires_at 清理，存档行不受影响

系统 MUST 运行一个独立于保留期清理（每 24h）的定时器，按 `TEMP_LOG_CLEANUP_INTERVAL_MS`（默认 180000ms = 3 分钟，原 60s）扫描并 `DELETE FROM logs WHERE expires_at IS NOT NULL AND expires_at < now`（事务内级联 `log_bodies` + 手动删 `logs_fts`）。WHERE 子句 MUST 带 `expires_at IS NOT NULL`，保证存档行（NULL）绝不被误删。该清理 MUST NOT 执行 `VACUUM`（全库写锁，频繁跑会卡代理写入）；空间回收交给 24h 保留期清理的 VACUUM + WAL 增量页复用。

定时器 MUST 按 `logMode` 自适应启停，避免 `off` / `archive` 模式下空转扫描一个不再增长的库：

- `logMode === 'temporary'`：定时器 MUST 持续运行（`temporary` 模式持续产生带 `expires_at` 的增量行）。
- `logMode !== 'temporary'`（`off` / `archive`）：定时器 MUST 在每次清理后评估自停——当且仅当 `countTemporaryLogs(db) === 0`（库内无任何 `expires_at IS NOT NULL` 的行，含未到期存量）时 `clearInterval` 自停。
- 切回 `temporary`（`POST /api/recording` → `setLogMode('temporary')` 成功后）MUST 调 `startTempCleanupTimer()`（幂等：已在跑则 no-op）重启定时器。

"存量清完"的判定 MUST 用 `countTemporaryLogs === 0`（库内无任何临时行），MUST NOT 用「本次删除返回 0 行」——后者会让关闭 `temporary` 时残存的**未到期**临时行（`expires_at` 在未来）因本次扫描删 0 行而触发自停，导致该行永不清理。`countTemporaryLogs` 查询 `SELECT count(*) FROM logs WHERE expires_at IS NOT NULL`，命中部分索引 `idx_logs_expires`。

调度逻辑 MUST 封装在独立模块（`server/services/temp-cleanup-scheduler.ts`）的 `startTempCleanupTimer` / `stopTempCleanupTimer` 中。`server/config.ts` 的 `setLogMode` MUST NOT 直接操作定时器（避免 config → index 耦合）；重启 hook 由 `POST /api/recording` 路由层在 `setLogMode` 成功后触发。`server/index.ts` 的 `startServer` MUST 调 `startTempCleanupTimer`（含启动清一次），`shutdownServer` MUST 调 `stopTempCleanupTimer`。

**Rationale:** 原实现定时器常驻，`off` / `archive` 模式下无临时增量仍每 60s 空转扫描（日志反复 `删除 0 行`）。自适应启停让定时器只在有活儿时跑：`temporary` 常驻清增量、`off` / `archive` 清完成残存存量后停、切回 `temporary` 重启。3 分钟间隔比 1 分钟更省（临时 TTL 默认 30 分钟，3 分钟粒度足够）。自停用 `count=0` 而非「删 0 行」是正确性关键——未到期存量行需要定时器留着等它们过期，否则永久残留。

#### Scenario: temporary 模式定时器常驻（即使本次删 0 行也不停）
- **GIVEN** `logMode === 'temporary'`，库内临时行均未到期
- **WHEN** 一次清理定时器回调执行（删除 0 行）
- **THEN** 定时器 MUST NOT 自停，继续按 `TEMP_LOG_CLEANUP_INTERVAL_MS` 运行
- **AND** 待临时行到期后下次回调删除它们

#### Scenario: off/archive 清完成残存存量后自停
- **GIVEN** `logMode === 'off'`（或 `'archive'`），库内仍有若干已过期临时行（存量）
- **WHEN** 定时器回调清理掉全部过期行后 `countTemporaryLogs === 0`
- **THEN** 定时器 MUST `clearInterval` 自停
- **AND** 不再产生空转扫描

#### Scenario: 关闭时有未到期临时行，定时器续跑到过期删完才停
- **GIVEN** `logMode` 从 `'temporary'` 切到 `'archive'`，库内一条 `expires_at = now + 10min` 的未到期临时行
- **WHEN** 切换后第一次定时器回调（该行未过期）
- **THEN** 本次删除 0 行，但 `countTemporaryLogs === 1`（≠ 0），定时器 MUST NOT 自停
- **AND** 10 分钟后该行过期，下次回调删除它，`countTemporaryLogs` 归 0，定时器自停

#### Scenario: 切回 temporary 重启已自停的定时器
- **GIVEN** 定时器已自停（`logMode` 曾为 `off` / `archive` 且存量清完）
- **WHEN** `POST /api/recording { logMode: 'temporary' }` 成功
- **THEN** `startTempCleanupTimer()` MUST 被调用，定时器重新运行
- **AND** 重复调用 `startTempCleanupTimer` MUST 幂等（不重复 `setInterval`）

#### Scenario: 全存档库启动后首次回调自停
- **GIVEN** 启动时 `logMode === 'archive'`，库内无任何 `expires_at` 非空行
- **WHEN** `startServer` 调 `startTempCleanupTimer`（启动清一次）
- **THEN** 启动清理返回 0，`countTemporaryLogs === 0`，定时器自停
- **AND** 切到 `temporary` 前不再空转

#### Scenario: 已过期临时行被删，未过期临时与存档保留
- **GIVEN** 库内有：`expires_at` 已过期、`expires_at` 未到期、`expires_at` NULL（存档）各一行
- **WHEN** `deleteExpiredLogs(db, now)` 执行
- **THEN** 只删过期那 1 行（返回 1）
- **AND** 未到期临时与存档行都在（`logs` / `log_bodies` / `logs_fts` 三表级联一致）

#### Scenario: 全存档库（无 expires_at 非空行）清理返回 0 不误删
- **GIVEN** 库内全是存档行（`expires_at` 均 NULL）
- **WHEN** `deleteExpiredLogs(db, far-future-iso)` 执行
- **THEN** 返回 0，行数不变

### Requirement: logMode 配置优先级与旧字段兼容
有效值优先级：`LUCENT_LOG_MODE`（三态白名单） > `LUCENT_LOG_RECORDING`（兼容布尔，`true`→`archive` / `false`→`off`，无法表达 temporary） > `config.logMode` > `config.logRecording`（同兼容映射） > 默认 `archive`。非法 env 值回退下一级、不抛错（防拼错让进程起不来）。`loadConfig` 读旧 config.json（只有 `logRecording` 没 `logMode`）时 MUST 映射 `true`→`archive` / `false`→`off` 并丢弃旧字段；`saveConfig` MUST 只写 `logMode`（旧字段自然消亡，不丢用户磁盘配置）。

**Rationale:** 新部署用三态 env，老部署/老 config.json 用兼容字段平滑过渡，无破坏性迁移。

#### Scenario: 旧 config.json logRecording 映射到 logMode
- **GIVEN** config.json 只有 `logRecording: false`（无 `logMode`）
- **WHEN** `loadConfig` 读取
- **THEN** 内存 config 的 `logMode` 为 `'off'`
- **AND** 落盘时 config.json 不再含 `logRecording`，只含 `logMode`

#### Scenario: LUCENT_LOG_MODE 覆盖 config
- **GIVEN** config.json `logMode: 'archive'`
- **WHEN** env `LUCENT_LOG_MODE=temporary` 启动
- **THEN** `getLogMode()` 返回 `'temporary'`
- **AND** `logModeEnvOverridden()` 返回 true（UI 应禁用切换）

### Requirement: 切换模式不得改动已落库日志
`setLogMode` MUST 只改 `config.logMode`（+可选 `tempLogTtlMinutes`）并持久化，MUST NOT 对已落库的日志做任何 `UPDATE`（不改其 `expires_at`）。已写入的临时日志按各自 `expires_at` 继续由清理定时器过期；已写入的存档日志保持 NULL。

**Rationale:** 已落库日志不可变（`insertLog` 用 `INSERT OR IGNORE`，全程无 UPDATE 是既有不变量）。切换模式只影响后续新写入，历史数据自洽。

#### Scenario: 切回 archive 后已有临时数据仍按原 TTL 过期
- **GIVEN** 库内有未到期临时行（`expires_at` = 未来时刻），当前 `logMode='temporary'`
- **WHEN** `setLogMode('archive')` 后等到该 `expires_at` 过去
- **THEN** 该行被清理定时器删除（`expires_at` 未被改成 NULL）
- **AND** 新写入的行 `expires_at` 为 NULL

### Requirement: 存档保留期可配且实时生效
存档保留期（天）SHALL 由运行时 live getter `getRetentionDays()`（[server/config.ts](../../../server/config.ts)）决定：优先级 env `LUCENT_LOG_RETENTION_DAYS` > `config.logRetentionDays` > 默认 `LOG_RETENTION_DAYS`（3）。保留期清理 `cleanupOldLogs`（[server/services/log-writer.ts](../../../server/services/log-writer.ts)）MUST 每次执行时调 `getRetentionDays()` 取有效值，MUST NOT 读 server 启动时 `resolvedConfig` 快照——用户运行时改保留期（顶栏 Popover 保留期 InputNumber）后，下一次清理 MUST 立即用新值。`GET /api/status` MUST 暴露 `retentionDays`（有效值）；`POST /api/retention { days }` SHALL 校验 `days` 为正整数，调 `setRetentionDays` 持久化到 config.json，返回 `{ success, retentionDays, envLocked }`。env 锁定时 config 仍写入（保留意图），但返回的有效值由 env 决定、`envLocked=true`。

**Rationale:** 保留期原写死仅 env 可改，UI 无法调；现顶栏 Popover 暴露 InputNumber，运行时可改。`cleanupOldLogs` 若读启动快照则改完保留期不即时生效（要重启），与 `getLogMode()` / `getTempTtlMinutes()` 的实时语义一致化——三个热路径 getter 统一不缓存。`setRetentionDays` 镜像 `setLogMode` 的 env 锁定语义。

#### Scenario: 运行时改保留期后下次清理用新值
- **GIVEN** 启动时保留期 3 天，`cleanupOldLogs` 曾用 3 天 cutoff 清理
- **WHEN** 运行时 `POST /api/retention { days: 1 }` 后触发下一次 `cleanupOldLogs`
- **THEN** cutoff 为 `now - 1 天`（用新值），早于 1 天的行被删
- **AND** MUST NOT 仍用启动时的 3 天快照

#### Scenario: env 锁定保留期时 config 写入但有效值由 env 决定
- **GIVEN** env `LUCENT_LOG_RETENTION_DAYS=7` 已设置
- **WHEN** `POST /api/retention { days: 1 }`
- **THEN** 响应 `{ success: true, retentionDays: 7, envLocked: true }`
- **AND** `config.logRetentionDays=1` 已落盘（保留意图），但 `getRetentionDays()` 仍返回 7

### Requirement: 前端不得堆积过期或超量临时条目
`useLogs` MUST 对 `logs` state 设软上限（`LOGS_SOFT_CAP = 500`）：`loadMore` / `addLog` 追加后若超限裁剪到最前（最新）N 条。导出给视图的列表 MUST 过滤掉 `expiresAt` 已过期（`Date.parse(expiresAt) <= Date.now()`）的条目，且每 60s 重新评估一次（避免过期项变幽灵）。配合服务端 `loadLogs` 已删不再下发，三层兜底保证浏览器无幽灵条目。

**Rationale:** 临时模式高频产生短命数据，前端若只增不减会堆积内存 + 显示已过期（点进去 404）的幽灵条目。

#### Scenario: state 超软上限裁剪最旧
- **GIVEN** `logs` state 已有 500 条
- **WHEN** `loadMore` 追加一页 50 条
- **THEN** state 裁剪到 500 条（丢最旧的，保留最新）

#### Scenario: 已过期条目渲染时过滤
- **GIVEN** `logs` state 含一条 `expiresAt` 已过期的条目
- **WHEN** 视图渲染（或 60s tick 触发）
- **THEN** 该条目不渲染（从可见列表移除）

### Requirement: /api/status 与 /api/recording 三态契约
`GET /api/status`（[server/routes/status.ts](../../../server/routes/status.ts)）MUST 暴露 `logMode`（有效值）、`logModeEnvLocked`（env 是否锁定）、`tempLogTtlMinutes`（有效 TTL）、`retentionDays`（有效保留期天数）。`POST /api/recording` body 接收 `{ logMode: 'off'|'temporary'|'archive', tempTtlMinutes?: number }`，校验 logMode 白名单 + tempTtlMinutes（若给）为正整数，调 `setLogMode` 持久化，返回 `{ success, logMode, envLocked }`。`POST /api/retention { days }` 校验 `days` 为正整数，调 `setRetentionDays` 持久化，返回 `{ success, retentionDays, envLocked }`（详见「存档保留期可配」Requirement）。env 锁定时 config 仍写入（保留意图），但返回的有效值由 env 决定、`envLocked=true`。

**Rationale:** 顶栏 Popover 的 Radio 三态 + 存活时长 / 保留期 InputNumber 需要读 status 渲染、写 recording / retention 切换。env 锁定语义让 UI 禁用切换并提示，避免用户以为开关坏了。

#### Scenario: status 暴露三态有效值与保留期
- **WHEN** `GET /api/status`（无 env 锁定）
- **THEN** 响应含 `logMode`（off/temporary/archive 之一）、`logModeEnvLocked: false`、`tempLogTtlMinutes`（非负整数）、`retentionDays`（正整数）

#### Scenario: recording 切换并持久化
- **WHEN** `POST /api/recording { logMode: 'temporary', tempTtlMinutes: 10 }`
- **THEN** 响应 `{ success: true, logMode: 'temporary', envLocked: false }`
- **AND** 后续 `getLogMode()` 返回 `'temporary'`、`getTempTtlMinutes()` 返回 10

#### Scenario: 非法 logMode 被拒
- **WHEN** `POST /api/recording { logMode: 'bogus' }`
- **THEN** 响应 400，config 不变

