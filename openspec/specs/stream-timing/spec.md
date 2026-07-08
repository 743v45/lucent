# stream-timing Specification

## Purpose
流式响应的首 token 时延（TTFT，分思考 / 回答）、修正后的全量 `duration`、生成吞吐
tokens/s 的测量契约。规定：TTFT 在后台 tee 副本流上测（不碰客户端透传主链路）、时钟
起点取客户端请求到达代理、三协议 token-bucket 判定单源（生命周期/结构事件排除）、
`duration` 统一为「请求到达 → 响应体完全消费」、tokens/s 流式专属，以及对应的日志字段、
读取透传与 UI 暴露。

## Requirements

### Requirement: TTFT MUST be measured on the tee'd background SSE stream, never on the client passthrough path
The system SHALL measure time-to-first-token timing inside the background SSE
collector (`server/sse-extractor.ts` `collectSSELinesInBackground`), which
consumes the tee'd copy of the streaming response. The system MUST NOT add
any timing instrumentation to the client-facing passthrough pipeline in
`server/proxy.ts` (the `pipeline(nodeStream, res)` path remains untouched).

**Rationale:** The whole point of the tee'd background collector is that
recording/analysis happens off the hot path. Measuring TTFT there adds zero
latency and zero correctness risk to the transparent proxy. The two tee
branches share the same upstream socket, so the background stream's first
content-event time is an excellent proxy for the client-perceived first token
(the dominant term is upstream prefill, hundreds of ms to seconds; tee
scheduling skew is sub-millisecond).

#### Scenario: No timing code on the passthrough pipeline
- **WHEN** inspecting the streaming branch of `server/proxy.ts`
- **THEN** the `pipeline(nodeStream, res, ...)` call MUST remain a plain
  passthrough
- **AND** MUST NOT be wrapped in any per-chunk timing/peek logic introduced by
  this change

#### Scenario: TTFT is produced for every streaming request
- **GIVEN** a streaming request through the proxy that yields at least one
  content-bearing SSE event
- **WHEN** the background collector finishes
- **THEN** the resulting log entry MUST carry a numeric `ttftFirstTokenMs`

### Requirement: The TTFT clock origin MUST be client request arrival at the proxy, threaded via a request-start header with a safe fallback
`server/proxy.ts` MUST capture `reqStartMs = Date.now()` at the request-handler
entry and inject it into the outbound upstream request as the header
`x-lucent-req-start-ms` (string of an integer epoch millisecond value),
alongside the existing `x-lucent-provider` / `x-lucent-endpoint` headers.
`server/interceptor.ts` MUST read that header, parse it to an integer, and use
it as the TTFT/Duration clock origin. If the header is absent or not a finite
integer, the interceptor MUST fall back to its own fetch-call start time
(the existing `startTime` captured at patched-`fetch` entry). The header MUST
be stripped from the request before it is sent upstream (together with the
other `x-lucent-*` headers). The raw `reqStartMs` value MUST NOT be persisted
into the JSONL log — only the derived `ttft*` fields and the corrected
`duration` are persisted.

**Rationale:** "Client issues request → first token" semantics require counting
from request arrival, not from the upstream fetch call (which omits large
request-body upload time). Threading via a header reuses the existing
`x-lucent-*` injection channel at near-zero cost. The fallback preserves the
metric for direct (non-proxy) fetches that still match the interceptor, so the
feature degrades gracefully rather than silently producing nothing.

#### Scenario: Proxy injects the request-start header
- **WHEN** `server/proxy.ts` forwards a request to upstream
- **THEN** the outbound request headers MUST include `x-lucent-req-start-ms`
  whose value is the integer epoch-ms at which the client request arrived at
  the proxy request handler

#### Scenario: Interceptor reads the header and strips it
- **WHEN** the patched `fetch` handles a proxy-forwarded request
- **THEN** it MUST parse `x-lucent-req-start-ms` as the TTFT/Duration origin
- **AND** MUST remove `x-lucent-req-start-ms` from the headers actually sent
  upstream

#### Scenario: Missing or malformed header falls back to fetch-call start
- **GIVEN** a request reaching the interceptor without a valid
  `x-lucent-req-start-ms` header (e.g. a direct fetch whose URL contains
  `anthropic`/`openai`)
- **WHEN** the interceptor computes timing
- **THEN** it MUST use the patched-`fetch` entry time as the origin instead
- **AND** MUST still produce `ttft*` fields (less accurate, but present)

