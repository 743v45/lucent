## ADDED Requirements

### Requirement: Mock fixture MUST be schema-compliant with docs/protocols/ reference
The system MUST require that the mock fixture functions (both shared in
`tests/e2e-helpers.ts` and inline in `scripts/verify-*-e2e.mjs`) produce
responses that match the schema defined in `docs/protocols/
{01-anthropic-messages,02-openai-chat-completions,03-openai-responses}.md`.
Any field documented in the protocol schema MUST be present in the
fixture (with a real value, not omitted), unless the test scenario
specifically requires omission (e.g. error tests that need to verify
field absence).

**Rationale:** The fixture is the contract under test. If the fixture is
simpler than the real protocol, the verification script cannot catch
regressions where product code stops emitting required fields. Earlier
sessions found:
- `openai-responses` SSE fixture emitted only 3 events, missing the
  `response.created`, `output_item.added`, `content_part.added`, etc.
- Anthropic 401 errors returned `type: "invalid_request_error"` instead
  of `"authentication_error"`.
- `usage` fields like `cached_tokens` and `reasoning_tokens` were omitted
  entirely.

#### Scenario: Fixture matches protocol schema for all three protocols
- **WHEN** a developer runs any verify:* script
- **THEN** the upstream mock responses MUST contain all required fields
  per `docs/protocols/` (anthropic message_start including full Usage
  block, openai-chat ChatCompletion including prompt_tokens_details and
  completion_tokens_details, openai-responses Response including status,
  output, usage, output_text)

#### Scenario: OpenAI error response type matches HTTP status
- **WHEN** the mock upstream returns an error response at status 401
- **THEN** the response body MUST have `error.type: "authentication_error"`
  (not `"invalid_request_error"`)
- **WHEN** the mock upstream returns 429
- **THEN** `error.type` MUST be `"rate_limit_error"`
- **WHEN** the mock upstream returns 500
- **THEN** `error.type` MUST be `"api_error"`
