# 临时日志模式（三态开关 + TTL 自动清理）设计

> 创建日期：2026-07-19
> 状态：实现中
> 关联：[openspec/changes/2026-07-19-temp-log-mode](../../../openspec/changes/2026-07-19-temp-log-mode)

## 1. 背景与目标

Lucent 现有日志开关是二态 `logRecording: boolean`（[server/config.ts](../../../server/config.ts)）：on=全量落库 / off=只过路。调试转发链路、压测、临时排查一个问题时，要的「短时记一阵、自动清掉、不污染存档」没有出口——要么 archive 记一堆垃圾等保留期，要么 off 啥也抓不着。

**目标**：把二态升成三态 `logMode: 'off' | 'temporary' | 'archive'`：

- **off**：只过路不落库（同旧 false）。
- **temporary**：临时落库，每条带 `expires_at`（默认 30 分钟 TTL，可配短到几分钟），到期由独立定时器（每 1 分钟）自动删。
- **archive**：存档落库，按全局保留期清理（同旧 true）。

临时与存档数据同住一张 SQLite `logs` 表，用 `expires_at` 区分（NULL=存档，ISO 时间戳=临时到期）。**切换模式不动已有数据**——已写的临时日志按各自 TTL 继续过期。

**核心约束**：清理彻底（不吃内存）、前端不堆积（无幽灵条目）。

**非目标（YAGNI）**：

- 不做临时/存档分表（同表 + 一列区分够用，分表徒增复杂）。
- 不做按 provider / endpoint / agent 粒度的 TTL（全局一个 TTL 够）。
- 不做 TTL 实时精确到期（每分钟扫一次的滞后可接受）。
- 不做临时清理的 VACUUM（每分钟全库锁不可接受，见 §6）。
- 不保留 API / 前端的旧字段别名（单人项目，一刀切）。

## 2. 现状分析

| 事实 | 现状 | 位置 |
|---|---|---|
| 日志开关 | 二态 `logRecording: boolean`（缺省 true） | [server/config.ts](../../../server/config.ts) `ProxyConfig.logRecording` |
| env 覆盖 | `LUCENT_LOG_RECORDING`（布尔，true→记 / false→只过路） | [server/config.ts](../../../server/config.ts) `resolveLogModeFromEnv` 前身 |
| 写入门控 | `writeLogEntry` 顶部 `if (!isLogRecording()) return` 咽喉点 | [server/services/log-writer.ts](../../../server/services/log-writer.ts) |
| 保留期清理 | 默认 3 天，每 24h `DELETE` 旧行 + `VACUUM`，启动清一次 | [server/services/log-writer.ts](../../../server/services/log-writer.ts) `cleanupOldLogs` + [server/index.ts](../../../server/index.ts) `retentionTimer` |
| logs 表 | 无 TTL 列；按 timestamp 索引/排序 | [server/services/db.ts](../../../server/services/db.ts) `SCHEMA` |
| 状态接口 | `GET /api/status` 暴露 `logRecording`/`logRecordingEnvLocked`；`POST /api/recording {recording}` | [server/routes/status.ts](../../../server/routes/status.ts) |
| 前端开关 | 顶栏单 `EyeSlashIcon` 二态 toggle | [src/App.tsx](../../../src/App.tsx) |
| 真相常量 | `LOG_RETENTION_DAYS = 3`（文档曾误写 30 天，本次一并修） | [server/constants.ts](../../../server/constants.ts) |

## 3. 关键决策

