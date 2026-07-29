# ai-query-cli Specification

## Purpose
The `lucent query` CLI command gives AI agents read-only, structured (JSON) access to Lucent's logged
API-call SQLite store — listing, searching, inspecting, and aggregating intercepted OpenAI/Claude traffic
without requiring the proxy/web server to be running.
## Requirements
### Requirement: The CLI MUST expose a read-only `query` command that emits structured JSON by default

The system SHALL provide a `lucent query` command with subcommands `logs`, `log <id>`, `search <keyword>`,
and `stats`. By default each subcommand SHALL print a single JSON document to stdout (machine-readable for AI
consumption) and exit 0 on success. The command MUST be read-only: it SHALL only issue `SELECT` against the
database and MUST NOT invoke any write/mutation function (`insertLog`, `clearAllLogs`, `deleteOldLogs`,
`deleteExpiredLogs`, `vacuum`, etc.). A `--human` flag MAY switch output to a human-readable table; JSON remains
the default.

**Rationale:** The consumer is an AI agent reading stdout, not a human glancing at a terminal. Stable JSON shape
lets the agent parse reliably; defaulting to JSON removes a flag the agent would otherwise always have to pass.
Read-only is a hard safety boundary — a query tool must never alter the store it inspects.

#### Scenario: Default output is JSON
- **GIVEN** a database with at least one log row
- **WHEN** `lucent query logs --limit 1` is run with no `--human`
- **THEN** stdout is a single valid JSON object with an `items` array
- **AND** the process exits 0

#### Scenario: Query never writes to the database
- **GIVEN** a database at a known state
- **WHEN** any `lucent query …` subcommand is run
- **THEN** no write/mutation function is invoked and the database content is byte-for-byte unchanged afterward

### Requirement: Query MUST read the SQLite database directly via a read-only connection, independent of the server

The CLI SHALL open the database with a read-only connection (`readonly: true`) for the duration of one command
invocation and close it on exit. The CLI MUST NOT require the proxy/web server to be running and MUST NOT call
the HTTP API. The CLI SHALL resolve the database path as `LUCENT_DB_PATH` env, else `CONFIG_DIR/lucent.db`
(where `CONFIG_DIR = LUCENT_CONFIG_DIR || ~/.lucent`) — identical to the server's resolution — so both read the
same store.

**Rationale:** An AI agent may query at any time, including when no server is running. A read-only connection
makes the safety boundary structural rather than conventional, and WAL mode makes concurrent reads safe while the
server writes. Reusing the exact path resolution guarantees the CLI sees the same data the Web UI does.

#### Scenario: Works without the server running
- **GIVEN** a populated `lucent.db` and no lucent server process
- **WHEN** `lucent query logs` is run
- **THEN** rows are returned and the process exits 0

#### Scenario: Env override wins for the DB path
- **GIVEN** `LUCENT_DB_PATH=/tmp/test.db` is set
- **WHEN** the CLI resolves the DB path
- **THEN** it reads `/tmp/test.db`

#### Scenario: Missing database is a db error, not a crash
- **GIVEN** `LUCENT_DB_PATH` points at a non-existent file
- **WHEN** `lucent query logs` is run
- **THEN** the process exits with code 2 and reports a database error (no uncaught exception)

### Requirement: `logs` and `search` MUST support filtering and keyset cursor pagination

`lucent query logs` SHALL filter by `--provider`, `--model`, `--agent-type`, `--endpoint`, `--status`,
`--thread-id`, `--is-test`, `--since`, and `--until`. `--since`/`--until` SHALL accept ISO 8601 timestamps or
relative durations (`Nm`/`Nh`/`Nd`, e.g. `30m`, `24h`, `7d`). Results SHALL be ordered newest-first and paginated
by a keyset cursor; the output SHALL include `items`, `cursor` (next page token or null), `count` (page size),
`total` (full match count), and `has_more`. `lucent query search <keyword>` SHALL accept the same filters and
output the same shape, using FTS5 for queries of at least 3 characters.

**Rationale:** Filtering at the SQL layer (not in JS after limit) keeps `total` and pagination correct. Keyset
cursor (already implemented in `db.ts`) avoids OFFSET degradation on deep pages. Relative durations are natural
for an agent ("last 7 days").

