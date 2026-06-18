# protocol-chain-verification Specification Delta

## MODIFIED Requirements

### Requirement: Verify scripts MUST use single fixture source + schema validation

The system's end-to-end verify scripts (scripts/verify-*.ts) MUST source all
mock fixtures from `tests/e2e-helpers.ts` via `createMockUpstream`, and MUST
NOT maintain inline fixture definitions. Each verify script MUST include at
least one schema validation check per protocol per mode, using the
`validate*Body()` functions from helpers.ts.

**Rationale:** Inline fixture duplication caused 21 field divergences between
verify scripts and helpers.ts. Assertion granularity (keyword-exists only)
masked these divergences — "234/234 pass" was a false green. Schema validation
assertions verify field completeness, not just keyword presence.

#### Scenario: verify scripts use createMockUpstream not inline fixtures
- **GIVEN** any of the 5 verify scripts (verify-anthropic/chat/responses/custom/custom-errors)
- **WHEN** the script sets up its mock upstream
- **THEN** it MUST call `createMockUpstream({ format: ... })` from helpers.ts
- **AND** MUST NOT define its own `createServer` + inline SSE/JSON fixture functions
- **AND** for multi-protocol scripts, MUST use `format: 'auto'` (URL-based dispatch)

#### Scenario: each protocol+mode combo has schema validation
- **GIVEN** a verify script testing protocol P in mode M (sse or json)
- **WHEN** the response is received
- **THEN** the script MUST call the corresponding `validate*Body()` function
  (validateAnthropicBody / validateOpenAIChatBody / validateOpenAIResponsesBody)
- **AND** MUST `check()` the `.ok` field, surfacing `.errors[]` on failure
- **AND** the validation MUST verify field completeness (required fields present
  with correct types), not just keyword existence

#### Scenario: schema validation catches fixture regressions
- **GIVEN** a fixture function in helpers.ts is modified to drop a required field
- **WHEN** any verify script consuming that fixture runs
- **THEN** the schema check MUST fail with a specific error naming the missing field
- **AND** the failure MUST propagate to the script's exit code (non-zero)

#### Scenario: openai error type maps by HTTP status
- **GIVEN** a verify script tests openai error responses (401/429/500)
- **WHEN** the error body is validated
- **THEN** `error.type` MUST follow the status mapping (401→authentication_error,
  429→rate_limit_error, 500→api_error), not be hardcoded to invalid_request_error
- **AND** `error.param` MUST be present (null is acceptable)

### Requirement: UI default SSE view MUST show complete event chain

The system's Response tab, when displaying an SSE response, MUST default to
the "raw" view showing the complete event chain (including ping, error, and
other meta events), with a toggle available to switch to the "extracted"
structured view.

**Rationale:** The previous default ("extracted") silently dropped ping/error
and other non-extracted events, giving users an incomplete picture of the
actual SSE stream. The raw view is the ground truth.

#### Scenario: SSE response defaults to raw view
- **GIVEN** a log entry with an SSE response body (`type: 'sse_raw'`)
- **WHEN** the user opens the Response tab
- **THEN** the default view MUST be "raw" (complete event text)
- **AND** all events including ping/error/meta MUST be visible without user action
- **AND** a toggle MUST allow switching to the "extracted" structured view

### Requirement: SSE reasoning extraction MUST cover all three protocols

The system's SSE extraction logic (`extractFromEvent`) MUST extract reasoning
content for all three protocols (anthropic, openai-chat, openai-responses),
covering both standard and compatibility variant event formats.

#### Scenario: openai-chat reasoning is extracted
- **GIVEN** an openai-chat SSE chunk with `choices[0].delta.reasoning_content`
  or `choices[0].delta.reasoning`
- **WHEN** the chunk is processed by `extractFromEvent`
- **THEN** the reasoning text MUST be accumulated into `acc.thinking`

#### Scenario: openai-responses standard reasoning is extracted
- **GIVEN** an openai-responses SSE event with `type: 'response.reasoning.delta'`
- **WHEN** the event is processed
- **THEN** the delta text MUST be accumulated into `acc.thinking`
- **AND** the existing compatibility variant `response.reasoning_text.delta`
  MUST continue to be supported
