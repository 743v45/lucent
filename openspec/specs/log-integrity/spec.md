# log-integrity Specification

## Purpose
TBD - created by archiving change remove-delta-storage. Update Purpose after archive.
## Requirements
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

### Requirement: Log file format MUST be standard JSON Lines with no secondary separator escaping
The system SHALL write each log entry as exactly one line of JSON
terminated by a single `\n`. The JSON serializer's built-in escaping
(which converts literal newlines inside string values to the
two-character sequence `\n`) is the ONLY escaping layer applied. The
system SHALL NOT introduce any secondary separator-escaping layer —
specifically, functions named `escapeLogContent` / `unescapeLogContent`,
the constant `LOG_ENTRY_SEPARATOR` (`'\n---\n'`), and the regex
`LOG_SPLIT_REGEX` (`/\n---\n?/`) MUST NOT exist.

The reader SHALL split log files on `\n` and `JSON.parse` each
non-empty line directly, without any pre-parse string transformation.

**Rationale:** A separator-based escaping layer applied after
`JSON.stringify` (on write) and reverted before `JSON.parse` (on read)
fundamentally conflicts with JSON's own escaping. When a request body
contains a markdown / YAML frontmatter block (which begins with the
literal four-character sequence `\n---\n`), the secondary escaping
corrupts the JSON string value: `JSON.parse` then fails with "Bad
control character in string literal", and the silently-caught failure
drops that entry AND every subsequent entry in the file from the Web UI.
Standard JSONL — one JSON value per line — eliminates the conflict
entirely because `JSON.stringify` guarantees no literal newline can
appear inside any string value.

#### Scenario: Log entry whose body contains markdown frontmatter round-trips intact
- **GIVEN** a provider with `openai-chat` endpoint configured
- **AND** the client sends a request whose `body.messages[0].content`
  contains the literal string `Pre text\n---\ntitle: "SOUL.md"\n---\nPost text`
  (i.e. a YAML / markdown frontmatter delimiter)
- **WHEN** the interceptor logs the entry and the reader reads it back
- **THEN** the read-back `body.messages[0].content` MUST be byte-equal to
  the original string
- **AND** the entry MUST appear in `/api/logs` results (not silently dropped)

#### Scenario: Log entry whose body contains a literal separator-like sequence round-trips intact
- **GIVEN** a request whose `body.messages[0].content` contains the
  substring `\n---\n` appearing twice, separated by other text
- **WHEN** the entry is written and read back
- **THEN** both occurrences MUST be preserved in the read-back content
- **AND** the entry MUST NOT be split into multiple log entries

#### Scenario: Each log entry occupies exactly one physical line
- **WHEN** the writer appends a `RawLogEntry` to the current log file
- **THEN** the appended bytes MUST be exactly
  `JSON.stringify(entry) + '\n'`
- **AND** MUST NOT contain any literal `\n` outside of the trailing
  terminator (all newlines inside string values are JSON-escaped)
- **AND** MUST NOT be wrapped with any `---` separator

#### Scenario: Reader parses every well-formed line independently
- **GIVEN** a log file in the new JSONL format containing N entries
- **WHEN** the reader splits the file and parses each non-empty line
- **THEN** every line that is valid JSON MUST yield one `LogEntry`
- **AND** a parse failure on one line MUST NOT affect parsing of
  subsequent lines

