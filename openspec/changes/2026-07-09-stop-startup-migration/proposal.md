## Why

每次启动都跑一遍 JSONL→SQLite 迁移（实测 ~20s），且与保留期清理形成**死循环**：

- `initDb` → [`migrateFromJsonl`](../../../server/services/db.ts#L274) 每次全量扫 `logDir` 下所有 `.jsonl`（当前 70 个文件），**无「已迁移」记忆**，旧文件也不归档（[db.ts:281](../../../server/services/db.ts#L281)）。
- 紧跟 [`startServer`](../../../server/index.ts#L74) 里 `await LogWriter.cleanupOldLogs()`，按 3 天保留期 `DELETE` 早于 cutoff 的行（[`deleteOldLogs`](../../../server/services/db.ts#L537)）。
- 结果：旧 JSONL（>3 天）每次被重新 import（`imported≈2908`），又被保留期清理删掉（日志「删除 2908 行」）；下次启动这些旧行已不在 DB，再 import → 再删，**无限循环**。所谓「幂等」仅靠 `id` UNIQUE + `INSERT OR IGNORE`（[db.ts:179](../../../server/services/db.ts#L179)），只有 DB 里还在的（3 天内）行才真正 `skipped`（日志里 `skipped=77`）。

这与 [`db-instance.ts:8`](../../../server/services/db-instance.ts#L8) 的设计注释自相矛盾——注释早写着「旧 JSONL 文件留作历史备份，不再被 live 系统读写」，但 `migrateFromJsonl` 仍在启动时全量重跑。

**第二个问题放大了伤害**：[`startServer().catch`](../../../server/index.ts#L196) 在启动失败（如端口占用 EADDRINUSE）时直接 `process.exit(1)`，**跳过 `shutdownServer()` → `closeDb()` → `wal_checkpoint(TRUNCATE)`**（[`closeDb`](../../../server/services/db-instance.ts#L42)）。而端口占用发生在 `startServer` 末尾——此时迁移 + 清理已跑完、WAL 已堆了一轮写入。每次「端口占用启动失败」都给 WAL 喂一大坨写入却不收缩，导致 `lucent.db-wal` 膨胀到 **1GB**（主库才 557MB）。

附：`errors=2863` 经排查 = 历史 JSONL 里 2863 行 JSON 损坏（跨 70 文件统计 `bad=2863` 精确匹配），已被 [db.ts:322](../../../server/services/db.ts#L322) 的 `catch` 正确跳过，**非代码 bug**，本次不抢救这批脏数据。

## What Changes

### 后端

- **下线启动迁移**（[`server/services/db-instance.ts`](../../../server/services/db-instance.ts)）
  - `initDb(dbPath)` 去掉 `logDir` 参数与 `migrateFromJsonl` 调用，只「开库 + 建表」。
  - 修正过时注释：JSONL 迁移不再在启动时自动执行。
- **保留迁移工具**（[`server/services/db.ts`](../../../server/services/db.ts)）
  - `migrateFromJsonl` 函数体**保留不动**——它是合法的一次性迁移工具，将来换库/手动迁移仍可用，只是不再被启动自动调用。补一行注释指明「已不在启动时自动调用」。
- **调用方同步**（[`server/services/log-writer.ts`](../../../server/services/log-writer.ts)）
  - `init` 里 `initDb(resolvedCfg.dbPath)` 去掉 `logDir` 实参，删掉迁移结果 `dbg`。
- **修启动失败路径 shutdown**（[`server/index.ts`](../../../server/index.ts)）
  - `startServer().catch` 改为 `async`，先 `await shutdownServer()`（`drainWriteQueue` + `closeDb` + `wal_checkpoint`）再 `process.exit(1)`。
  - 已确认 `shutdownServer` 在**部分初始化态**（`proxyServer=null`、interceptor 未 setup、web server 未 listen）安全：[`drainPendingSSETasks`](../../../server/interceptor.ts#L42) 空集即返回、`drainWriteQueue` 初始即 resolve、`closeDb` 仅在 db 已开时 checkpoint、`clearInterval(null)` 与 `server.close()` 未 listen 均无害。

### WAL 收缩

**不写脚本**。修好 shutdown 后，正常启动一次 + `Ctrl+C` 优雅退出，`closeDb` 的 `wal_checkpoint(TRUNCATE)` 自然把现有 1GB WAL 收回。现有 `lucent.db` **保留不动**（用户确认不丢近 3 天有效日志）。

### 测试

- [`tests/db.test.ts`](../../../tests/db.test.ts) 新增 `initDb 不再自动迁移` 用例：有效 `logDir` 含 JSONL 时，`initDb` 后 `logs` 表仍为空（回归保护，防止有人把迁移调用加回来）。
- `migrateFromJsonl` 现有幂等测试（[db.test.ts:157](../../../tests/db.test.ts#L157)）保留——函数仍在。
- shutdown 修复涉及模块级状态 + `process.exit`，靠代码审查 + 手动验证（端口占用启动失败 → 进程退出且不再喂 WAL；正常启动 → 优雅退出 → WAL 收缩），不单测。

## Capabilities

### Modified Capabilities

- **logging / 启动初始化**：`initDb` 契约由「开库 + 建表 + 一次性迁移现有 JSONL」变为「开库 + 建表」。JSONL 不再参与启动流程；`logs/*.jsonl` 回归为纯历史备份（与既有注释一致）。
- **进程生命周期**：启动失败（含端口占用）也走 `shutdownServer`，保证 WAL checkpoint 落盘、不留膨胀隐患。

## Impact

- **受影响代码**：[`db-instance.ts`](../../../server/services/db-instance.ts)、[`log-writer.ts`](../../../server/services/log-writer.ts)、[`index.ts`](../../../server/index.ts)、[`tests/db.test.ts`](../../../tests/db.test.ts)。
- **不改**：`migrateFromJsonl` 函数体、SQLite schema、保留期清理逻辑、转发链路、记录开关（`log-recording-toggle`）。
- **新增风险**：
  - 历史日志不再自动入新库——若日后期望「换新库后旧 JSONL 自动导入」，需手动调 `migrateFromJsonl`。当前用户旧库保留，不受影响。
  - 启动失败路径多走一次 `shutdownServer`：`drainWriteQueue` 有 5s 超时上限，但空队列立即返回，正常无感。
