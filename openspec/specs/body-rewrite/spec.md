# body-rewrite Specification

## Purpose
TBD - created by archiving change 2026-07-06-body-rewrite-engine. Update Purpose after archive.
## Requirements
### Requirement: The system MUST provide an opt-in request body rewrite engine configured by `bodyRewrites`

The system MUST provide a request body rewrite engine that is **off by default**
and activates only when `~/.lucent/config.json` contains a non-empty top-level
`bodyRewrites` array. Each entry MUST conform to the `BodyRewriteRule` shape:
`id` (non-empty string), `name?` (optional display-only string), `enabled?`
(optional boolean, default `true`), `fieldPath` (string), `pattern` (string),
`flags?` (optional string), `replacement` (string). When `bodyRewrites` is
absent, `null`, `undefined`, or an empty array, the proxy MUST take the original
zero-overhead path and MUST NOT parse, re-serialize, or copy the request body
for rewriting purposes.

**Rationale:** Lucent's core principle is "request body is passed through
verbatim" (request-transformation-design §7). The rewrite engine is an opt-in
escape hatch for sanitization (e.g. stripping Claude Code's injected
`x-anthropic-billing-header` from `system[0].text`), not a default behavior.
Gate it behind explicit configuration so the default path stays byte-transparent
and zero-cost.

#### Scenario: Missing or empty bodyRewrites is a no-op
- **GIVEN** `bodyRewrites` is absent, `null`, `undefined`, or `[]`
- **WHEN** a request passes through the proxy
- **THEN** the rewrite engine MUST NOT touch the request body
- **AND** the body handed to `fetch()` MUST be the original buffer by reference
- **AND** no JSON parse / re-serialize work MUST be incurred for rewriting

#### Scenario: A rule with enabled=false is skipped
- **GIVEN** `bodyRewrites` contains a rule whose `enabled` is `false`
- **WHEN** the engine evaluates the request body
- **THEN** that rule MUST be skipped as if it were absent

#### Scenario: Rule shape is the BodyRewriteRule contract
- **WHEN** reading any active rule object
- **THEN** it MUST expose `id: string` (non-empty), `fieldPath: string`,
  `pattern: string`, `replacement: string`
- **AND** MAY expose `name?: string`, `enabled?: boolean`, `flags?: string`

### Requirement: fieldPath MUST use the documented dotted-key + bracket-index grammar

A rule's `fieldPath` MUST locate the target leaf using a grammar that mixes
object keys (dot-separated) and array indices (bracketed). The accepted grammar
is:

```
fieldPath   := segment (segment)*
segment     := dotKey | bracketKey
dotKey      := "." KEY              ; leading "." only at start; "." between keys
bracketKey  := "[" INDEX "]"
KEY         := non-empty, no "." no "[" no "]"
INDEX       := decimal digits
```

Concretely: `system[0].text`, `messages[0].content[1].text`,
`a.b.c`, `a[0].b`. A path that resolves to a **string leaf** is the rewrite
target; a path that resolves to a non-string value, or that does not exist in
the parsed body, MUST be skipped (no rewrite, no error).

**Rationale:** A single precise grammar removes ambiguity about how to address
nested JSON values across the three protocols (Anthropic `system[].text`, OpenAI
`messages[].content[].text`). Restricting rewrites to string leaves keeps the
engine a pure substring transform — it cannot restructure objects/arrays, only
edit text in place.

#### Scenario: Object key chain resolves to a string leaf
- **GIVEN** body `{"system": {"text": "hello world"}}` and fieldPath `system.text`
- **WHEN** the engine resolves the path
- **THEN** it MUST locate the string `"hello world"` as the rewrite target

#### Scenario: Mixed array index + object key resolves to a string leaf
- **GIVEN** body `{"system": [{"text": "abc"}]}` and fieldPath `system[0].text`
- **WHEN** the engine resolves the path
- **THEN** it MUST locate the string `"abc"` as the rewrite target

