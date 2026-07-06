## ADDED Requirements

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
