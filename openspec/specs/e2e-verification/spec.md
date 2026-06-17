# e2e-verification Specification

## Purpose
TBD - created by archiving change add-e2e-verification-toolkit. Update Purpose after archive.
## Requirements
### Requirement: The project MUST ship an end-to-end verification script that starts the real server and exercises HTTP behavior
The system MUST provide a script at `scripts/verify-e2e.mjs` that spawns the
actual server process (via `tsx server/index.ts`), starts a mock upstream
that records received requests, sends real HTTP requests through the proxy,
and asserts what the mock upstream received. The script MUST run in an
isolated environment (temporary config directory, random high ports) so it
does not touch `~/.lucent/config.json`.

**Rationale:** `openspec/specs/verification-workflow/spec.md` Requirement 3
requires runtime-affecting changes to be verified end-to-end against a real
process. Without a checked-in script, every such verification is a one-off
that gets thrown away. The script makes the rule operational.

#### Scenario: Running the script standalone
- **WHEN** a developer or agent runs `node scripts/verify-e2e.mjs` (or
  `npm run verify:e2e`)
- **THEN** the script starts the real server, runs all assertion scenarios,
  prints a summary, and exits with code `0` on success or non-zero on failure

#### Scenario: Script does not touch user config
- **WHEN** the script runs
- **THEN** the script MUST use a temporary directory for `LUCENT_CONFIG_DIR`
  that is created fresh and removed on exit
- **AND** the script MUST NOT read or write `~/.lucent/config.json`

### Requirement: The verification script MUST cover preset-provider proxy forwarding across all three endpoint types
The script MUST assert that requests through preset providers (named without
`custom/` prefix) reach the upstream with the correct composed path. The
coverage MUST include all three endpoint types:
`anthropic-messages`, `openai-chat`, and `openai-responses`.

**Rationale:** These three are the canonical protocols; each has its own
path-suffix rule (`/messages`, `/chat/completions`, `/responses`). A bug
in any one of them must be caught by the verification.

#### Scenario: Anthropic preset proxy forwarding
- **GIVEN** a preset provider with `anthropic-messages` endpoint `https://api.anthropic.com/v1` (mocked)
- **WHEN** the script sends `POST /anthropic/v1/messages` through the proxy
- **THEN** the mock upstream MUST receive `POST /v1/messages`
- **AND** the upstream URL MUST NOT contain `/v1/v1/`

#### Scenario: OpenAI Chat preset proxy forwarding
- **GIVEN** a preset provider with `openai-chat` endpoint `https://api.openai.com/v1` (mocked)
- **WHEN** the script sends `POST /openai/v1/chat/completions` through the proxy
- **THEN** the mock upstream MUST receive `POST /v1/chat/completions`

#### Scenario: OpenAI Responses preset proxy forwarding
- **GIVEN** a preset provider with `openai-responses` endpoint `https://api.openai.com/v1` (mocked)
- **WHEN** the script sends `POST /openai/v1/responses` through the proxy
- **THEN** the mock upstream MUST receive `POST /v1/responses`

### Requirement: The verification script MUST cover custom-provider forwarding and the /v1-prefix tolerance
The script MUST assert that requests through custom providers (named with
`custom/` prefix) reach the upstream correctly, AND that the proxy tolerates
both the `/v1`-prefixed and the non-prefixed downstream paths (resolving to
the same upstream URL).

**Rationale:** Downstream clients (Claude Code, Codex, OpenCode) disagree
on whether to send `/v1/messages` or `/messages`. The proxy MUST accept
both. This is a historical source of bugs.

#### Scenario: Custom provider forwarding with /v1 prefix
- **GIVEN** a custom provider `foo` with baseUrl ending in `/v1`
- **WHEN** the script sends `POST /custom/foo/v1/messages`
- **THEN** the mock upstream MUST receive `POST /v1/messages`

#### Scenario: Custom provider forwarding without /v1 prefix
- **GIVEN** a custom provider `foo` with baseUrl ending in `/v1`
- **WHEN** the script sends `POST /custom/foo/messages`
- **THEN** the mock upstream MUST receive `POST /v1/messages`
- **AND** the received path MUST equal the path from the `/v1`-prefixed scenario

### Requirement: The verification script MUST cover the test-connection endpoint for all three endpoint types and assert no /v1 duplication
The script MUST exercise the `POST /api/providers/:name/test` endpoint for
`anthropic-messages`, `openai-chat`, and `openai-responses`, and assert
that the composed probe URL does NOT contain a duplicated version segment
(e.g. `/v1/v1/`).

**Rationale:** The `/v1/v1/messages` bug was the original trigger for this
whole verification effort. It must be locked in.

#### Scenario: Test-connection for Anthropic Messages
- **GIVEN** a provider with `anthropic-messages` endpoint `https://api.anthropic.com/v1` (mocked)
- **WHEN** the script calls `POST /api/providers/<name>/test` with body `{"endpointType":"anthropic-messages"}`
- **THEN** the mock upstream MUST receive `POST /v1/messages`
- **AND** the received URL MUST NOT contain `/v1/v1/`