| 决策 | 选择 | 理由 |
|---|---|---|
| expiresAt 注入点 | `writeLogEntry` 咽喉点（非 buildRequestEntry） | TTL 是写入决策，和 mode 门控同处一处；不散到构造期 |
| 临时清理 VACUUM | 不 VACUUM，只 DELETE | VACUUM 全库写锁，每分钟跑会卡代理；空间回收靠 24h 保留期清理 + WAL 增量页复用 |
| env 策略 | 新增 `LUCENT_LOG_MODE` + 保留 `LUCENT_LOG_RECORDING` 兼容（true→archive / false→off） | 三态主入口 + 不破老部署 |
| config.json 兼容 | 读时映射 `logRecording→logMode`，写时只 `logMode` | 不丢用户磁盘配置，旧字段自然消亡 |
| API / 前端旧字段 | 一刀切 `logMode`，不保留别名 | 单人项目无外部消费者 |
| 删除安全 | `WHERE expires_at IS NOT NULL AND expires_at < ?` | 存档数据（NULL）绝不误删 |
| 前端不堆积 | 软上限 500 + 渲染时过滤已过期 + loadLogs 服务端已删 | 无幽灵条目 |
| 去「立即清空临时」🗑 | 删 `DELETE /api/logs/temporary` / `purgeTemporaryLogs` / `deleteAllTemporaryLogs` / `api.clearTemporaryLogs`（无消费者），UI 去 🗑 按钮；用 **TTL=0（立即过期）** 表达「记完即清」 | 手动清空无人用；TTL=0 复用既有每分钟清理定时器，少一条 API + 少一个按钮，UI 更简洁 |
| TTL 允许 0 | `getTempTtlMinutes()` / `validateConfig` 按 `>= 0`（0=立即过期，`expires_at ≈ now`） | 配合上一条取代手动清空；写入即被清理定时器删 |
| 保留期 UI 可配 | 顶栏 Popover 保留期 `InputNumber` + `getRetentionDays()` 实时 getter（env > config > 默认 3）+ `POST /api/retention`；`cleanupOldLogs` 改用 getter | 保留期原仅 env 可改；改用实时 getter 顺带修了读启动快照 `resolvedConfig` 导致运行时改保留期不即时生效的 bug，与 `getLogMode()` / `getTempTtlMinutes()` 语义一致 |

## 4. 数据模型

`logs` 表加一列（[server/services/db.ts](../../../server/services/db.ts) `SCHEMA` + `openDb` 迁移）：

```sql
ALTER TABLE logs ADD COLUMN expires_at TEXT;
CREATE INDEX idx_logs_expires ON logs(expires_at) WHERE expires_at IS NOT NULL;
```

- **`expires_at TEXT`**：NULL = 存档（不过期，归保留期清理管）；ISO 8601 时间戳 = 临时到期时刻。
- **部分索引** `WHERE expires_at IS NOT NULL`：只索引临时行——存档行不进索引，临时清理扫描只扫临时行，O(临时行数)。
- **老库幂等迁移**：`openDb` 用 `pragma table_info(logs)` 探测，无 `expires_at` 则 `ALTER` + 补索引（`CREATE TABLE IF NOT EXISTS` 对已存在的旧表不会加列，故 ALTER 补；探测避免重跑报错）。
- 写入侧：`toLogParams` 把 `entry.expiresAt ?? null` 映射到 `@expires_at`；`RawLogEntry.expiresAt?: string`（[server/types.ts](../../../server/types.ts)）由 log-writer 在 temporary 模式注入。

log_bodies / logs_fts 不动（级联删除照旧由 `ON DELETE CASCADE` + 手动删 FTS 覆盖）。

## 5. 写入门控

`writeLogEntry` 单一咽喉点（[server/services/log-writer.ts](../../../server/services/log-writer.ts)），三态分支：

```
getLogMode() === 'off'        → 短路 return（只过路，转发链路零影响）
getLogMode() === 'temporary'  → entry.expiresAt = nowISO + tempLogTtlMinutes；落库
getLogMode() === 'archive'    → entry.expiresAt 不设（undefined → NULL）；落库
```

- **expiresAt 注入在咽喉点**（非 buildRequestEntry）：TTL 是「这条要不要短期存活」的写入决策，与 mode 门控同处，单源、易审。
- 门控用 live getter `getLogMode()`（每次实时解析 env ?? config），反映顶栏切换；`off` 仍盖住 interceptor 全部 5 个调用点 + 未来新增。

## 6. 清理设计

两条独立清理路径，互不重叠：