#### Scenario: Non-string leaf is skipped
- **GIVEN** a fieldPath that resolves to a number, boolean, object, or array
- **WHEN** the engine evaluates the rule
- **THEN** the rule MUST be skipped (no rewrite applied at that path)

#### Scenario: Missing path is skipped
- **GIVEN** a fieldPath that does not exist in the parsed body
- **WHEN** the engine evaluates the rule
- **THEN** the rule MUST be skipped without throwing

### Requirement: Rewrite semantics MUST be JavaScript substring replacement with flags defaulting to `g`

For each resolved string leaf, the engine MUST compute the replacement as:

```
value.replace(new RegExp(pattern, flags ?? 'g'), replacement)
```

That is, a **substring replacement**: matched portions are substituted by
`replacement` (which MAY use `$1`, `$2`, `$&`, etc.); unmatched portions are
preserved verbatim. When `flags` is omitted, the engine MUST apply the flags
string `'g'` (global) so that sanitization rules replace **all** matches by
default, not just the first.

**Rationale:** Substring replacement is the minimum semantic that covers
sanitization (delete/replace a billing header, mask a secret) while preserving
everything else. Defaulting to `'g'` makes the common "strip every occurrence"
case safe-by-default — a missing `flags` must not silently leave extra matches
in the body.

#### Scenario: Omitted flags defaults to global replacement
- **GIVEN** value `"aXbXc"`, pattern `"X"`, no `flags`, replacement `""`
- **WHEN** the engine applies the rule
- **THEN** the result MUST be `"abc"` (both occurrences replaced)

#### Scenario: Explicit flags override the default
- **GIVEN** value `"aXbXc"`, pattern `"X"`, `flags: ""`, replacement `""`
- **WHEN** the engine applies the rule
- **THEN** the result MUST be `"abXc"` (only the first match, no `g` flag)

#### Scenario: Replacement preserves unmatched text and supports backreferences
- **GIVEN** value `"key: secret123;"` and pattern `"key: (\w+);"` and
  replacement `"key: ***;"`
- **WHEN** the engine applies the rule
- **THEN** the result MUST be `"key: ***;"` and any text outside the match MUST
  be preserved

### Requirement: flags MUST be restricted to the [gimsuy] character set

When a rule supplies `flags`, it MUST be a string matching the regex
`/^[gimsuy]*$/`. Any other character (or duplicate flags that
`new RegExp` would reject) MUST fail configuration validation.

**Rationale:** `[gimsuy]` is the complete set of valid JavaScript RegExp flags.
Restricting to this set both validates user input early and prevents arbitrary
string injection into the `RegExp` constructor.

#### Scenario: Valid flags accepted
- **GIVEN** `flags` is any of `"g"`, `"gi"`, `"gimuy"`, `""`
- **WHEN** configuration is validated
- **THEN** the rule MUST be accepted

#### Scenario: Invalid flags rejected
- **GIVEN** `flags` contains any character outside `[gimsuy]` (e.g. `"gz"`,
  `"abc"`)
- **WHEN** configuration is validated
- **THEN** validation MUST reject the rule

### Requirement: Multiple rules MUST cascade in array order

When `bodyRewrites` contains more than one rule, the engine MUST apply them in
the order they appear in the array, where each rule's output body is the next
rule's input. Disabled rules (`enabled: false`) are removed from the cascade
before it begins.

**Rationale:** Deterministic ordering makes the outcome of a multi-rule config
predictable and explainable. Cascading lets users compose a coarse rule (e.g.
strip billing header) with a fine rule (e.g. mask a specific token) without
writing a single monster regex.

#### Scenario: Later rule sees earlier rule's output
- **GIVEN** two rules A then B, where A replaces `"foo"` → `"bar"` and B
  replaces `"bar"` → `"baz"`
- **WHEN** the engine processes a body containing `"foo"`
- **THEN** the final body MUST contain `"baz"` (A ran before B)