#### Scenario: Raw origin is not persisted
- **WHEN** a log entry is written to JSONL
- **THEN** it MUST NOT contain a `reqStartMs` field
- **AND** the four derived fields (`ttftFirstTokenMs`, `ttftThinkingMs`,
  `ttftAnswerMs`, `tokensPerSecond`) and `duration` are the only timing values
  persisted

### Requirement: Token-bucket classification MUST live in a single shared helper, and the per-protocol caliber is fixed as specified
The system MUST add a pure function
`classifySSEEventTokenBucket(eventType: string, data: any, endpointType: EndpointType | null): { thinking: boolean; answer: boolean }`
to `shared/sse-events.ts` (front+back shared single source). It returns whether
a single SSE event carries a **non-empty** thinking delta and/or a non-empty
answer-text delta (non-empty = the extracted delta string is truthy; any
non-empty string counts, including a whitespace token the model emits). The
background collector MUST use this helper and MUST NOT re-implement protocol
detection. The classification caliber per protocol is fixed as follows:

**anthropic-messages** (type carried by the `event:` line):
- `thinking === true` iff `eventType === 'content_block_delta'` AND
  `data.delta?.type === 'thinking_delta'` AND `data.delta.thinking` is a
  non-empty string.
- `answer === true` iff `eventType === 'content_block_delta'` AND
  `data.delta?.type === 'text_delta'` AND `data.delta.text` is a non-empty
  string.
- Everything else (`message_start`, `content_block_start`,
  `content_block_stop`, `message_delta`, `input_json_delta`, `signature_delta`)
  → `{ thinking: false, answer: false }`. Tool-call argument deltas
  (`input_json_delta`) are NOT tokens for TTFT purposes.

**openai-chat** (no `event:` line; classify from `data`):
- `thinking === true` iff `data.choices?.[0]?.delta?.reasoning_content` is a
  non-empty string OR `data.choices?.[0]?.delta?.reasoning` is a non-empty
  string.
- `answer === true` iff `data.choices?.[0]?.delta?.content` is a non-empty
  string.
- Everything else (role-only first chunk with empty `content`, `tool_calls`,
  `refusal`, `finish_reason`, `usage`) → `{ thinking: false, answer: false }`.

**openai-responses** (type carried by `data.type`):
- `thinking === true` iff `data.type` is one of
  `response.reasoning.delta`, `response.reasoning_text.delta`,
  `response.reasoning_summary_text.delta` AND `data.delta` is a non-empty
  string.
- `answer === true` iff `data.type` is one of
  `response.output_text.delta`, `response.text.delta` AND `data.delta` is a
  non-empty string.
- Everything else (lifecycle events `response.created` / `in_progress` /
  `queued` / `output_item.added` / `content_part.added` / `completed`;
  `response.function_call_arguments.delta`; `response.mcp_call_arguments.delta`;
  `response.refusal.delta`) → `{ thinking: false, answer: false }`.

