# 日志存储设计

Lucent 的日志存储经历了从 **JSONL 文件** 到 **SQLite + FTS5** 的迁移。本文记录两套设计与迁移决策，供留档与后续维护参考。

---

## 现行设计：SQLite + FTS5（检索第二步起）

落地一个 SQLite 文件（默认 `~/.lucent/lucent.db`，env `LUCENT_DB_PATH` 可覆盖），WAL 模式，三张表：

| 表 | 内容 | 用途 |
|---|---|---|
| `logs` | 可索引小字段（id、timestamp、agent_type、provider_name、endpoint_type、model、status、thread_id、duration、tokenUsage 拆列、error、expires_at…） | 列表 / 排序 / 过滤 / 分页，按 timestamp DESC, id DESC 建索引；`expires_at`：NULL=存档（不过期，归保留期清理），ISO 时间戳=临时日志到期（logMode=temporary 写入，独立每分钟清理） |
| `log_bodies` | 大内容（request/response 原文 JSON + search_text） | 仅详情视图与检索时读取，列表查询不碰 |
| `logs_fts` | FTS5 虚拟表，trigram 分词，索引 search_text | 全文检索（中英文通吃、子串语义） |

写入：拦截器拿到完整响应后，经异步写入队列串行化，调 `insertLog`（事务原子，三表一致）落库——不再 append 文件、不再轮转。

读取：`listLogs` / `searchLogs` 走索引 + keyset 游标分页（`timestamp` 游标，`id` 作稳定 tiebreaker），详情走主键直查。`search` 非空时命中 `logs_fts` 倒排（≥3 字符走 trigram，<3 字符回退 LIKE）。

保留期（决策④）：默认 **3 天**，env `LUCENT_LOG_RETENTION_DAYS` 可调。清理 = `DELETE` 旧行（级联 log_bodies + 手动删 FTS）+ `VACUUM` 回收空间。启动时清一次，之后每 24h 定时清一次（长驻进程兜底）。

临时日志 TTL（与保留期清理并存，两者独立）：`logMode=temporary` 时写入的行带 `expires_at`，由独立定时器每 1 分钟扫一次 `DELETE`（`WHERE expires_at IS NOT NULL AND expires_at < now`，只 DELETE **不 VACUUM**，避免每分钟全库写锁卡代理）；存档行 `expires_at IS NULL` 不受影响。空间回收靠这里的 24h 保留期 VACUUM + WAL 增量页复用兜底。

导出：仍支持 **JSONL / Markdown** 两种格式（导出产物，不是 live 存储）。

---

## 旧设计：JSONL 文件（已退役，仅留档）

迁移前，每条拦截记录写成一行 JSON，落 `logs/lucent_<日期>_<时间>.jsonl`：

- **写入**：`appendFile`，每条一次 syscall。
- **轮转**：单文件超 `MAX_LOG_FILE_SIZE`（100MB）按大小 rename 归档；保留上限 `MAX_LOG_FILES`（50 个文件）+ `LOG_RETENTION_DAYS`（30 天）。
- **读取**：`readLogs` 每次最多读 `MAX_LOG_FILES_TO_READ`（20）个文件、全量解析进内存 → 全量排序 → 全量去重 → 全量过滤 → 再分页；`fileCache` 把解析结果常驻。取详情线性扫文件直到命中。
- **检索**：`search` 参数只对 url / model / error / providerName 四个小字段做 `toLowerCase().includes()`——消息正文、system prompt、助手回复、工具调用这些真正会想搜的内容根本没进搜索。

**痛点**：能扫不能搜，且每次查询都全量重做（最坏 20 × 100MB ≈ 2GB 进内存）；正文检索等于没有；`fileCache` 常驻可达数百 MB。`log-manager` 还存在轮转 / 清理两套重复实现（原 TODO 标注的职责重叠）。

---

## 迁移

SQLite 上线即**唯一存储**（无双写过渡期）。首次启动 `migrateFromJsonl` 把现有 JSONL **一次性幂等导入**（`INSERT OR IGNORE` 按 id 跳过已存在），导入期间旧 JSONL 不动，留作历史备份。`normalizeLogEntry` 保留，供这次迁移与导出/导入路径归一化用。

退役清单（检索第四步收尾）：`appendFile` / 按大小轮转 / `fileCache` / `readFileEntries` / `MAX_LOG_FILE_SIZE` / `MAX_LOG_FILES` / `MAX_LOG_FILES_TO_READ` 及对应 config 字段（`maxLogFileSize` / `maxLogFiles`）已全部移除；`log-manager` 的重复实现已收敛到 services。

---

## 配置

| env | 默认 | 说明 |
|---|---|---|
| `LUCENT_DB_PATH` | `~/.lucent/lucent.db` | SQLite 库路径 |
| `LUCENT_LOG_RETENTION_DAYS` | `3` | 保留期天数，清理早于此的行 |
| `LUCENT_LOG_MODE` | `archive` | 日志模式三态：`off`（只过路不记）/ `temporary`（临时落库带 TTL）/ `archive`（存档，按保留期清理）；兼容旧 `LUCENT_LOG_RECORDING`（true→archive / false→off） |
| `LUCENT_TEMP_LOG_TTL_MINUTES` | `30` | 临时模式 TTL（分钟），仅 logMode=temporary 时写入的日志带此到期时间 |

> 历史的 `LUCENT_MAX_LOG_FILE_SIZE` / `LUCENT_MAX_LOG_FILES` 随轮转退役，不再生效。
