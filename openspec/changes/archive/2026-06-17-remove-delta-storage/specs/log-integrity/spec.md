## ADDED Requirements

### Requirement: Request body MUST be logged verbatim, without any delta encoding, truncation, or slicing
The system SHALL log every request's `body` field exactly as received, with
no modification by delta storage, message slicing, checkpoint logic, or any
other space-optimization that alters the original body. The logged
`body.messages` (for anthropic-messages and openai-chat protocols) MUST
reflect the complete array sent by the client, regardless of how many
similar requests preceded it.

**Rationale:** The previous delta-storage mechanism used module-level global
state shared across protocols, providers, and sessions, causing
cross-contamination that emptied `body.messages` in the logs. It had zero
consumers (no UI rebuild, no KV cache use). Logging the body verbatim is
the only correct behavior given HTTP's stateless nature.

#### Scenario: Two consecutive identical requests both log complete body
- **GIVEN** a provider with `anthropic-messages` endpoint configured
- **WHEN** the client sends `POST /custom/hxy/v1/messages` with
  `body.messages` containing 2 messages
- **AND** the client immediately sends the same request again with identical
  `body.messages`
- **THEN** the log entry for the first request MUST have `body.messages`
  with length 2
- **AND** the log entry for the second request MUST have `body.messages`
  with length 2 (NOT 0, NOT truncated)

#### Scenario: Cross-protocol requests do not contaminate each other's logs
- **GIVEN** a provider serving both `anthropic-messages` and `openai-chat`
- **WHEN** the client sends an anthropic-messages request with 5 messages
- **AND** then sends an openai-chat request with 3 messages
- **THEN** the anthropic log entry MUST have `body.messages.length === 5`
- **AND** the openai-chat log entry MUST have `body.messages.length === 3`

#### Scenario: Cross-provider requests do not contaminate each other's logs
- **GIVEN** two providers `hxy` and `zhipu`, both with anthropic-messages
- **WHEN** the client sends a request via `hxy` with 10 messages
- **AND** then sends a request via `zhipu` with 2 messages
- **THEN** the `hxy` log entry MUST have `body.messages.length === 10`
- **AND** the `zhipu` log entry MUST have `body.messages.length === 2`

### Requirement: Log entries MUST NOT carry delta-encoding metadata fields
The system SHALL NOT write any of the following fields to log entries:
`_deltaFormat`, `_isCheckpoint`, `_totalMessageCount`, `_conversationId`
(when used as a delta tag), `_inPlaceReplaceDetected`. These fields were
artifacts of the removed delta-storage mechanism and have no consumers.

**Rationale:** Leaving dead metadata in logs creates confusion (readers may
think the data is delta-encoded and needs rebuilding) and bloats the log
files for no benefit.

#### Scenario: Fresh log entry has no delta metadata
- **WHEN** the interceptor logs a new request entry
- **THEN** the entry MUST NOT contain any of: `_deltaFormat`,
  `_isCheckpoint`, `_totalMessageCount`, `_inPlaceReplaceDetected`
- **AND** the entry MUST NOT contain `_conversationId` as a delta tag
  (the unrelated `threadId` field is unaffected and may be present)
