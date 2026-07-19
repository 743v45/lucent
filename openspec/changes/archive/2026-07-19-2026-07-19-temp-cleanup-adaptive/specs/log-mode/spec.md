# log-mode Specification Delta

## MODIFIED Requirements

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
