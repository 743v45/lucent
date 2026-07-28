## Why

配置（`~/.lucent/config.json` 文件）与日志（`lucent.db` SQLite）是两套存储，备份/恢复要分别处理。
用户要求**配置也进数据库**，并支持 **SQL 导入导出**——让配置与日志同库，一个 SQL 文件即可整体
备份/迁移/恢复配置；同时用 SQLite 事务（天然原子）替代 JSON 文件的 tmp+rename 原子写，消除那层复杂度。

lead 已拍板：**直接改、不保留 config.json 兼容**（迁移后 DB 为唯一源），SQL 导入导出做到
**REST API + Web UI**（不做 CLI）。

## What Changes

### 存储（核心：[`server/config.ts`](../../server/config.ts)）

- 配置写入现有 `lucent.db` 的 `config` 表（与日志同库），**单行 JSON blob**：
  ```sql
  CREATE TABLE IF NOT EXISTS config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    data TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  ```
  config.ts 全程按 JSON 对象模型工作（validate/clone/CRUD），blob 行直接装现有 JSON，改动最小、迁移最简。
- `loadConfig` → 读 `config` 表（表空→初始化默认 / 迁移文件）；`saveConfig` → `BEGIN…INSERT OR REPLACE…COMMIT`
  事务写（替代文件 tmp+rename）。上层所有 CRUD/getter 签名不变。
- **鸡生蛋**：`ProxyConfig.dbPath` 字段废弃。DB 路径固定为 `LUCENT_DB_PATH || CONFIG_DIR/lucent.db`，
  不再由 config 指定（否则自指）。`resolveEffectiveConfig` 的 dbPath 改为 `env || 默认`。
- DB 连接：config 加载阶段即 `initDb`（固定路径），与日志共用 `db-instance` 单例（库只开一次）。

### 迁移（一次性：[`server/config.ts`](../../server/config.ts) + [`server/services/db.ts`](../../server/services/db.ts)）

- 首次 load：`config` 表空 且 `config.json` 存在 → 校验后导入表（留 `.bak`），之后忽略文件。
- 表空 且 无 `config.json` → 写默认配置到表（含 anthropic 种子）。
- 表已有行 → 不再读文件（幂等，防覆盖用户运行时改动）。
- 导入的 JSON 非法 → 备份坏文件 + 写默认（沿用现有损坏处理语义）。

### SQL 导入导出（新增 [`server/routes/config.ts`](../../server/routes/config.ts) + types/api + UI）

- `GET /api/config/export` → 返回可移植 SQL 脚本（`CREATE TABLE…; INSERT OR REPLACE…`），`Content-Type` 适合 `.sql` 下载。
- `POST /api/config/import` → 接收 SQL 或 JSON，`validateConfig` 校验，**事务替换** `config` 行；校验失败 400 且不改库；成功后立即生效（`getConfig` 返回新值）。
- Web UI 设置页加「导出配置」「导入配置」按钮（下载 / 上传 `.sql`）。

### 测试 / 脚本适配

- [`tests/e2e-helpers.ts`](../../tests/e2e-helpers.ts)：`writeTestConfig`/`readConfig` 改为 DB 读写（开
  `configDir/lucent.db` 写 `config` 表），让 ~30 个 e2e 经由它继续工作（爆炸半径收敛于此）。
- [`tests/config-atomic-write.test.ts`](../../tests/config-atomic-write.test.ts) → 重写为**事务原子性**测试（事务失败回滚不污染 `cachedConfig`）。
- [`tests/config-reload-e2e.test.ts`](../../tests/config-reload-e2e.test.ts) 内联 `readConfig` → 改 DB 读。
- 审查直接写 `config.json` 的脚本（[`scripts/setup-openai-provider.ts`](../../scripts/setup-openai-provider.ts) 走 config 模块 API，无需改；其它直接写文件的逐一改）。

## Capabilities

### New Capabilities
- **config-store**：新增「配置以 SQLite 持久化 + SQL 导入导出」契约（见 `specs/config-store/spec.md`）。

### Modified Capabilities
无（config 此前无独立 spec capability）。

## Impact

- **受影响代码**：
  - [`server/config.ts`](../../server/config.ts)：`load/save/init` 改 DB + 一次性迁移 + 废弃 `dbPath` 字段。
  - [`server/services/db.ts`](../../server/services/db.ts) / [`db-instance.ts`](../../server/services/db-instance.ts)：`config` 表 schema + 共享连接 + 导入导出 helper。
  - [`server/routes/`](../../server/routes)：新增 config router（export/import 端点）。
  - [`src/types.ts`](../../src/types.ts) / [`src/utils/api.ts`](../../src/utils/api.ts) + 设置页组件：导入导出 API + UI 按钮。
  - [`tests/e2e-helpers.ts`](../../tests/e2e-helpers.ts) + 2 个配置专项测试 + 直接写 `config.json` 的脚本。
- **不改**：转发路径（`proxy.ts`）、URL 组合、body 重写引擎、日志 schema/写入、保留期清理、KV-Cache/agent 分类。
- **新增风险**：
  - **鸡生蛋**：DB 路径须先于 config 确定——已用「固定 env/默认路径」解决，`dbPath` 不再进 config。
  - **迁移幂等**：`config` 表已有行则不再导入文件，防覆盖用户运行时改动。
  - **导入即覆盖**：必须事务 + `validateConfig` 校验，失败回滚不改库（防坏配置写崩实例）。
  - **测试耦合**：`e2e-helpers.writeTestConfig` 直写文件的现状要求把它改 DB 化才能让 ~30 个 e2e 不散改。
