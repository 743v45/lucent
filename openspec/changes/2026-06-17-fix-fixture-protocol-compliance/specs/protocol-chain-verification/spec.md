# protocol-chain-verification Specification Delta

## MODIFIED Requirements

### Requirement: Mock fixtures MUST align field-by-field with docs/protocols/

The system's mock fixture layer (`tests/e2e-helpers.ts`) MUST produce
response and error payloads whose fields match `docs/protocols/` documents
field-by-field, AND MUST NOT exhibit field divergence between sibling
functions within the same file (e.g. `sse-text` vs `sse-tool-use` vs
`sse-thinking` for the same `usage` object).

**Rationale:** Mock fixtures serve as canonical protocol samples. Field
divergence between sibling functions or missing fields vs documentation
degrade the fixture's value as a contract reference, and can trigger
false-positives when downstream SDK parsers or regex validators consume
the mock responses.

#### Scenario: anthropic message_start.usage is uniform across all SSE modes
- **GIVEN** `createMockUpstream({ format: 'anthropic' })` is set to any of
  `sse-text`, `sse-tool-use`, or `sse-thinking` mode
- **WHEN** a `POST /v1/messages` request is made
- **THEN** the `message_start.message.usage` object MUST contain all fields
  documented in `docs/protocols/01-anthropic-messages.md` § 2 Usage
  (`input_tokens`, `output_tokens`, `cache_creation_input_tokens`,
  `cache_read_input_tokens`, `cache_creation`, `inference_geo`,
  `output_tokens_details`, `server_tool_use`, `service_tier`)
- **AND** the field set MUST be identical across all three SSE modes

#### Scenario: anthropic thinking block emits signature_delta
- **GIVEN** a streaming thinking response from the anthropic mock
- **WHEN** the thinking content block is closing
- **THEN** the stream MUST emit a `content_block_delta` with
  `delta.type = 'signature_delta'` before `content_block_stop`
- **AND** the `content_block_start.content_block` for type `thinking` MUST
  include a `signature` field (per `docs/protocols/01` § 3 + SDK
  `ThinkingBlock` interface)

#### Scenario: anthropic error request_id matches documented format
- **GIVEN** `createMockUpstream({ format: 'anthropic' })` returns any
  error status (400/401/429/500)
- **WHEN** the error response body is parsed
- **THEN** `request_id` MUST match the regex `^req_[A-Za-z0-9]{24}# protocol-chain-verification Specification Delta

## MODIFIED Requirements

### Requirement: Mock fixtures MUST align field-by-field with docs/protocols/

The system's mock fixture layer (`tests/e2e-helpers.ts`) MUST produce
response and error payloads whose fields match `docs/protocols/` documents
field-by-field, AND MUST NOT exhibit field divergence between sibling
functions within the same file (e.g. `sse-text` vs `sse-tool-use` vs
`sse-thinking` for the same `usage` object).

**Rationale:** Mock fixtures serve as canonical protocol samples. Field
divergence between sibling functions or missing fields vs documentation
degrade the fixture's value as a contract reference, and can trigger
false-positives when downstream SDK parsers or regex validators consume
the mock responses.

#### Scenario: anthropic message_start.usage is uniform across all SSE modes
- **GIVEN** `createMockUpstream({ format: 'anthropic' })` is set to any of
  `sse-text`, `sse-tool-use`, or `sse-thinking` mode
- **WHEN** a `POST /v1/messages` request is made
- **THEN** the `message_start.message.usage` object MUST contain all fields
  documented in `docs/protocols/01-anthropic-messages.md` § 2 Usage
  (`input_tokens`, `output_tokens`, `cache_creation_input_tokens`,
  `cache_read_input_tokens`, `cache_creation`, `inference_geo`,
  `output_tokens_details`, `server_tool_use`, `service_tier`)
- **AND** the field set MUST be identical across all three SSE modes

#### Scenario: anthropic thinking block emits signature_delta
- **GIVEN** a streaming thinking response from the anthropic mock
- **WHEN** the thinking content block is closing
- **THEN** the stream MUST emit a `content_block_delta` with
  `delta.type = 'signature_delta'` before `content_block_stop`
- **AND** the `content_block_start.content_block` for type `thinking` MUST
  include a `signature` field (per `docs/protocols/01` § 3 + SDK
  `ThinkingBlock` interface)

#### Scenario: anthropic error request_id matches documented format
- **GIVEN** `createMockUpstream({ format: 'anthropic' })` returns any
  error status (400/401/429/500)
- **WHEN** the error response body is parsed

  (per `docs/protocols/01` § 4 format, official example
  `req_011CSHoEeqs5C35K2UUqR7Fy` = `req_` + 24 base62 chars)

#### Scenario: openai chat tool_calls chunk includes service_tier
- **GIVEN** `createMockUpstream({ format: 'openai' })` in `chat-tool-calls`
  mode
- **WHEN** the final chunk (the one carrying `usage` and `finish_reason`)
  is emitted
- **THEN** the chunk MUST include `service_tier`, matching the behavior
  of `chat-sse` mode's final chunk

#### Scenario: openai Responses SSE response.created/completed carry full Response
- **GIVEN** `createMockUpstream({ format: 'openai' })` in `responses-sse`
  mode
- **WHEN** `response.created` event is parsed
- **THEN** its `response` payload MUST be a complete `Response` object per
  `docs/protocols/03` § 2, with `status = 'in_progress'`, `completed_at = null`,
  `output = []`, and all 32 documented top-level fields present
- **AND WHEN** `response.completed` event is parsed
- **THEN** its `response` payload MUST be a complete `Response` object with
  `status = 'completed'`, a numeric `completed_at`, non-empty `output`,
  and `output_text` equal to the concatenation of all `output_text` parts
