# 临时日志清理定时器自适应启停 + 间隔放宽至 3 分钟

## Why

临时日志清理定时器当前在 [`server/index.ts`](../../server/index.ts) **常驻运行**——不管 `logMode` 是
`off` / `archive` / `temporary`，每 `TEMP_LOG_CLEANUP_INTERVAL_MS`（60s）都扫一次
`DELETE FROM logs WHERE expires_at IS NOT NULL AND expires_at < now`。但只有 `temporary` 模式才产生带
`expires_at` 的临时行；`off` / `archive` 模式下没有增量，定时器纯空转——这就是日志里反复出现
`lucent:db 临时日志清理: 删除 0 行` 的根源。

用户诉求：临时模式关闭后，存量临时行清完即停，直到再次开启临时模式。顺手把间隔从 1 分钟放宽到 3 分钟
（临时 TTL 默认 30 分钟，3 分钟清理粒度足够，减负）。

## What Changes

### 后端

- **间隔常量（[`server/constants.ts`](../../server/constants.ts)）**：`TEMP_LOG_CLEANUP_INTERVAL_MS`
  默认 `60_000` → `180_000`（3 分钟）。不加 env 覆盖（3 分钟是合理固定值，YAGNI）。

- **调度模块（新建 [`server/services/temp-cleanup-scheduler.ts`](../../server/services/temp-cleanup-scheduler.ts)）**：
  封装 `startTempCleanupTimer()` / `stopTempCleanupTimer()`，幂等。回调内每次 `cleanupExpiredLogs()` 后评估自停：
  `getLogMode() !== 'temporary' && countTemporaryLogs(getDb()) === 0` → `clearInterval` 自停。`startServer`
  把内联 `setInterval` 换成 `startTempCleanupTimer`（含启动清一次），`shutdownServer` 换成 `stopTempCleanupTimer`。

- **count 查询（[`server/services/db.ts`](../../server/services/db.ts)）**：新增 `countTemporaryLogs(db)`
  = `SELECT count(*) FROM logs WHERE expires_at IS NOT NULL`，命中部分索引 `idx_logs_expires`（O(临时行数)）。

- **切回 temporary 重启（[`server/routes/status.ts`](../../server/routes/status.ts)）**：`POST /api/recording`
  在 `setLogMode` 成功后，若新 `logMode === 'temporary'` 调 `startTempCleanupTimer()`（幂等）。

- **解耦**：`server/config.ts` 的 `setLogMode` MUST NOT 直接操作定时器（避免 config → index 循环耦合）；
  调度逻辑封装在独立 scheduler 模块，单向依赖（scheduler → `Config.getLogMode` / `LogWriter` / `db`），
  重启 hook 由路由层在 `setLogMode` 后触发。

### 自停语义（关键正确性）

"存量清完" = **库内无任何临时行**（`countTemporaryLogs === 0`），**不是**「本次删除返回 0 行」。后者有 bug：
关闭 `temporary` 时若残存**未到期**临时行（`expires_at` 在未来），本次扫描删 0 行就停 → 该行永不清理。
用 `count=0` 判定保证定时器等到所有存量临时行过期删完才停。

### 测试

- **修 stale 测试（[`tests/db.test.ts`](../../tests/db.test.ts)）**：删 `:15` import 与 `:316-329` describe 块
  对已删除 `deleteAllTemporaryLogs` 的引用（commit `0ae128c` 漏改，当前 vitest 会 `undefined is not a function`）。
- **新增单测**：`countTemporaryLogs`（过期/未到期/存档混合计数）+ scheduler `startTempCleanupTimer` 幂等
  （重复调用不重复 `setInterval`）+ 自停判定（`temporary` 不停 / `off` 且 count=0 停 / `off` 且 count>0 不停）。

## Capabilities

### Modified Capabilities

- **`log-mode`**：临时清理定时器从「每 60s 常驻」改为「按 `logMode` 自适应启停」——`temporary` 常驻、
  `off`/`archive` 清完成残存存量后自停、切回 `temporary` 重启；默认间隔 `60s → 180s`。修改两个 Requirement：
  定时器核心（重写为自适应启停 + 180s）+ TTL 注入 Requirement 里顺带提及的「默认 60s」措辞。

## Impact

- **受影响代码**：
  - [`server/constants.ts`](../../server/constants.ts)：`TEMP_LOG_CLEANUP_INTERVAL_MS` 默认值。
  - [`server/services/temp-cleanup-scheduler.ts`](../../server/services/temp-cleanup-scheduler.ts)（新建）：
    `startTempCleanupTimer` / `stopTempCleanupTimer` + 自停判定。
  - [`server/services/db.ts`](../../server/services/db.ts)：新增 `countTemporaryLogs`。
  - [`server/index.ts`](../../server/index.ts)：`startServer` / `shutdownServer` 改调 scheduler。
  - [`server/routes/status.ts`](../../server/routes/status.ts)：`POST /api/recording` 切 `temporary` 后重启。
  - [`tests/db.test.ts`](../../tests/db.test.ts)：修 stale 块 + 新增 `countTemporaryLogs` 单测。
  - 新增 `tests/temp-cleanup-scheduler.test.ts`：scheduler 启停/幂等/自停判定。
- **不改**：转发链路（`server/proxy.ts`）、`writeLogEntry` 三态门控、`deleteExpiredLogs` 的 SQL
  （`WHERE expires_at IS NOT NULL AND expires_at < ?` 不变）、24h 保留期清理（`cleanupOldLogs` 不动）。
- **题外既存 bug（不在本次范围，仅记录）**：TTL=0 写入路径断裂——读侧/校验/UI `min` 放行 0，但写侧
  （`setLogMode` / `POST /api/recording` / 前端 onChange）仍按 `< 1` 拒，0 无法落盘。后续单独修。
