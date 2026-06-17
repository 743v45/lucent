## ADDED Requirements

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
