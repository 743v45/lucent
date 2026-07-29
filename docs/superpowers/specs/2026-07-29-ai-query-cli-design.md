# AI 查询 CLI 设计（lucent query）

> 日期：2026-07-29 · 状态：已与用户确认，转入实现
> OpenSpec change：`openspec/changes/2026-07-29-ai-query-cli/`

## 背景与目标

Lucent 是 AI Agent 代理服务器，把拦截到的 OpenAI/Claude API 调用存进 SQLite（`~/.lucent/lucent.db`）。
现有 CLI（`bin/cli.ts`，基于 commander）只有 `start / stop / status / logs`，其中 `lucent logs` 是唯一的「查数据」入口，但：

1. **依赖服务器在运行**（走 HTTP `/api/logs`，服务器没跑就查不了）；
2. **输出是人类可读简表**，不是结构化数据；
3. **能力弱**（只有 `--limit`，无过滤 / 分页 / 详情 / body / 搜索 / 统计）。

**目标**：新增 `lucent query` 顶层子命令，**给 AI（如 Claude Code / Cursor 等编程助手）当 shell 工具用**——AI 执行命令、读 JSON stdout、据此分析用户的 API 调用。要求：服务器没跑也能查、结构化 JSON、只读、复用既有查询逻辑。

## 数据访问方案

**直读 SQLite + 复用 server 层 DAO**（已确认采用）。

`server/services/db.ts` 的查询函数（`listLogs` / `searchLogs` / `getLogById` / `fetchBodies` / `getStats` / `encodeCursor` / `decodeCursor`）**都是接收 `db` 参数的纯函数，不依赖单例**。CLI 直接 import 它们，配一个一次性**只读**句柄，查完即关。

被否决的备选：走 HTTP API（必须服务器在跑，与「随时查」矛盾）、独立查询层（重复逻辑、易漂移）。

## 命令设计

顶层 `lucent query`，4 个子命令。默认输出 JSON，`--human` 切人类可读表。`--db <path>` 覆盖数据库路径。

### `lucent query logs` — 列请求（过滤 + 游标分页）

```
--provider <name>    --model <name>      --agent-type main|sub
--endpoint <type>    --status <code>     --thread-id <id>   --is-test
--since <time>       --until <time>      # ISO8601 或相对：7d / 24h / 30m
--limit <n>          # 默认 20
--cursor <token>     # 下一页游标
--fields <a,b,c>     # 精简输出字段（逗号分隔）
```

输出（`items` 为 `LogRow`，snake_case 与存储一致）：

```json
{
  "items": [ { "rowid":1, "id":"…", "timestamp":"…", "provider_name":"anthropic",
    "model":"claude-sonnet-5", "status":200, "duration":1234,
    "input_tokens":1200, "output_tokens":340, "thread_id":"…", "…": "…" } ],
  "cursor": "base64…",   // 下一页；null = 没有更多
  "count": 20,           // 本页条数
  "total": 137,          // 全量命中数
  "has_more": true
}
```

### `lucent query log <id>` — 单条详情（含 body）

返回全部 `LogRow` 字段 + `body`：

```json
{ "rowid":1, "id":"…", /* …全部元数据… */,
  "body": { "request": { /* parsed */ }, "response": { /* parsed */ } } }
```

- `--no-body` 不带 body；`--max-body <bytes>` 截断（**默认 50000**，超出截断并标 `"body_truncated": true`）；`--full-body` 不截断。
- 默认截断理由：单条 body 可能几十万字符，AI 上下文吃不消。

### `lucent query search <keyword>` — 全文搜索（FTS5 trigram）

复用 `searchLogs`（≥3 字符走 FTS，<3 回退 LIKE）。过滤 / 分页选项同 `logs`，输出结构同 `logs`。

### `lucent query stats` — 统计聚合

```
--by provider|model|agent-type|endpoint|status|day|hour   # 默认 model
--since / --until / --provider / --model / ...            # 同 logs 的过滤
```

