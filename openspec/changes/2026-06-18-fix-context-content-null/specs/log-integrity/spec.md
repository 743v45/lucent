## ADDED Requirements

### Requirement: Context extractors MUST normalize every message content to string or ContentBlock[], never null/undefined
The system SHALL normalize every extracted context message's `content`
so that it is always either a `string` or a `ContentBlock[]`, never
`null` or `undefined`. The three protocol context extractors
(`extractAnthropicMessages`, `extractOpenAIChat`,
`extractOpenAIResponses`) SHALL substitute an empty array `[]` whenever
the upstream message's `content` is `null` or `undefined` — which is
valid for an OpenAI Chat assistant message that issues `tool_calls`,
and may also occur on OpenAI Responses input items.

The system SHALL NOT pass `null` or `undefined` through into
`log.context.messages[*].content`. This honors the existing
`ContextMessage.content: string | ContentBlock[]` type contract
(`src/types.ts`), which all downstream consumers (the Web UI
`ContextTab`, KV-cache extraction, summary counters) rely on to call
`.map()` / `.length` without null-guarding.

**Rationale:** OpenAI Chat's API spec allows an assistant message to
omit `content` (set it to `null`) when the turn consists solely of a
`tool_calls` array. The Anthropic extractor already normalized this
case to `[]`, but the two OpenAI extractors passed `content` through
verbatim. The raw `null` then reached `DetailPanel.tsx`'s
`ContextTab.getSelectedContent()`, which only branched on
`typeof content === 'string'` before calling `.map()` on the assumed
array — throwing `Cannot read properties of undefined (reading 'map')`
and white-screening the entire detail panel whenever the user clicked
such an assistant message. Normalizing at the extractor (the source)
fixes the root cause for all consumers; the frontend additionally
gains an `Array.isArray` guard as defense-in-depth against unmigrated
historical log snapshots.

#### Scenario: OpenAI Chat assistant message with content null (tool_calls turn) normalizes to empty array
- **GIVEN** a provider with `openai-chat` endpoint configured
- **AND** the client sends `POST /v1/chat/completions` whose
  `body.messages` contains an assistant message
  `{ role: 'assistant', content: null, tool_calls: [...] }`
- **WHEN** `extractContext` (or `extractOpenAIChat` directly) processes
  the body
- **THEN** the extracted `messages[i].content` MUST equal `[]`
- **AND** MUST NOT be `null` or `undefined`

#### Scenario: OpenAI Responses input item with missing content normalizes to empty array
- **GIVEN** a provider with `openai-responses` endpoint configured
- **AND** the client sends `POST /v1/responses` whose `body.input` is
  an array containing an item `{ type: 'message', role: 'assistant' }`
  with no `content` field (i.e. `content === undefined`)
- **WHEN** `extractContext` (or `extractOpenAIResponses` directly)
  processes the body
- **THEN** the extracted `messages[i].content` MUST equal `[]`
- **AND** MUST NOT be `null` or `undefined`

#### Scenario: Anthropic assistant message with content null still normalizes to empty array (unchanged)
- **GIVEN** a provider with `anthropic-messages` endpoint configured
- **AND** the client sends `POST /v1/messages` whose `body.messages`
  contains `{ role: 'assistant', content: null }`
- **WHEN** `extractAnthropicMessages` processes the body
- **THEN** the extracted `messages[i].content` MUST equal `[]`
  (preserving the pre-existing normalization behavior)

#### Scenario: Normal string and array content pass through unchanged
- **GIVEN** any of the three protocols
- **AND** a message whose `content` is a non-null string or a non-empty
  `ContentBlock[]`
- **WHEN** the corresponding extractor processes the body
- **THEN** the extracted `messages[i].content` MUST be byte-equal to the
  original `content` value (no wrapping, no coercion)
