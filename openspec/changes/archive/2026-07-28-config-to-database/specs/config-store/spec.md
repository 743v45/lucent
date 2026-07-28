# config-store Specification

## ADDED Requirements

### Requirement: Configuration MUST persist in the SQLite database as a single JSON row, not a JSON file

The system SHALL store the entire `ProxyConfig` as one JSON document in the `config` table of the application
SQLite database (`lucent.db`), co-located with the logs. The `config` table SHALL contain exactly one row
(`id = 1`, `data TEXT NOT NULL`, `updated_at TEXT NOT NULL`). `loadConfig` (`server/config.ts`) MUST read from
this table; `saveConfig` MUST write it inside a single transaction (`BEGIN … INSERT OR REPLACE … COMMIT`).
After the one-time migration, the system MUST NOT read or write `config.json` as the source of configuration.

**Rationale:** config.ts already operates on a JSON object model (validate/clone/CRUD). A single JSON blob row
preserves that model with minimal change, makes migration a copy of the existing blob, and lets SQL export/import
be a one-row `INSERT`. SQLite transactions give atomic writes natively, replacing the file tmp+rename dance.

#### Scenario: Fresh database initializes default config into the table
- **GIVEN** a `lucent.db` whose `config` table is empty and no legacy `config.json` exists
- **WHEN** the app starts and `loadConfig` runs
- **THEN** a default `ProxyConfig` (including the `anthropic` seed provider) is written as the `id=1` row
- **AND** `getConfig` returns that default

#### Scenario: saveConfig is atomic — no partial config is ever observed
- **GIVEN** a running instance with config row `A`
- **WHEN** `saveConfig(B)` is invoked and a concurrent reader calls `getConfig` during the write
- **THEN** the reader observes either the complete `A` or the complete `B`, never a half-written/partial document

#### Scenario: Restart preserves stored config
- **GIVEN** an instance whose `config` table row holds config `C`
- **WHEN** the app restarts and `loadConfig` runs
- **THEN** `getConfig` returns `C` unchanged from the table

### Requirement: The database path MUST be fixed by environment or default, independent of stored config

The system SHALL determine the SQLite database path solely from the `LUCENT_DB_PATH` environment variable or the
default `CONFIG_DIR/lucent.db`. The resolved DB path MUST NOT depend on any value stored inside the config
(no self-reference). The `ProxyConfig.dbPath` field is deprecated and MUST NOT be consulted to locate the
config store.

**Rationale:** config now lives in the DB, so the DB location cannot be derived from config (chicken-and-egg).
Pinning the path to env-or-default breaks the cycle and matches how the logs DB is already located.

#### Scenario: Default path when env unset
- **GIVEN** `LUCENT_DB_PATH` is unset and `LUCENT_CONFIG_DIR=/data`
- **WHEN** the system resolves the DB path
- **THEN** the path is `/data/lucent.db`

#### Scenario: Env override wins regardless of any stored config
- **GIVEN** `LUCENT_DB_PATH=/tmp/test.db` is set
- **WHEN** the system resolves the DB path
- **THEN** the path is `/tmp/test.db`, ignoring any `dbPath` value that may exist in stored config

### Requirement: First run SHALL migrate an existing legacy config.json into the database exactly once

On `loadConfig`, if the `config` table is empty AND a legacy `config.json` exists at `CONFIG_PATH`, the system
SHALL validate and import its content into the `config` table (preserving the original file as `config.json.bak`),
and MUST NOT re-read the file on subsequent loads. If the table already has a row, the legacy file MUST be ignored
(idempotent — never overwrite runtime changes). If the legacy JSON fails validation, the system SHALL back up the
offending file and fall back to default config (mirroring prior corruption handling).

**Rationale:** Existing installs carry config in `config.json`; a one-time, idempotent import preserves user
configuration across the upgrade without ongoing dual-source drift.

#### Scenario: Valid legacy file is imported once
- **GIVEN** an empty `config` table and a valid `config.json` on disk
- **WHEN** the app starts
- **THEN** the `config` table row equals the imported content
- **AND** on the next restart the file is ignored (no re-import) even if it was deleted

#### Scenario: Table already populated ignores the legacy file
- **GIVEN** a `config` table that already has a row and a stale `config.json` on disk
- **WHEN** the app starts
- **THEN** `getConfig` returns the table row, not the file

#### Scenario: Corrupt legacy file falls back to default
- **GIVEN** an empty `config` table and a `config.json` that fails JSON parse or validation
- **WHEN** the app starts
- **THEN** the offending file is backed up and a default config is written to the table

### Requirement: SQL export endpoint MUST emit a portable, runnable script

`GET /api/config/export` SHALL return a SQL script that recreates the `config` table and inserts the current
config row, of the form `CREATE TABLE IF NOT EXISTS config (...); INSERT OR REPLACE INTO config(id,data,updated_at)
VALUES(1,'<current-config-json>','<timestamp>');`. The response MUST be downloadable (content-type / disposition
appropriate for a `.sql` file).

**Rationale:** A single self-contained SQL script lets users back up or migrate config by piping it into any
sqlite client, alongside a logs dump of the same DB.

#### Scenario: Export reflects current config and is runnable
- **GIVEN** an instance with config `C`
- **WHEN** `GET /api/config/export` is called
- **THEN** the response body contains a `CREATE TABLE config` statement and an `INSERT` whose `data` value parses to `C`
- **AND** executing the script against an empty sqlite database yields a `config` table whose `id=1` row equals `C`

### Requirement: SQL import endpoint MUST replace config transactionally with validation

`POST /api/config/import` SHALL accept a config payload (SQL script or JSON), parse and `validateConfig` it, and
within a single transaction replace the `config` table row. On any validation or parse failure the endpoint MUST
reject with HTTP 400 and MUST NOT modify the stored config (transaction rolled back). On success the new config
MUST take effect immediately (`getConfig` returns it) and the legacy `config.json` MUST NOT be (re)written.

**Rationale:** Import is an overwrite; a bad payload must never corrupt the running instance. Atomic replace +
validation guarantee the store is either wholly updated or wholly unchanged.

#### Scenario: Valid import replaces config
- **GIVEN** an instance and a previously exported SQL script
- **WHEN** `POST /api/config/import` is called with that script
- **THEN** the response is 2xx, the `config` table row is replaced, and `getConfig` reflects the imported config

#### Scenario: Invalid import leaves stored config unchanged
- **GIVEN** an instance with stored config `C`
- **WHEN** `POST /api/config/import` is called with a payload that fails `validateConfig`
- **THEN** the response is HTTP 400 and `getConfig` still returns `C` (no partial write)
