## ADDED Requirements

### Requirement: Custom provider error paths MUST be verified end-to-end across all configured protocols
The system MUST provide `npm run verify:custom-errors` that exercises the
five-stage chain verification for at least one custom provider across a
representative set of HTTP error status codes returned by the upstream:
200 (baseline, must not be broken by error-path code), 401
(Unauthorized), 429 (Too Many Requests), 500 (Internal Server Error).

For each status code, the verification MUST confirm that the error
response body is forwarded verbatim with the protocol's native error
shape:
- anthropic-messages: `{type: "error", error: {type, message}}`
- openai-chat / openai-responses: `{error: {message, type, code}}`

#### Scenario: 401 Unauthorized forwarded with native error shape
- **WHEN** the mock upstream returns 401 with an anthropic-format error body
- **THEN** the client MUST receive status 401
- **AND** the response body MUST be a JSON object with `type === "error"`
  and `error.type` / `error.message` populated
- **AND** the log entry's `response.status` MUST be 401
- **AND** `/api/logs` MUST return the entry with `response.status === 401`
- **AND** the Web UI log list MUST display status code 401

#### Scenario: 429 Too Many Requests forwarded with native error shape
- **WHEN** the mock upstream returns 429 with an openai-format error body
- **THEN** the client MUST receive status 429
- **AND** the response body MUST be a JSON object with `error.message`
  and `error.code` populated
- **AND** the log entry's `response.status` MUST be 429

#### Scenario: 500 Internal Server Error forwarded with native error shape
- **WHEN** the mock upstream returns 500 with either protocol's error
  format
- **THEN** the client MUST receive status 500
- **AND** the response body MUST be a JSON object with the protocol's
  native error structure
- **AND** the log entry's `response.status` MUST be 500
- **AND** the Web UI log list MUST display status code 500

#### Scenario: 200 OK baseline not broken by error-path code
- **WHEN** the verification also asserts the 200 OK path (baseline)
- **THEN** the client MUST receive a successful response with the
  protocol's native success shape
- **AND** the verification MUST run all four status codes (200/401/429/500)
  to confirm error-path handling did not regress the success path
