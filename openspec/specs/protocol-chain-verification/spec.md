# protocol-chain-verification Specification

## Purpose
TBD - created by archiving change add-anthropic-chain-verification. Update Purpose after archive.
## Requirements
### Requirement: Each protocol MUST be verified end-to-end across five chain stages
The system MUST provide, for each supported protocol (anthropic-messages,
openai-chat, openai-responses), an executable verification script that
exercises five chain stages with real HTTP requests against a real server
process: (1) request composition, (2) real response from a mock upstream,
(3) log recording, (4) `/api/logs` API response, (5) Web UI rendering. All
five stages MUST be asserted; omitting any stage is NOT acceptable.

**Rationale:** The delta bug surfaced in the UI ("page body shows messages:
[]") but only manual inspection caught it. A five-stage chain verification
mechanically asserts every transformation the data undergoes, so a bug at
any stage is caught by the script, not by the user.

#### Scenario: anthropic-messages chain verification script exists
- **WHEN** running `npm run verify:anthropic`
- **THEN** the script MUST exercise five stages (request, response, log,
  API, UI) for both streaming SSE and non-streaming JSON modes
- **AND** the script MUST exit with code 0 on success, non-zero on failure

#### Scenario: All five stages asserted for streaming response
- **GIVEN** a streaming anthropic-messages request
- **WHEN** the verification script runs
- **THEN** it MUST assert the client received the SSE stream
- **AND** assert the log entry has complete `body.messages` and `sse_raw` response
- **AND** assert `/api/logs` returns the entry with complete messages
- **AND** assert the Web UI Request tab renders `request-body` containing "messages"
- **AND** assert the Web UI Context tab renders `context-item` elements with
  correct `data-role` attributes

#### Scenario: All five stages asserted for non-streaming response
- **GIVEN** a non-streaming anthropic-messages request
- **WHEN** the verification script runs
- **THEN** it MUST assert the client received complete JSON
- **AND** assert the log entry `response.body.content[0].text` is preserved
- **AND** assert the Web UI Response tab renders `response-body` containing
  the response content

### Requirement: Both streaming and non-streaming response modes MUST be covered
The verification script MUST exercise both the streaming SSE response mode
and the non-streaming JSON response mode for each protocol. Covering only
one mode is NOT sufficient because the two modes take different code paths
in the interceptor (`handleStreamingResponse` vs `handleNormalResponse`).

**Rationale:** A bug in either path produces a different failure signature.
The delta bug only manifested in non-streaming; a future bug could appear
only in streaming. Both must be asserted.

#### Scenario: Streaming and non-streaming both verified
- **WHEN** the verification script completes successfully
- **THEN** the output MUST show separate assertion groups for the streaming
  mode and the non-streaming mode
- **AND** both groups MUST report PASS

### Requirement: Web UI rendering verification MUST use stable data-testid attributes
The verification script MUST locate rendered elements via `data-testid`
attributes (and auxiliary `data-*` attributes like `data-role`), NOT via
CSS class names, tag text, or DOM structure. This is because the UI uses
`react-json-view-lite` whose class names are CSS-Module hashes that change
between builds, and tag text is locale/UX-dependent.

**Rationale:** DOM selectors based on hashed classes break silently on the
next build. Stable `data-testid` attributes are the contract between the
test and the component, decoupled from styling.

#### Scenario: Verification locates elements by data-testid
- **WHEN** the verification script interacts with the Web UI
- **THEN** it MUST use selectors of the form `[data-testid="..."]` or
  `getByTestId(...)`
- **AND** it MUST NOT use selectors based on hashed CSS classes

### Requirement: Key Web UI components MUST carry stable data-testid attributes
The following components MUST expose `data-testid` attributes so chain
verification can locate them: (1) each log list row with `data-testid="log-row"`
and `data-logid={id}`; (2) the Request tab body container with
`data-testid="request-body"`; (3) the Response tab body container with
`data-testid="response-body"`; (4) each Context tab list item with
`data-testid="context-item"` and `data-role={role}`; (5) each tab switch
button with `data-testid="tab-{tabKey}"`.

**Rationale:** Without these attributes, the verification script cannot
locate rendered data. The attributes are the contract that lets the script
survive UI refactors.

#### Scenario: LogRow exposes data-testid and data-logid
- **WHEN** the Web UI renders a log list row
- **THEN** the row element MUST have `data-testid="log-row"`
- **AND** MUST have `data-logid` equal to the log entry's id

#### Scenario: Request body container exposes data-testid
- **WHEN** the Request tab renders the request body
- **THEN** the body container MUST have `data-testid="request-body"`

#### Scenario: Response body container exposes data-testid
- **WHEN** the Response tab renders the response body
- **THEN** the body container MUST have `data-testid="response-body"`

#### Scenario: Context list items expose data-testid and data-role
- **WHEN** the Context tab renders a message list item
- **THEN** the item MUST have `data-testid="context-item"`
- **AND** MUST have `data-role` equal to the message's role label
  (e.g. `user`, `assistant`, `tool`, `system`)

#### Scenario: Tab switch buttons expose data-testid
- **WHEN** the Web UI renders a tab switch button
- **THEN** the button MUST have `data-testid="tab-{tabKey}"` where tabKey
  is one of `request`, `response`, `kvcache`, `context`, `meta`

### Requirement: OpenAI Chat Completions protocol MUST be verified end-to-end across all five chain stages
The system MUST provide `npm run verify:openai-chat` that exercises the
five chain stages (request, response, log, API, UI) for the OpenAI Chat
Completions protocol, in both streaming SSE and non-streaming JSON modes.

The verification MUST account for the protocol-specific response shape:
streaming uses bare `data:` lines (no `event:` prefix) ending with
`data: [DONE]`; non-streaming returns `choices[0].message.content`.

#### Scenario: OpenAI Chat streaming chain verified
- **WHEN** running `npm run verify:openai-chat` for the streaming mode
- **THEN** the script MUST assert the client received `chat.completion.chunk`
  deltas and a `[DONE]` sentinel
- **AND** assert the log entry has complete `body.messages` and an `sse_raw`
  response
- **AND** assert the Web UI Context tab renders `context-item` elements with
  `data-role="user"` and `data-role="assistant"`

#### Scenario: OpenAI Chat non-streaming chain verified
- **WHEN** running `npm run verify:openai-chat` for the non-streaming mode
- **THEN** the script MUST assert the client received a `chat.completion`
  object with `choices[0].message.content`
- **AND** assert the log entry's `response.body.choices[0].message.content`
  matches the upstream's content
- **AND** assert the Web UI Response tab renders `response-body` containing
  `choices`

### Requirement: OpenAI Responses protocol MUST be verified end-to-end, accounting for its input-based request shape
The system MUST provide `npm run verify:openai-responses` that exercises
the five chain stages for the OpenAI Responses protocol, in both streaming
and non-streaming modes. Because this protocol uses `body.input` (a string
or array) instead of `body.messages`, the verification MUST assert
`body.input` preservation in the log and API, NOT `body.messages`.

The protocol-specific response shape MUST also be asserted: streaming uses
`event: response.output_text.delta` and `event: response.completed`; non-
streaming returns `output[0].content[0].text`. The Context tab assertion
MUST account for the fact that a string `input` is converted to a single
`user` context-item by the extractor.

#### Scenario: OpenAI Responses streaming chain verified with input preservation
- **WHEN** running `npm run verify:openai-responses` for the streaming mode
- **THEN** the script MUST assert the client received
  `response.output_text.delta` and `response.completed` events
- **AND** assert the log entry preserves `body.input` as the original string
  (NOT empty, NOT sliced)
- **AND** assert `/api/logs` returns the entry with `request.body.input`
  intact
- **AND** assert the Web UI Request tab renders `request-body` containing
  `input`

#### Scenario: OpenAI Responses non-streaming chain verified
- **WHEN** running `npm run verify:openai-responses` for the non-streaming mode
- **THEN** the script MUST assert the client received a `response` object
  with `output[0].content[0].text`
- **AND** assert the log entry's `response.body.output[0].content[0].text`
  matches the upstream's text
- **AND** assert the Web UI Response tab renders `response-body` containing
  `output`

#### Scenario: OpenAI Responses Context tab reflects input-to-user conversion
- **WHEN** the request `body.input` is a string and the Context tab renders
- **THEN** the Context tab MUST show at least one `context-item` with
  `data-role="user"` (the input string converted by the extractor)

### Requirement: A custom provider with multiple protocols configured MUST be verified end-to-end across all configured protocols
The system MUST provide `npm run verify:custom` that exercises the
five-stage chain verification for at least one custom provider (named
with `custom/` prefix) that has all three protocols configured. The
verification MUST spin up a single mock upstream capable of serving
all three protocol formats (anthropic-messages, openai-chat,
openai-responses), configure the custom provider with all three
endpoints pointing at the mock upstream, and assert the five stages
across all three protocols × both response modes (SSE + JSON).

**Rationale:** A user typically configures one custom provider to route
multiple model families. The verification must prove that a single
provider config works for all its declared protocols end-to-end, not
just one.

#### Scenario: Custom provider with 3 protocols verified
- **WHEN** running `npm run verify:custom`
- **THEN** the script MUST configure a custom provider with all three
  endpoints (anthropic-messages, openai-chat, openai-responses) pointing
  at a shared mock upstream
- **AND** the script MUST assert the five chain stages for all 2×3×2=12
  protocol-mode combinations (provider counts: target 60 assertion points
  for 1 provider; scaled by provider count for multi-provider scripts)

#### Scenario: Mock upstream serves all three protocol formats
- **WHEN** the script's mock upstream receives a request to `/v1/messages`
- **THEN** it MUST respond with anthropic-format SSE or JSON depending on
  the configured mode
- **WHEN** it receives a request to `/v1/chat/completions`
- **THEN** it MUST respond with openai-chat-format SSE or JSON
- **WHEN** it receives a request to `/v1/responses`
- **THEN** it MUST respond with openai-responses-format SSE or JSON