| 路径 | 触发 | 范围 | 动作 | 位置 |
|---|---|---|---|---|
| 临时清理 | 每 `TEMP_LOG_CLEANUP_INTERVAL_MS`（60s）+ 启动一次 | `expires_at IS NOT NULL AND expires_at < now` | 只 `DELETE`（级联 bodies + FTS），**不 VACUUM** | `cleanupExpiredLogs` + `tempCleanupTimer` |
| 保留期清理 | 每 24h + 启动一次 | `timestamp < now - LOG_RETENTION_DAYS` | `DELETE` + `VACUUM` | `cleanupOldLogs` + `retentionTimer` |

- **为什么不 VACUUM**：VACUUM 持全库写锁、重写整个库文件；每分钟跑会卡住代理转发热路径。临时清理只 DELETE——SQLite 标记页空闲，后续写入复用，靠 WAL 增量页复用 + 24h 保留期清理的 VACUUM 兜底回收空间。代价是临时删除后磁盘空间不立即收缩（可接受，本地工具）。
- **`tempCleanupTimer` 镜像 `retentionTimer`**（[server/index.ts](../../../server/index.ts)）：`setInterval(cleanupExpiredLogs, TEMP_LOG_CLEANUP_INTERVAL_MS)`，启动先清一次（不等首 tick），`unref()` 不阻止退出，`shutdownServer` 里 `clearInterval`。
- **删除安全**：临时清理 WHERE 带 `expires_at IS NOT NULL`，存档行（NULL）零风险被误删；保留期清理按 timestamp，早于 3 天的临时行本也该没。两条 WHERE 不交集。
- **invalidateReaderCache**：临时删除后清 log-reader 的 id→提取缓存（与 `cleanupOldLogs` 同处理，避免残留只占内存）。

## 7. 前端不堆积策略

三层兜底，保证列表无幽灵条目、不无限涨：

1. **服务端已删**：`loadLogs` 走 SQLite，到期临时行已被 `tempCleanupTimer` 删，根本不会下发。
2. **渲染过滤**：[src/hooks/useLogs.ts](../../../src/hooks/useLogs.ts) 渲染前丢掉 `expires_at < now` 的条目——即便删除滞后最多 60s，前端也不显示已过期项。
3. **软上限 500**：`useLogs` 列表最多保留 500 条，超出按时间序丢旧的，防长跑堆积吃内存。

顶栏（[src/App.tsx](../../../src/App.tsx)）：一个 `[当前态 ▾]` 单按钮（按当前态显示 过路 / 临时 / 存档 + 对应图标），点开 antd `Popover`，内含纵向 `Radio` 三态（过路 / 临时 / 存档，「只过路」改名「过路」）选模式 + 每行右侧带配置——**临时行右：存活时长 `InputNumber`（分钟，`min=0`，0=立即过期，0–1440）；存档行右：保留期 `InputNumber`（天，1–3650）**。两时长常驻可改、无需选中对应模式；标签列 `w-16` 右对齐 + `InputNumber` `w-[78px]` 对齐。**切模式即时提交**（`POST /api/recording`）；**改时长仅本地 state，关闭 Popover 时比较打开时的初始值、有变化才统一提交**（存活时长→`/api/recording` 带 `tempTtlMinutes`；保留期→`POST /api/retention`）并弹 toast（`存活时长已保存为 N 分` / `保留期已保存为 N 天`；TTL=0 时提示「立即过期」）。已去掉原「立即清空临时」🗑 按钮——要「记完即清」改设存活时长=0。`logModeEnvLocked=true` 时 Radio + InputNumber 禁用 + 提示被环境变量锁定。`LogListPanel`（[src/components/dashboard/LogListPanel.tsx](../../../src/components/dashboard/LogListPanel.tsx)）给临时条目加视觉标记（时钟角标 / dim）区分存档。

## 8. 验收标准