**Rationale:** Lead explicitly required the three-protocol first-token /
thinking-token / answer-token caliber be locked in spec so it cannot drift into
implementation. A single shared helper upholds the codebase's single-source
discipline (mirrors `protocol-model`'s spirit) and lets the UI or future
features reuse the exact same classification. Excluding lifecycle/structural
events (notably the `responses` endpoint's early `response.created`/`in_progress`
burst) is what makes TTFT meaningful instead of near-zero.

#### Scenario: anthropic thinking delta classifies as thinking
- **GIVEN** an SSE event with `event: content_block_delta` and
  `data.delta = { type: 'thinking_delta', thinking: 'hm' }`
- **WHEN** classified with endpointType `anthropic-messages`
- **THEN** the result MUST be `{ thinking: true, answer: false }`

#### Scenario: anthropic text delta classifies as answer
- **GIVEN** an SSE event with `event: content_block_delta` and
  `data.delta = { type: 'text_delta', text: 'H' }`
- **WHEN** classified with endpointType `anthropic-messages`
- **THEN** the result MUST be `{ thinking: false, answer: true }`

#### Scenario: anthropic structural events classify as neither
- **GIVEN** SSE events `message_start`, `content_block_start`,
  `content_block_delta` with `data.delta.type === 'input_json_delta'`
- **WHEN** classified with endpointType `anthropic-messages`
- **THEN** each result MUST be `{ thinking: false, answer: false }`

#### Scenario: openai-chat reasoning classifies as thinking
- **GIVEN** an SSE chunk whose `data.choices[0].delta = { reasoning_content: 'r' }`
- **WHEN** classified with endpointType `openai-chat`
- **THEN** the result MUST be `{ thinking: true, answer: false }`

#### Scenario: openai-chat empty-content role chunk classifies as neither
- **GIVEN** an SSE chunk whose `data.choices[0].delta = { role: 'assistant' }`
  (content absent/empty)
- **WHEN** classified with endpointType `openai-chat`
- **THEN** the result MUST be `{ thinking: false, answer: false }`

#### Scenario: openai-chat content delta classifies as answer
- **GIVEN** an SSE chunk whose `data.choices[0].delta = { content: 'Hi' }`
- **WHEN** classified with endpointType `openai-chat`
- **THEN** the result MUST be `{ thinking: false, answer: true }`

#### Scenario: openai-responses lifecycle events classify as neither
- **GIVEN** SSE events with `data.type` of `response.created`,
  `response.in_progress`, `response.output_item.added`
- **WHEN** classified with endpointType `openai-responses`
- **THEN** each result MUST be `{ thinking: false, answer: false }`

#### Scenario: openai-responses reasoning delta classifies as thinking
- **GIVEN** an SSE event with `data.type = 'response.reasoning.delta'` and
  non-empty `data.delta`
- **WHEN** classified with endpointType `openai-responses`
- **THEN** the result MUST be `{ thinking: true, answer: false }`

#### Scenario: openai-responses output_text delta classifies as answer
- **GIVEN** an SSE event with `data.type = 'response.output_text.delta'` and
  non-empty `data.delta`
- **WHEN** classified with endpointType `openai-responses`
- **THEN** the result MUST be `{ thinking: false, answer: true }`

#### Scenario: openai-responses tool/refusal deltas classify as neither
- **GIVEN** SSE events with `data.type` of `response.function_call_arguments.delta`
  (non-empty `data.delta`) and `response.refusal.delta`
- **WHEN** classified with endpointType `openai-responses`
- **THEN** each result MUST be `{ thinking: false, answer: false }`

### Requirement: TTFT fields MUST be derived as deltas from the request-start origin and be optional
During the collector's read loop, the system MUST record the wall-clock
(`Date.now()`) of the first event classified `{ thinking: true }`
(`firstThinkingAt`), the first classified `{ answer: true }` (`firstAnswerAt`),
and `firstTokenAt` = the earlier of the two (the first generated token of any
kind). It MUST then derive, as integer milliseconds:

- `ttftFirstTokenMs = firstTokenAt − reqStartMs`
- `ttftThinkingMs = firstThinkingAt − reqStartMs`
- `ttftAnswerMs = firstAnswerAt − reqStartMs`

Each field is OPTIONAL: if no event of that bucket ever arrives (e.g.
reasoning-only stream with no answer text, answer-only stream with no
thinking, truncated-before-any-token stream, or a non-streaming response), the
corresponding field MUST be omitted from the persisted entry rather than
written as `0` or `null`.

**Rationale:** Three separate fields give the prefill decomposition owner asked
for (thinking-first vs answer-first), while `ttftFirstTokenMs` is the single
headline number. Omit-on-absent (not zero) keeps "no data" distinguishable from
"instant", which matters for a metric whose whole purpose is latency diagnosis.

#### Scenario: Reasoning-then-answer stream yields all three fields
- **GIVEN** a streaming response whose first content event is a thinking delta
  at T1 and first answer delta at T2 (T2 > T1), origin at T0
- **WHEN** the collector finishes
- **THEN** `ttftFirstTokenMs === T1 − T0` AND `ttftThinkingMs === T1 − T0` AND
  `ttftAnswerMs === T2 − T0`

#### Scenario: Answer-only stream omits thinking field
- **GIVEN** a streaming response with answer deltas but no thinking deltas
- **WHEN** the collector finishes
- **THEN** `ttftFirstTokenMs` and `ttftAnswerMs` MUST be present
- **AND** `ttftThinkingMs` MUST be absent from the entry

#### Scenario: Truncated-before-token stream omits all TTFT fields
- **GIVEN** a streaming response truncated (timeout/limit/error) before any
  content-bearing event
- **WHEN** the collector finishes
- **THEN** `ttftFirstTokenMs`, `ttftThinkingMs`, `ttftAnswerMs` MUST all be
  absent

#### Scenario: Non-streaming response omits all TTFT fields
- **GIVEN** a non-streaming (JSON) response
- **WHEN** the entry is written
- **THEN** `ttftFirstTokenMs`, `ttftThinkingMs`, `ttftAnswerMs` MUST all be
  absent

### Requirement: `duration` MUST be finalized when the response body is fully consumed, not when response headers arrive
The system MUST NOT leave `duration` pinned to the moment `await fetch`
resolves (response-header arrival). Instead:

- For a streaming response, `duration` MUST be set to
  `consumeEndAt − reqStartMs` where `consumeEndAt` is the wall-clock at which
  the collector's read loop terminates (stream done, timeout, byte-limit, or
  error).
