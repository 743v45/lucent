# body-rewrite Specification Delta

## ADDED Requirements

### Requirement: The Web UI MUST expose a dedicated entry that opens the body-rewrite rule manager

The Web UI MUST provide a dedicated top-bar button (distinct from the general
Settings entry) that opens the `BodyRewriteModal`. The button MUST use a
`WrenchScrewdriverIcon` with `title="Body 重写规则"` so it is discoverable and
distinct from provider/setting management.

**Rationale:** Body rewrite is an advanced, opt-in feature with non-trivial
side effects (KV-cache invalidation, agent reclassification). Giving it a
dedicated entry — rather than burying it inside the general Settings modal —
makes the feature discoverable for users who need it and keeps it visually
separated from routine provider configuration.

#### Scenario: Dedicated top-bar button present
- **WHEN** the Web UI top bar is rendered
- **THEN** it MUST contain a button with `title="Body 重写规则"` using the
  `WrenchScrewdriverIcon`
- **AND** the button MUST be separate from the general Settings entry

#### Scenario: Button opens the BodyRewriteModal
- **WHEN** the user clicks the dedicated button
- **THEN** the `BodyRewriteModal` MUST open
- **AND** the current `bodyRewrites` list MUST be loaded from the backend

### Requirement: The backend MUST expose a CRUD REST API for body-rewrite rules

The backend MUST expose four endpoints under `/api/body-rewrites`:
`GET /api/body-rewrites` returns the full `BodyRewriteRule[]`；
`POST /api/body-rewrites` creates a new rule and returns the created rule with
its server-generated `id`；`PUT /api/body-rewrites/:id` updates the rule whose
`id` matches the path parameter；`DELETE /api/body-rewrites/:id` deletes it.

**Rationale:** A REST CRUD surface lets the Modal edit rules through a stable,
typed contract instead of rewriting `config.json` by hand. Server-generated
`id` keeps identity authoritative on the backend, avoiding races where two
clients mint the same id.

#### Scenario: GET returns the rule list
- **WHEN** `GET /api/body-rewrites` is called
- **THEN** the response MUST be a JSON array of `BodyRewriteRule` objects
- **AND** each object MUST match the persisted `bodyRewrites` in
  `~/.lucent/config.json`

#### Scenario: POST creates a rule with a server-generated id
- **GIVEN** a request body containing rule fields without `id`
- **WHEN** `POST /api/body-rewrites` is called
- **THEN** the backend MUST generate the `id`
- **AND** MUST persist the new rule via `saveConfig`
- **AND** MUST respond with the created rule including the generated `id`

#### Scenario: PUT updates an existing rule matched by path id
- **GIVEN** an existing rule with `id = "r1"`
- **WHEN** `PUT /api/body-rewrites/r1` is called with updated fields
- **THEN** the backend MUST update exactly the rule whose `id` equals `"r1"`
- **AND** MUST NOT allow the `id` field itself to be changed

#### Scenario: DELETE removes a rule matched by path id
- **GIVEN** an existing rule with `id = "r1"`
- **WHEN** `DELETE /api/body-rewrites/r1` is called
- **THEN** the backend MUST remove that rule from `bodyRewrites`
- **AND** MUST persist the result via `saveConfig`

### Requirement: Every CRUD write MUST be validated and persisted before taking effect on subsequent requests

The backend MUST run the existing `validateBodyRewrites` on the resulting
`bodyRewrites` array for every POST/PUT/DELETE, MUST reject invalid input with
a non-2xx response, and MUST call `saveConfig` to persist valid results to
`~/.lucent/config.json`. The proxy MUST read the latest config on each request,
so a saved rule MUST affect subsequent requests without a process reload.

**Rationale:** Reusing the engine's existing strict validation keeps the
authored-config and UI-edited-config paths identical — there is one source of
truth for "what is a valid rule". Persisting via `saveConfig` and reading
per-request is what delivers "save = effective immediately" without restart.