| # | 验收项 | 验证方式 |
|---|---|---|
| 8.1 | `logMode` 三态（off/temporary/archive）在 config / env / 默认三处解析正确，优先级 LUCENT_LOG_MODE > LUCENT_LOG_RECORDING > config > 默认 archive | [tests/](../../../tests/) config 单测 + 手设 env 验证 |
| 8.2 | 旧 config.json 只写 `logRecording` 能正常加载（true→archive / false→off），写盘后只剩 logMode | 老格式 fixture 走 `loadConfig` |
| 8.3 | `logs.expires_at` 列存在；老库启动 ALTER 幂等（重跑不报错） | 全新库 + 老库各起一次，`pragma table_info` 核对 |
| 8.4 | temporary 模式写入的日志 `expires_at` = 写入时刻 + TTL；archive / off 模式 expires_at 为 NULL / 不写 | 写入后查库 |
| 8.5 | `deleteExpiredLogs` 只删 `expires_at` 已过期行；NULL（存档）与未到期临时行不动；级联清 log_bodies / FTS | [tests/db.test.ts](../../../tests/db.test.ts) `deleteExpiredLogs` 用例 |
| 8.6 | `tempCleanupTimer` 每 60s 跑 + 启动清一次；到期临时行最多滞后 60s 消失 | [scripts/verify-e2e.mjs](../../../scripts/verify-e2e.mjs) 临时场景：设短 TTL → 等清理 → 计数减回 |
| 8.7 | off 模式：发请求转发照旧（上游收到）且 SQLite 无新增行；temporary：+1 带 TTL；archive：+1 无 TTL | verify-e2e.mjs 三态场景（含正向对照） |
| 8.8 | 切换模式不清已有数据：temporary 下写几条 → 切 archive → 旧临时条目仍按各自 TTL 过期、不被立即删 | 手测 / e2e |
| 8.9 | env 锁定（LUCENT_LOG_MODE 设）时 UI Popover 内 Radio + InputNumber 禁用 + 提示被环境变量锁定；POST 仍落盘 config 但有效值不变 | 手设 env 跑 UI |
| 8.10 | 前端列表无幽灵：到期条目渲染时不显示；长跑列表 ≤ 500 条 | useLogs 单测 + 手测 |
| 8.11 | `docs/log-storage-design.md` 的「30 天」改「3 天」、补 expires_at / LUCENT_LOG_MODE / LUCENT_TEMP_LOG_TTL_MINUTES、补临时 vs 保留期清理说明 | 看文档 |
| 8.12 | TTL 允许 0（`getTempTtlMinutes()` / `validateConfig` 按 `>= 0`）；temporary 模式 TTL=0 时写入的 `expires_at ≈ now`，下次清理定时器（≤`TEMP_LOG_CLEANUP_INTERVAL_MS`）删除；UI 存活时长 `InputNumber` `min=0` | 设 env `LUCENT_TEMP_LOG_TTL_MINUTES=0`（或 config `tempLogTtlMinutes: 0`），temporary 发请求后查库 + 等清理 |
| 8.13 | 存档保留期 UI 可配 + 实时生效：顶栏 Popover 保留期 `InputNumber` → `POST /api/retention`；`getRetentionDays()` 实时（env > config > 默认 3）；运行时改保留期后下次 `cleanupOldLogs` 用新值（MUST NOT 读启动快照）；`GET /api/status` 暴露 `retentionDays` | [tests/](../../../tests/) config 单测 + 手测 |
| 8.14 | 去「立即清空临时」：`DELETE /api/logs/temporary` 已删（404），UI 无 🗑 按钮；原 `purgeTemporaryLogs` / `deleteAllTemporaryLogs` / `api.clearTemporaryLogs` 全项目无残留引用 | grep 全项目（`src/` / `server/` / `tests/`）+ 手测接口 |

## 9. 不做的事（YAGNI）

- 不做临时 / 存档分表（同表 + `expires_at` 一列区分）。
- 不做按 provider / endpoint / agent 粒度的 TTL（全局一个）。
- 不做 TTL 实时精确到期（每分钟扫，滞后 ≤60s 可接受；前端渲染过滤兜底）。
- 不做临时清理的 VACUUM（每分钟全库锁不可接受）。
- 不保留 `logRecording` / `recording` 旧字段别名（API + 前端一刀切 logMode）。
- 不做「临时模式写满 N 条自动切 off」之类的自动降级（软上限 + TTL 已够）。