- For a non-streaming response, `duration` MUST be set after the response body
  has been fully read (`await cloned.text()` completes in `handleNormalResponse`),
  as `consumeEndAt − reqStartMs`.

The interceptor MUST NOT set a final `duration` at the post-`fetch` line for
either path; any value set there is provisional and MUST be overwritten by the
consume-complete path before the entry is persisted.

**Rationale:** This fixes the latent bug where a 30-second streaming generation
showed a few-hundred-ms `duration` because it was pinned at header arrival.
"Time from request arrival to response fully consumed" is one uniform, correct
definition for both paths. (If owner scopes the fix to streaming only, the
non-streaming bullet is dropped; the streaming bullet and the rest of this
requirement stand.)

#### Scenario: Streaming duration covers the whole stream
- **GIVEN** a streaming response whose first token arrives 500ms after request
  arrival and whose stream closes 30s after request arrival
- **WHEN** the entry is persisted
- **THEN** `duration` MUST be approximately 30000 (within a small tolerance)
- **AND** MUST be greater than `ttftFirstTokenMs`

#### Scenario: Streaming duration reflects truncation time
- **GIVEN** a streaming response truncated by the collector timeout at 180s
- **WHEN** the entry is persisted
- **THEN** `duration` MUST be approximately 180000
- **AND** MUST NOT be the few-hundred-ms header-arrival value

#### Scenario: Non-streaming duration reflects full body read
- **GIVEN** a non-streaming JSON response
- **WHEN** the entry is persisted
- **THEN** `duration` MUST be measured after `await cloned.text()` completes
- **AND** MUST NOT be pinned to the `await fetch` resolve time

### Requirement: tokens/s MUST be derived for streaming responses only, with guards
For a streaming response, the system MUST compute
`tokensPerSecond = output_tokens / ((duration − ttftFirstTokenMs) / 1000)`,
rounded to one decimal place, using the entry's final `output_tokens`
(from SSE usage extraction) and the finalized `duration`. The system MUST omit
`tokensPerSecond` (leave absent) when ANY of: `ttftFirstTokenMs` is absent,
`duration <= ttftFirstTokenMs`, or `output_tokens === 0`. For a non-streaming
response, `tokensPerSecond` MUST be omitted (no prefill/decode decomposition
applies).

**Rationale:** This is decode-stage throughput — how fast the model emitted its
output tokens after the first one. For reasoning models `output_tokens`
includes thinking tokens, so this value is "total generation throughput
including thinking" until per-bucket token counts exist (round two). Streaming-
only because the metric is meaningless without a TTFT split.

#### Scenario: Streaming response with tokens yields a positive rate
- **GIVEN** a streaming response with `ttftFirstTokenMs = 500`,
  `duration = 30500`, `output_tokens = 600`
- **WHEN** the entry is persisted
- **THEN** `tokensPerSecond` MUST equal `20.0` (600 / 30.0), rounded to 1 dp

#### Scenario: tokens/s omitted when there is no TTFT
- **GIVEN** a streaming response truncated before any token
- **WHEN** the entry is persisted
- **THEN** `tokensPerSecond` MUST be absent

#### Scenario: tokens/s omitted for non-streaming
- **GIVEN** a non-streaming JSON response
- **WHEN** the entry is persisted
- **THEN** `tokensPerSecond` MUST be absent

### Requirement: The four new timing fields MUST survive log normalization on both reader paths
`server/types.ts` MUST add optional fields `ttftFirstTokenMs`, `ttftThinkingMs`,
`ttftAnswerMs`, `tokensPerSecond` to BOTH `RawLogEntry` and `LogEntry`.
`server/services/log-reader.ts` `normalizeLogEntry` MUST forward these four
fields on the flat→nested explicit-mapping branch (alongside `duration` /
`tokenUsage`); entries that are already nested (the `raw.request` early-return
branch) keep them automatically. Old log entries written before this change
MUST load with these fields absent (rendered as "n/a" by the UI); no migration
is performed.

