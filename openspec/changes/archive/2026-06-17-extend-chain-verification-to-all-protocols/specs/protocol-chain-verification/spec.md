## ADDED Requirements

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
