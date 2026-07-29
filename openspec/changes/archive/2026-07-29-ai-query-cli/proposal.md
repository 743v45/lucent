## Why

Lucent 把拦截到的 API 调用存进 SQLite（`~/.lucent/lucent.db`），但现有 CLI（`bin/cli.ts`）只有一个面向人类的 `lucent logs`：**依赖服务器在跑**（走 HTTP `/api/logs`）、**输出是人类简表**、**只有 `--limit`**。AI 编程助手（Claude Code / Cursor 等）想要分析用户被拦截的调用（算成本、找失败、看某次请求/响应、搜历史），没有可用的结构化查询入口。

需要一个新的 `lucent query` 命令：**给 AI 当 shell 工具用**——执行命令、读 JSON、不依赖服务器在跑、只读、复用既有查询逻辑。

## What Changes

### 数据访问（直读 SQLite + 复用 server DAO）

- 新增 [`bin/query.ts`](../../../bin/query.ts)：CLI 查询纯函数层。import [`server/services/db.ts`](../../../server/services/db.ts) 已有的纯查询函数（`listLogs` / `searchLogs` / `getLogById` / `fetchBodies` / `encodeCursor` / `decodeCursor`），不复用走单例的 `log-reader.ts`。
- 新增 `openDbReadonly(path)`（[`server/services/db.ts`](../../../server/services/db.ts)）：`new Database(path, { readonly: true })`，不建表/不迁移/不挂单例，CLI 查完即 `close()`。WAL 模式下只读并发安全，服务器没跑也能查。
- DB 路径解析复刻服务器口径：`process.env.LUCENT_DB_PATH || CONFIG_DIR/lucent.db`（`CONFIG_DIR = LUCENT_CONFIG_DIR || ~/.lucent`），与 [`config-store` spec](../../specs/config-store/spec.md) Requirement「DB 路径由 env/默认决定」一致。

### 命令（[`bin/cli.ts`](../../../bin/cli.ts) 装配 commander，逻辑在 `bin/query.ts`）

- `lucent query logs`：列请求。过滤 `--provider/--model/--agent-type/--endpoint/--status/--thread-id/--is-test/--since/--until`；`--limit`（默认 20）、`--cursor`（keyset 游标）、`--fields`。输出 `{ items, cursor, count, total, has_more }`。
- `lucent query log <id>`：单条详情，含 `body.{request,response}`。`--no-body` / `--max-body`（默认 50000，超出截断 + `body_truncated:true`）/ `--full-body`。
- `lucent query search <keyword>`：复用 `searchLogs`（FTS5 trigram，≥3 字符走倒排）。过滤/分页同 `logs`，输出结构同 `logs`。
- `lucent query stats`：聚合 `--by provider|model|agent-type|endpoint|status|day|hour`（默认 model），输出 `{ dimension, buckets[], totals }`，每桶含 count / 各 token / total_duration_ms。
- 默认输出 JSON 到 stdout；`--human` 切人类可读表。`--db <path>` 覆盖库路径。

### `db.ts` 扩展（纯增强，向后兼容）

- `ListFilter` 加可选 `model` / `status` / `isTest`；`applyFilter` 补对应 WHERE。现有 `listLogs`/`searchLogs` 及 Web API 自动获得这三个过滤维度。
- 新增 `getStatsByDimension(db, { dimension, filter? })`：按维度 GROUP BY 聚合 + 全量 totals。
- 新增 `openDbReadonly(dbPath)`。

### bin 入口修复（附带改进）

- 新增 [`bin/cli.js`](../../../bin/cli.js) thin wrapper：`node --import tsx cli.ts` 运行，让 `package.json` 声明的 `lucent` 命令真正可执行（现状 bin 指 `cli.js` 但磁盘是 `cli.ts`，跑不起来）。
- [`bin/cli.ts`](../../../bin/cli.ts) `start` 子命令的 spawn 从不存在的 `server/index.js` 改成 tsx 跑 `server/index.ts`（与 `npm start` 一致）。

### 错误处理 / 退出码

- 0 成功（含无结果）；2 数据库问题（文件不存在/无法打开）；3 参数非法；1 其他。
- JSON 模式：错误 `{"error":"<code>","message":"…"}` 到 stderr + 非零码。

## Capabilities

### New Capabilities
- **ai-query-cli**：新增「只读结构化查询 CLI（给 AI 用，直读 SQLite）」契约（见 `specs/ai-query-cli/spec.md`）。

### Modified Capabilities
无。

## Impact

- **受影响代码**：
  - [`server/services/db.ts`](../../../server/services/db.ts)：`ListFilter` / `applyFilter` 扩展 + `openDbReadonly` + `getStatsByDimension`（新增导出，不改现有签名/行为）。
  - [`bin/cli.ts`](../../../bin/cli.ts)：新增 `query` 命令树；修 `start` 的 spawn。
  - [`bin/query.ts`](../../../bin/query.ts)（新）、[`bin/cli.js`](../../../bin/cli.js)（新）。
  - [`tests/query-cli.test.ts`](../../../tests/query-cli.test.ts)（新）。
- **不改**：转发路径（`proxy.ts`）、日志写入、保留期清理、Web API 路由契约（`/api/logs` 行为不变，只是底层 `listLogs` 多支持三个可选过滤）、`config` 存储。
- **新增风险**：
  - **只读保证**：`query` 必须只 SELECT。靠「只用只读连接 + 只调纯查询函数」双层保证；测试覆盖「不调用任何写函数」。
  - **body 体积**：详情默认截断 50KB，防一条超大 body 撑爆 AI 上下文；`--full-body` 取全文。
  - **db 路径**：必须与服务器同库——复刻 `LUCENT_DB_PATH || CONFIG_DIR/lucent.db`，测试覆盖路径解析。