**Rationale:** `normalizeLogEntry` maps fields one-by-one on the conversion
path, so a newly added field is silently dropped unless explicitly listed. The
early-return path returns the raw object as-is, so already-nested entries are
safe. Stating both paths prevents the field from vanishing between write and
read.

#### Scenario: Flat entry converts with timing fields intact
- **GIVEN** a flat `RawLogEntry` on disk carrying `ttftFirstTokenMs = 480`,
  `ttftThinkingMs = 480`, `ttftAnswerMs = 900`, `tokensPerSecond = 18.5`
- **WHEN** `normalizeLogEntry` converts it to nested form
- **THEN** all four fields MUST be present with the same values

#### Scenario: Old entries load without timing fields
- **GIVEN** a log entry written before this change (no `ttft*` / `tokensPerSecond`)
- **WHEN** read and normalized
- **THEN** the four fields MUST be absent (not `0`, not `null`)
- **AND** the entry MUST still load without error

### Requirement: The Web UI MUST surface the timing fields with stable test hooks
The detail panel MUST render `ttftFirstTokenMs`, `ttftThinkingMs`,
`ttftAnswerMs`, and `tokensPerSecond` (when present) in a human-readable form
(milliseconds shown as ms or s as appropriate; tokens/s with units), each
exposed under a stable `data-testid`: `ttft-first-token`, `ttft-thinking`,
`ttft-answer`, `tokens-per-second`. When a field is absent, its element MUST
be omitted or render an explicit "n/a" (MUST NOT render `0` or `undefined`).
The values MUST be reachable via `/api/logs`.

**Rationale:** owner acceptance looks at real numbers, and the e2e contract
needs stable hooks to assert them. Forbidding `0`/`undefined` rendering keeps
"no data" honest in the UI, mirroring the omit-on-absent storage contract.

#### Scenario: Present values render under their testids
- **GIVEN** a log entry with all four timing fields present
- **WHEN** the detail panel renders it
- **THEN** elements with `data-testid` `ttft-first-token`, `ttft-thinking`,
  `ttft-answer`, `tokens-per-second` MUST each display their value

#### Scenario: Absent values render n/a, not zero
- **GIVEN** a log entry lacking `ttftThinkingMs`
- **WHEN** the detail panel renders it
- **THEN** the `ttft-thinking` element MUST render "n/a" (or be omitted)
- **AND** MUST NOT render `0`, `undefined`, or `NaN`

### Requirement: Verification MUST assert real timing via the streaming e2e chains, with exit code driven by assertions
The streaming e2e scripts (`npm run verify:openai-chat`, `npm run verify:openai-responses`,
`npm run verify:anthropic`) MUST assert, for a streaming request driven through the
proxy: that the resulting log entry carries `ttftFirstTokenMs` that is a
positive number strictly less than `duration`; that `tokensPerSecond` is a
positive number; and that `duration` is strictly greater than `ttftFirstTokenMs`
(proving `duration` now spans the whole stream, not just response headers). A
new unit test MUST cover `classifySSEEventTokenBucket` across the
thinking/answer/neither matrix for all three protocols. Assertion failures MUST
drive a non-zero exit code. Per `verification-workflow`, `npm run verify:e2e`
and the relevant `verify:*` scripts plus `npm run test:run` MUST pass (exit 0)
before the change is considered done; the real-upstream `npm run record:newapi`
run (when `OPENAI_API_KEY` and a live upstream are available) is the
human-readable real-numbers evidence path and is environment-gated, not CI-gated.

**Rationale:** owner requires evidence (real numbers / executed data), not
claims. The mock-upstream streaming e2e proves wiring + correctness in a
CI-stable way; the real reasoning-upstream record produces the actual TTFT
numbers for the project's model. Tying assertions to exit codes matches the
codebase's verification discipline.

#### Scenario: Streaming e2e asserts TTFT presence and ordering
- **GIVEN** a streaming request through the proxy in any of the three protocol
  e2e scripts
- **WHEN** the script evaluates the resulting log entry
- **THEN** it MUST require `ttftFirstTokenMs > 0` AND `ttftFirstTokenMs < duration`
- **AND** MUST require `tokensPerSecond > 0`
- **AND** MUST require `duration > ttftFirstTokenMs`

#### Scenario: Classifier unit test covers the caliber matrix
- **WHEN** the unit suite runs
- **THEN** a test for `classifySSEEventTokenBucket` MUST exercise thinking-true,
  answer-true, and neither cases for each of the three protocols
- **AND** MUST fail (non-zero exit) if any classification deviates from the
  caliber fixed above