#### Scenario: Test-connection for OpenAI Chat
- **GIVEN** a provider with `openai-chat` endpoint `https://api.openai.com/v1` (mocked)
- **WHEN** the script calls `POST /api/providers/<name>/test` with body `{"endpointType":"openai-chat"}`
- **THEN** the mock upstream MUST receive `POST /v1/chat/completions`
- **AND** the received URL MUST NOT contain `/v1/v1/`

#### Scenario: Test-connection for OpenAI Responses
- **GIVEN** a provider with `openai-responses` endpoint `https://api.openai.com/v1` (mocked)
- **WHEN** the script calls `POST /api/providers/<name>/test` with body `{"endpointType":"openai-responses"}`
- **THEN** the mock upstream MUST receive `POST /v1/responses`
- **AND** the received URL MUST NOT contain `/v1/v1/`

### Requirement: The verification script MUST assert test-connection and proxy-forwarding produce identical upstream paths
For each endpoint type, the script MUST send one request through the proxy
forwarding path and one through the test-connection path, and assert the two
resulting upstream URLs are byte-for-byte identical.

**Rationale:** The test-connection endpoint exists to verify the proxy can
reach the upstream. If it composes a different URL than the proxy will later
send, the test is meaningless. This cross-check is the canonical guard
against that class of bug.

#### Scenario: Identical paths across both code paths
- **WHEN** the script sends the same logical request through both the
  proxy forwarding path and the test-connection path
- **THEN** the mock upstream MUST record the same `url` for both
- **AND** the script MUST fail (non-zero exit) if they differ

### Requirement: The verification script MUST assert 404 behavior for unknown providers and unconfigured endpoints
The script MUST verify that requests to a non-existent provider, or to a
provider whose relevant endpoint is `null`, return HTTP 404.

**Rationale:** A misrouted request silently hitting the wrong upstream is a
worse failure than a 404. The 404 boundary must be explicit.

#### Scenario: Unknown provider returns 404
- **WHEN** the script sends a request to a provider name that does not exist
- **THEN** the proxy MUST respond with status `404`

#### Scenario: Unconfigured endpoint returns 404
- **GIVEN** a provider whose `openai-chat` endpoint is `null`
- **WHEN** the script sends `POST /<name>/v1/chat/completions` through the proxy
- **THEN** the proxy MUST respond with status `404`

### Requirement: The verification script MUST be runnable via an npm script and documented in README
The project MUST expose `npm run verify:e2e` as the canonical entry point
for the script, and the README MUST contain a section explaining when to run
the script, how to run it, and how to read the output.

**Rationale:** A script no one knows about is a script that doesn't exist.
The npm entry + README section make the workflow discoverable.

#### Scenario: npm script present
- **WHEN** reading `package.json`
- **THEN** the `scripts` object MUST contain a `verify:e2e` key whose value
  runs `scripts/verify-e2e.mjs`

#### Scenario: README documents the workflow
- **WHEN** reading `README.md`
- **THEN** the document MUST contain a section titled "端到端验收" (or
  equivalent) that describes the script, when to run it, and how to
  interpret its output

### Requirement: The verification script MUST assert that logged request bodies are complete (no delta truncation)
The script MUST send at least two consecutive requests through the same
provider/endpoint and assert that the resulting log entries each contain
the complete `body.messages` array (matching what the client sent), with
no truncation, slicing, or emptying. This guards against regressions of
the delta-storage bug removed in the `remove-delta-storage` change.

**Rationale:** The delta-storage bug emptied `body.messages` in the logs
and was only caught by manual inspection. The verification script must
mechanically assert log completeness so this class of bug cannot recur
silently.

#### Scenario: Two consecutive identical requests both log complete body
- **GIVEN** the script has sent two consecutive requests to the same
  custom provider with `body.messages` containing N messages
- **WHEN** the script reads the latest log file
- **THEN** the two most recent entries for that provider MUST each have
  `body.messages.length === N`
- **AND** the script MUST fail (non-zero exit) if either entry has an
  empty or truncated `body.messages`

### Requirement: The verification script MUST assert that log entries carry no delta-encoding metadata
The script MUST scan all log entries produced during the run and assert
that none of them contain any of the following fields:
`_deltaFormat`, `_isCheckpoint`, `_totalMessageCount`, `_conversationId`
(when used as a delta tag), `_inPlaceReplaceDetected`. These fields were
artifacts of the removed delta-storage mechanism and MUST NOT reappear.

**Rationale:** Dead metadata in logs creates confusion (readers may
believe the data is delta-encoded) and signals that delta logic has
crept back in. The verification script must catch any reintroduction.

#### Scenario: Fresh run produces no delta metadata
- **WHEN** the script reads the log file produced during the run
- **THEN** no entry MUST contain any of the five delta-encoding fields
- **AND** the script MUST fail (non-zero exit) if any entry has any of
  them