#### Scenario: Invalid rule is rejected and not persisted
- **GIVEN** a POST/PUT body that fails `validateBodyRewrites` (e.g. bad
  `flags`, unconstructible `pattern`, unknown key)
- **WHEN** the endpoint is called
- **THEN** the backend MUST respond with a non-2xx status
- **AND** MUST NOT persist the change to `~/.lucent/config.json`

#### Scenario: Saved rule takes effect without reload
- **GIVEN** a rule saved via the CRUD API
- **WHEN** the next proxied request arrives
- **THEN** the proxy MUST apply that rule as part of the current `bodyRewrites`
- **AND** no backend process restart MUST be required

### Requirement: The Modal MUST support inline editing of every BodyRewriteRule field with save-on-blur

The `BodyRewriteModal` MUST let the user edit each of `name`, `enabled`,
`fieldPath`, `pattern`, `flags`, and `replacement` inline, and MUST auto-save
a field (PUT) when it loses focus. Adding a rule MUST use POST and deleting
MUST use DELETE, both reflected immediately in the list.

**Rationale:** Save-on-blur removes the "did I forget to click Save?" failure
mode for an advanced feature where a stale rule silently mis-rewrites
production traffic. Inline editing of every field mirrors the rule shape
exactly, so there is no hidden field the user cannot reach from the UI.

#### Scenario: Field edit persists on blur
- **GIVEN** an existing rule is shown in the Modal
- **WHEN** the user edits `pattern` and tabs away (blur)
- **THEN** the Modal MUST issue a PUT with the new `pattern`
- **AND** the persisted rule in config MUST reflect the change

#### Scenario: Add rule flow
- **WHEN** the user triggers "add rule"
- **THEN** the Modal MUST POST a new rule
- **AND** MUST use the `id` returned by the backend for any subsequent edit
  (PUT) or delete (DELETE) of that rule

#### Scenario: Delete rule flow
- **WHEN** the user deletes a rule from the list
- **THEN** the Modal MUST issue DELETE with that rule's server-issued `id`
- **AND** MUST remove the row from the list only after a 2xx response

### Requirement: The Modal MUST provide a client-side dry-run preview using the same replacement semantics as the engine

The `BodyRewriteModal` MUST provide a dry-run preview: given a sample text
entered by the user, it MUST construct `new RegExp(pattern, flags ?? 'g')`
and display `sample.replace(regex, replacement)` in real time. The preview
MUST apply the same flags-default-`g` rule and the same substring-replacement
semantics as the backend engine, so what the user sees is what the proxy will
do.

**Rationale:** Regex authoring needs immediate feedback. Computing the preview
client-side with the identical `RegExp` construction as the backend guarantees
"WYSIWYG" — the preview cannot drift from production behavior. Reusing the
`g`-default keeps the safe-by-default contract on both sides.

#### Scenario: Preview reflects global replacement by default
- **GIVEN** a rule with `pattern = "X"`, no `flags`, `replacement = ""`
- **AND** the user enters sample text `"aXbXc"`
- **WHEN** the preview is computed
- **THEN** the displayed result MUST be `"abc"` (both occurrences, default `g`)

#### Scenario: Invalid regex in preview is shown as an error, not a crash
- **GIVEN** a rule whose `pattern` cannot be constructed (e.g. `"(unclosed"`)
  or whose `flags` is outside `[gimsuy]`
- **WHEN** the preview is computed
- **THEN** the Modal MUST display an error message at the preview area
- **AND** MUST NOT throw, crash, or block editing of other fields

#### Scenario: Preview honors explicit flags
- **GIVEN** a rule with `pattern = "X"`, `flags = ""`, `replacement = ""`
- **AND** sample text `"aXbXc"`
- **WHEN** the preview is computed
- **THEN** the displayed result MUST be `"abXc"` (only the first match, no `g`)