### Requirement: Zero-match and absent-config MUST be byte-transparent (original buffer by reference)

The engine MUST return the original request buffer **by reference**
(identity `===`) when no active rule matches any leaf (zero matches across all
rules), incurring no re-serialization. This complements the absent-config
no-op: the proxy's default path stays byte-for-byte identical to a build
without the engine.

**Rationale:** "Byte-transparent by default" is the contract that lets the
engine co-exist with Lucent's transparency principle. Returning the original
reference (not a copy) proves zero work was done and avoids any chance of
incidental whitespace/encoding drift on bodies that did not need rewriting.

#### Scenario: No match returns the original buffer reference
- **GIVEN** an active rule whose pattern matches nothing in the body
- **WHEN** the engine runs
- **THEN** the returned buffer MUST be referentially identical (`===`) to the
  input buffer

### Requirement: Any rewrite failure MUST fall back to the original body without blocking the request

The engine MUST be wrapped in three layers of failure protection so that no
rewrite-path exception reaches the proxy's request forwarding path:
(1) JSON parse failure of the body, (2) any throw from rule evaluation
(including `RegExp` construction or `replace`), (3) buffer re-encoding failure.
On any such failure, the engine MUST return the original body buffer and MUST
NOT abort, hang, or error the request.

**Rationale:** A sanitization feature must never break request forwarding. The
whole point of opt-in is that the default path is unaffected; "fail-open"
(continue with the original body) is the only safe choice when the user has
opted in but a rule misbehaves.

#### Scenario: Unparseable body falls back unchanged
- **GIVEN** a request body that is not valid JSON
- **WHEN** the engine attempts to parse and rewrite it
- **THEN** it MUST return the original body and the request MUST still be
  forwarded

#### Scenario: A throwing rule falls back unchanged
- **GIVEN** a rule whose `pattern` throws when passed to `new RegExp`
- **WHEN** the engine evaluates it
- **THEN** the engine MUST swallow the error, return the original body, and the
  request MUST still be forwarded

### Requirement: Configuration validation MUST reject unknown keys, unparseable fieldPaths, and unconstructible RegExps

`validateBodyRewrites` MUST reject a `bodyRewrites` array entry when any of:
(a) it contains a key not in
`{id, name, enabled, fieldPath, pattern, flags, replacement}` (unknown key);
(b) `id` is missing or empty / not a string;
(c) `fieldPath` is missing, not a string, or fails the documented grammar;
(d) `pattern` is missing, not a string, or cannot be constructed via
`new RegExp(pattern, flags ?? 'g')`;
(e) `replacement` is missing or not a string;
(f) `flags` is present but not matching `/^[gimsuy]*$/`.
A rejected validation MUST cause `loadConfig` to follow its existing
invalid-config path (back up `config.json.bak` and fall back to default
providers).

**Rationale:** Strict validation turns misconfiguration into a loud, early,
non-forwarding failure rather than a silent mis-rewrite at request time.
Reusing the existing invalid-config recovery path keeps behavior consistent
with how the rest of the config is already protected.

#### Scenario: Unknown key rejected
- **GIVEN** a rule object with an extra key (e.g. `target`)
- **WHEN** configuration is validated
- **THEN** validation MUST reject it

#### Scenario: Empty id rejected
- **GIVEN** a rule whose `id` is `""` or missing
- **WHEN** configuration is validated
- **THEN** validation MUST reject it

#### Scenario: Unconstructible RegExp rejected
- **GIVEN** a rule whose `pattern` is an unterminated group (e.g. `"(unclosed"`)
- **WHEN** configuration is validated
- **THEN** validation MUST reject it

#### Scenario: Invalid fieldPath rejected
- **GIVEN** a rule whose `fieldPath` is `"a[b"` (unterminated bracket) or `""`
- **WHEN** configuration is validated
- **THEN** validation MUST reject it

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