```json
{
  "dimension": "model",
  "buckets": [{ "key":"claude-sonnet-5", "count":120,
                "input_tokens":123456, "output_tokens":23456,
                "cache_read_tokens":100000, "cache_creation_tokens":2000,
                "total_duration_ms":12345 }],
  "totals": { "count":…, "input_tokens":…, "output_tokens":…,
              "cache_read_tokens":…, "cache_creation_tokens":…, "total_duration_ms":… }
}
```

## 只读与安全边界

- `query` 只发 `SELECT`，绝不调写函数（`insertLog` / `clearAllLogs` / `deleteOldLogs` 等）。
- 数据库以只读打开：新增 `openDbReadonly(path)` = `new Database(path, { readonly: true })`，不迁移、不挂单例、查完 `close()`。
- MVP **只查 `logs`**，不碰 `config` 表。
- DB 路径解析复刻服务器口径：`process.env.LUCENT_DB_PATH || join(CONFIG_DIR, 'lucent.db')`，`CONFIG_DIR = LUCENT_CONFIG_DIR || ~/.lucent`。

## 错误处理与退出码

| 退出码 | 含义 |
|---|---|
| 0 | 成功（含「无结果」——`items:[]` 不算错误） |
| 2 | 数据库问题（文件不存在 / 无法打开） |
| 3 | 参数非法（`--status` 非数字、`--since` 解析不了、未知 `--by` 等） |
| 1 | 其他未预期错误 |

JSON 模式：错误以 `{"error":"<code>","message":"…"}` 输出到 stderr + 非零退出码；`--human` 模式给友好文本。

## 实现结构（文件清单）

| 文件 | 改动 |
|---|---|
| `server/services/db.ts` | 扩展 `ListFilter`（+`model`/`status`/`isTest`）+ `applyFilter`；新增 `openDbReadonly` + `getStatsByDimension`（纯增强，向后兼容） |
| `bin/query.ts`（新） | CLI 查询纯函数：`resolveDbPath` / `parseTime` / `buildListFilter` / `runLogsQuery` / `runLogDetail` / `runSearchQuery` / `runStatsQuery` / `formatOutput`；接收 db，可单测 |
| `bin/cli.ts` | 新增 `query` 顶层命令 + 4 子命令（commander 装配，调 `bin/query.ts`）；修 `start` 改用 tsx 跑 `server/index.ts` |
| `bin/cli.js`（新） | thin wrapper：用 `node --import tsx/esm cli.ts` 运行，让 `lucent` / `node bin/cli.js` 真正可执行（修 `package.json` bin 指向 `cli.js` 但磁盘是 `cli.ts` 的不一致） |
| `tests/query-cli.test.ts`（新） | 用临时 SQLite 库插样本，覆盖 4 子命令 / 过滤 / 分页 / 搜索 / 统计 / body 截断 / 退出码 |

## 测试策略

命令处理逻辑抽成接收 `db + opts` 的纯函数，commander 只解析参数 + 打印。测试直接调纯函数、断言输出，不靠 spawn 进程。用临时 SQLite 库（`openDb` 建库 + `insertLogsBatch` 插样本 RawLogEntry），覆盖：4 子命令、各过滤维度、keyset 分页、FTS 搜索、stats 各 dimension、body 截断、各错误退出码、db 路径解析。

## 附带改进（顺带修在工作的代码上）

1. **`bin` 入口不一致**：`package.json` bin 指 `./bin/cli.js`（不存在，磁盘是 `cli.ts`）；`start` spawn 不存在的 `server/index.js`。新增 `bin/cli.js` wrapper 让 `lucent` 真正可执行，并把 `start` 改走 tsx。
2. **`ListFilter` 扩展**：现有 `listLogs` 不支持 model/status/is_test 过滤，扩展后 Web API 也能受益（向后兼容，新字段可选）。
