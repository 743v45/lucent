## ADDED Requirements

### Requirement: The project MUST ship a record:newapi script that drives a real reasoning-model upstream through the Lucent proxy and records a demo
The system MUST provide a script at `scripts/record-newapi-e2e.ts` exposed via
`npm run record:newapi` that starts the real Lucent backend (proxy + Web UI),
points a client base URL at the Lucent proxy (NOT directly at the upstream),
and sends real requests through the proxy to a live reasoning-model upstream.
The script MUST cover both OpenAI endpoint types (`openai-chat` and
`openai-responses`), each in both non-streaming and streaming modes, record a
`.webm` demo via Playwright, and exit with code `0` on success or non-zero on
failure.

**Rationale:** This is the canonical "did the real chain actually answer"
acceptance + demo artifact for Lucent. Driving through the proxy (not direct
to upstream) is what proves Lucent is in the path; covering all four
mode/endpoint combos is what proves both OpenAI endpoints work end to end.

#### Scenario: npm script present
- **WHEN** reading `package.json`
- **THEN** the `scripts` object MUST contain a `record:newapi` key whose value
  runs `scripts/record-newapi-e2e.ts`

#### Scenario: Requests go through the Lucent proxy, not direct to upstream
- **WHEN** the script sends its acceptance requests
- **THEN** the client base URL MUST point at the Lucent proxy port
- **AND** the resulting Lucent log entries MUST show `provider=openai` and the
  relevant endpoint (`openai-chat` / `openai-responses`), proving Lucent is in
  the path rather than the client hitting the upstream directly

#### Scenario: All four endpoint/mode combos are exercised
- **WHEN** the script runs to completion
- **THEN** it MUST send at least one `openai-chat` non-streaming request, one
  `openai-chat` streaming request, one `openai-responses` non-streaming request,
  and one `openai-responses` streaming request

#### Scenario: Script exits non-zero on failure
- **WHEN** any assertion scenario fails
- **THEN** the script MUST exit with a non-zero code

### Requirement: The record:newapi script MUST run fully isolated and MUST NOT touch the user's Lucent config
The script MUST create a fresh temporary directory for `LUCENT_CONFIG_DIR`
(e.g. via `mkdtempSync`), use random high ports for the proxy and Web UI, write
its provider configuration only into that temporary directory, and MUST NOT
read or write `~/.lucent/config.json`.

**Rationale:** The script drives a real upstream with a real key; it must be
safe to run on any developer/agent machine without mutating or leaking the
user's own provider configuration. This mirrors the isolation contract of
`e2e-verification`'s `verify-e2e.mjs`.

#### Scenario: Temporary config directory is used
- **WHEN** the script runs
- **THEN** `LUCENT_CONFIG_DIR` MUST point at a freshly created temporary
  directory
- **AND** the script MUST NOT read or write `~/.lucent/config.json`

#### Scenario: Random high ports avoid collisions
- **WHEN** the script starts the backend
- **THEN** the proxy and Web UI ports MUST be chosen at runtime (randomized
  high ports), not hardcoded to fixed values

### Requirement: The record:newapi script MUST read the API key only from the environment and MUST NEVER persist or hand it to the proxy process
The script MUST obtain the upstream API key solely from
`process.env.OPENAI_API_KEY` and MUST fail fast with a non-zero exit code when
that variable is unset. The key MUST NOT appear as a literal in the script,
MUST NOT be written into any config file or log, and MUST NOT be committed to
the repository. Because Lucent is a transparent proxy that does not need a
client key, the script MUST strip `OPENAI_API_KEY` from the environment passed
to the spawned Lucent backend process; the key MUST live only in the driver's
outgoing `Authorization` header.

**Rationale:** The key is a secret. Hardcoding, persisting, or leaking it into
the proxy process or git would be a credential exposure. Keeping it scoped to
the driver's request header is the minimum surface that still works.

#### Scenario: Key is read from the environment
- **WHEN** the script runs
- **THEN** the upstream key MUST come from `process.env.OPENAI_API_KEY`

#### Scenario: Missing key fails fast
- **GIVEN** `OPENAI_API_KEY` is unset
- **WHEN** the script starts
- **THEN** the script MUST print a usage hint and exit with a non-zero code
  before sending any request

#### Scenario: The proxy process does not receive the key
- **WHEN** the script spawns the Lucent backend
- **THEN** the backend process environment MUST NOT contain `OPENAI_API_KEY`
- **AND** the key MUST appear only in the driver's `Authorization: Bearer ...`
  request header

#### Scenario: No plaintext key in the repository
- **WHEN** inspecting the script and its git diff
- **THEN** no plaintext API key (`sk-...`) MUST be present

### Requirement: End-to-end acceptance against a reasoning model MUST assert actual answer content, not merely HTTP 200 with a non-empty body
When a reasoning-model upstream is starved of `max_tokens`, it spends the whole
budget on reasoning and returns `finish_reason=length` with an empty `content`
string — yet the HTTP response is still `200` with a non-empty JSON envelope.
Therefore the record:newapi script (and any reasoning-model e2e acceptance)
MUST assert that the model actually produced answer content; a check of only
`status === 200 && body non-empty` is forbidden because it passes on this
"empty answer" failure mode. Per mode, the content assertion MUST be:
non-streaming `openai-chat` asserts `choices[0].message.content` is a non-empty
string AND `choices[0].finish_reason !== 'length'`; non-streaming
`openai-responses` asserts a non-empty `output_text`; streaming
(`openai-chat` / `openai-responses`) asserts `frames > 0` AND at least one
content delta frame (not reasoning-only). These assertions MUST drive the
script's exit code.

**Rationale:** This is the lesson crystallized by this change. The issue
background explicitly names the `max_tokens`-starvation failure mode
(`finish_reason=length` + empty content + HTTP 200). The previous loose
assertion (`200 + body non-empty`) let exactly that bug through; only asserting
actual content catches it.

#### Scenario: Non-streaming chat asserts non-empty content and no length truncation
- **GIVEN** a non-streaming `openai-chat` response
- **WHEN** the script evaluates it
- **THEN** it MUST require `choices[0].message.content` to be a non-empty
  trimmed string
- **AND** MUST require `choices[0].finish_reason !== 'length'`

#### Scenario: Non-streaming responses asserts non-empty output_text
- **GIVEN** a non-streaming `openai-responses` response
- **WHEN** the script evaluates it
- **THEN** it MUST require a non-empty `output_text` string in the output

#### Scenario: Streaming asserts at least one content delta
- **GIVEN** a streaming `openai-chat` or `openai-responses` response
- **WHEN** the script evaluates it
- **THEN** it MUST require `frames > 0` AND at least one content delta frame
- **AND** MUST NOT pass on a reasoning-only stream with zero content deltas

#### Scenario: A starved / empty answer fails the run
- **GIVEN** a response whose content is empty or truncated to `finish_reason=length`
- **WHEN** the script evaluates it
- **THEN** the content assertion MUST fail
- **AND** the script MUST exit with a non-zero code
