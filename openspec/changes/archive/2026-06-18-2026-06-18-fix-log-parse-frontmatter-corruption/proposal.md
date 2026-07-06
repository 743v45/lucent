## Why

含 markdown frontmatter 的请求(SOUL.md / YAML front matter 都是 `\n---\n` 开头)一旦被记录,**该日志条目及之后的所有日志条目全部解析失败、被静默丢弃**,Web UI 看不到这些请求,但 server 日志显示上游 200、SSE 正常收集。

根因在 `server/constants.ts` 的自创分隔符转义机制:

- **写入**(`log-writer.ts:96`):`escapeLogContent(JSON.stringify(entry)) + LOG_ENTRY_SEPARATOR`。
  `escapeLogContent` 把字符串里 4 字符字面序列 `\n---\n` 替换成 `\\n---\\n`。
  但 `JSON.stringify` 已经把真实换行变成 2 字符字面 `\n`,所以 markdown frontmatter 的 `\n---\n`(此时是 4 字符字面)会被 escape 改写成 6 字符 `\\n---\\n`。
- **读取**(`log-reader.ts:78`):`JSON.parse(unescapeLogContent(line))`。
  `unescapeLogContent` 在 `JSON.parse` **之前**把 `\\n---\\n` 还原成 `\n---\n`(4 字符字面)。
  但这 4 字符此刻位于 JSON 字符串值内部,被 `JSON.parse` 当成"反斜杠 + 非法裸换行控制字符",抛 `Bad control character in string literal`。
- `readFileEntries` 的 catch 静默吞掉解析失败的 chunk(`log-reader.ts:80-82`),导致**失败条目及之后所有条目**从 UI 消失。

矛盾本质:JSON 已经承担了换行转义职责,再叠一层"分隔符转义"必然打架——任何"先 stringify 再 escape、先 unescape 再 parse"的设计都会破坏 JSON 字符串值的合法性。

实测证据(本机 `~/.lucent/logs/lucent_2026-06-18_15-50-44.jsonl`):6 个 chunk 仅 1 个解析成功,4 个失败,全部因 frontmatter 中的 `\n---\ntitle: "SOUL.md"` 触发;目标 hxy 请求(ts=`07:57:58`)在 chunk[4] 失败,因此 `/api/logs` 返回最新条停在 `07:50:53`。

## What Changes

- **删除** `server/constants.ts` 的 `LOG_ENTRY_SEPARATOR`、`LOG_SPLIT_REGEX`、`escapeLogContent`、`unescapeLogContent`(整套自创分隔符机制)
- **写入** 改用**标准 JSON Lines**:一条日志 = 一行 JSON,行尾 `\n`。`JSON.stringify` 保证值内无裸换行,分隔符即真实换行符,与 JSON 内容天然不冲突。
- **读取** 改为按行 split + 逐行 `JSON.parse`,空行跳过。
- **历史兼容**:不处理旧文件(用户选择)。旧 `escape` 格式文件读取可能仍出错——这是已知接受状态,用户可手动删除或归档旧文件。

**不**改的:`RawLogEntry` / `LogEntry` 数据形状、`log-reader.ts` 的归一化/过滤/缓存逻辑(`readFileEntries` 的 chunk 拆分方式除外)、轮转/清理、HTTP API、UI。

## Capabilities

### Modified Capabilities
- `log-integrity` —— 增加"日志格式 = 标准 JSONL、值内换行由 JSON.stringify 转义、不得引入第二层分隔符转义"的硬约束。原 `body verbatim` / `no delta metadata` 不变。

### New Capabilities
无。

## Impact

- **受影响代码**:
  - 改 `server/constants.ts`(删 4 个导出)
  - 改 `server/services/log-writer.ts`(`writeLogEntry` 改写 `\n` 结尾的纯 JSON,删除 `escapeLogContent` 调用)
  - 改 `server/services/log-reader.ts`(`readFileEntries` 改按行 split + 去 `unescapeLogContent`)
  - 检索其它引用点(`escapeLogContent` / `unescapeLogContent` / `LOG_ENTRY_SEPARATOR` / `LOG_SPLIT_REGEX`)并清理
- **受影响测试**:新增 frontmatter round-trip 单测(先红);全套 `verify:*` + `npm test` 必须绿
- **不变量**:
  - 任何 JSON 字符串值(含 markdown / YAML / 代码块)经过 write→read round-trip 后,字节级等价
  - 一条日志 = 文件中一行(以 `\n` 结尾),不跨行
  - 不存在第二层转义层
- **已知接受**:`~/.lucent/logs/` 下已存在的旧格式文件,在新代码下读取可能解析失败(行为与今天相同),不做迁移
- **不影响**:HTTP API 形状、UI、轮转/清理、运行时拦截/SSE 行为
