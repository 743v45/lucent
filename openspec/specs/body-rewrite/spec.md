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