#### Scenario: Filter narrows results and total reflects the full match
- **GIVEN** a database with logs from providers `anthropic` and `openai`
- **WHEN** `lucent query logs --provider anthropic` is run
- **THEN** every returned item has `provider_name = "anthropic"`
- **AND** `total` equals the count of anthropic rows (not the whole database)

#### Scenario: Relative --since is parsed as a duration ago
- **GIVEN** a database containing a row timestamped 1 hour ago
- **WHEN** `lucent query logs --since 2h` is run
- **THEN** that row is included in `items`
- **AND** running `--since 30m` excludes it

#### Scenario: Cursor returns the next page
- **GIVEN** more matches than `--limit`
- **WHEN** `lucent query logs --limit 5` is run, then again with `--cursor <returned cursor>`
- **THEN** the second result's `items` do not overlap the first page's

### Requirement: `log <id>` MUST return full metadata with bodies, truncated by default

`lucent query log <id>` SHALL return all `LogRow` metadata fields plus `body.request` and `body.response`
(parsed objects). To protect bounded consumers (AI context windows), each body SHALL be truncated to
`--max-body` bytes (default 50000) of its serialized form; when truncated, the output SHALL set
`body_truncated: true`. `--no-body` SHALL omit bodies entirely; `--full-body` SHALL disable truncation. A
non-existent id SHALL exit with code 0 and an empty/null result (not found is not an error).

**Rationale:** A single raw body can be hundreds of thousands of characters; returning it whole by default would
blow past an agent's context. A generous default with an explicit opt-out (`--full-body`) serves both the common
"see what happened" case and the rare "I need every byte" case.

#### Scenario: Body is truncated by default and flagged
- **GIVEN** a log whose serialized response body is 120000 bytes
- **WHEN** `lucent query log <id>` is run with defaults
- **THEN** the output contains `body_truncated: true`
- **AND** `--full-body` returns the complete body without the flag

#### Scenario: Unknown id is not an error
- **GIVEN** a database with no row having id `nope`
- **WHEN** `lucent query log nope` is run
- **THEN** the process exits 0 with an empty/null result

### Requirement: `stats` MUST aggregate by a configurable dimension with token, duration, and count totals

`lucent query stats` SHALL aggregate logs by `--by` dimension (`provider`, `model`, `agent-type`, `endpoint`,
`status`, `day`, `hour`; default `model`), honoring the same filters as `logs`. The output SHALL contain
`dimension`, a `buckets` array (one per group key, each with `count`, `input_tokens`, `output_tokens`,
`cache_read_tokens`, `cache_creation_tokens`, `total_duration_ms`), and a `totals` object summing the same
metrics across all matched rows.

**Rationale:** Cost analysis and anomaly hunting ("which model burns the most tokens", "failures by status") need
server-side aggregation, not client-side iteration over paged lists. Sums use `COALESCE` so NULL token columns
don't break the totals.

#### Scenario: Aggregation groups by model and sums tokens
- **GIVEN** logs for models `A` (2 rows, 100 + 200 output tokens) and `B` (1 row, 50 output tokens)
- **WHEN** `lucent query stats --by model` is run
- **THEN** bucket `A` has `count = 2` and `output_tokens = 300`, bucket `B` has `count = 1` and `output_tokens = 50`
- **AND** `totals.output_tokens = 350`

#### Scenario: Unknown dimension is a bad-args error
- **GIVEN** any database
- **WHEN** `lucent query stats --by color` is run
- **THEN** the process exits with code 3

### Requirement: Exit codes MUST distinguish success, database errors, and invalid arguments

The CLI SHALL exit 0 on success (including empty results), 2 when the database cannot be opened or does not
exist, 3 when an argument is invalid (non-numeric `--status`, unparseable `--since`, unknown `--by`, etc.), and
1 for any other unexpected error. In JSON mode, errors SHALL be reported on stderr as
`{"error":"<code>","message":"…"}` alongside the non-zero exit code.

**Rationale:** An agent branching on outcome needs a machine-checkable signal; exit codes are the cheapest.
Splitting db-error from bad-args lets the agent react differently (retry/fix-path vs. fix-the-command).

#### Scenario: Non-numeric status is a bad-args error
- **GIVEN** any database
- **WHEN** `lucent query logs --status abc` is run
- **THEN** the process exits with code 3 and stderr contains a JSON error object

