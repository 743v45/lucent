## ADDED Requirements

### Requirement: Provider baseUrl MUST already include the upstream's version path
The system SHALL require each provider's endpoint `baseUrl` to already include
the upstream API's version path. The proxy MUST NOT prepend another version
segment (e.g. `/v1`) when composing the upstream URL.

**Rationale:** All four verified official upstreams publish endpoints under a
versioned path (`/v1`, `/v2`, `/v3`, `/v4`, etc.). The baseUrl is the right
place to declare that version; the proxy must treat it as opaque after that.

#### Scenario: Anthropic Messages provider with `/v1` baseUrl
- **GIVEN** a provider with `anthropic-messages` endpoint `https://api.anthropic.com/v1`
- **WHEN** the proxy composes the upstream URL
- **THEN** the upstream URL is `https://api.anthropic.com/v1/messages`
- **AND** the URL MUST NOT contain `/v1/v1/`

#### Scenario: OpenAI Chat Completions provider with `/v1` baseUrl
- **GIVEN** a provider with `openai-chat` endpoint `https://api.openai.com/v1`
- **WHEN** the proxy composes the upstream URL
- **THEN** the upstream URL is `https://api.openai.com/v1/chat/completions`

#### Scenario: OpenAI Responses provider with `/v1` baseUrl
- **GIVEN** a provider with `openai-responses` endpoint `https://api.openai.com/v1`
- **WHEN** the proxy composes the upstream URL
- **THEN** the upstream URL is `https://api.openai.com/v1/responses`

#### Scenario: 智谱 GLM OpenAI Chat provider with `/api/coding/paas/v4` baseUrl
- **GIVEN** a provider with `openai-chat` endpoint `https://open.bigmodel.cn/api/coding/paas/v4`
- **WHEN** the proxy composes the upstream URL
- **THEN** the upstream URL is `https://open.bigmodel.cn/api/coding/paas/v4/chat/completions`

#### Scenario: 智谱 GLM Anthropic Messages provider with `/api/anthropic/v1` baseUrl
- **GIVEN** a provider with `anthropic-messages` endpoint `https://open.bigmodel.cn/api/anthropic/v1`
- **WHEN** the proxy composes the upstream URL
- **THEN** the upstream URL is `https://open.bigmodel.cn/api/anthropic/v1/messages`

### Requirement: Proxy MUST strip a leading `/v1` from the incoming request path before composing the upstream URL
The system SHALL strip a single leading `/v1` segment from the incoming
request path (the part after `/{providerName}/`) before concatenating it
with the provider's `baseUrl`. This applies to **all three** endpoint types
(`anthropic-messages`, `openai-chat`, `openai-responses`).

**Rationale:** Downstream clients (Claude Code, Codex, OpenCode, etc.) all
default to sending the full path including `/v1` (e.g. `/v1/messages`). The
proxy must accept either form and resolve to the same upstream URL.

#### Scenario: Downstream path includes `/v1` prefix
- **GIVEN** a request `POST /custom/hxy/v1/messages` and provider `hxy` has baseUrl `https://api.anthropic.com/v1`
- **WHEN** the proxy composes the upstream URL
- **THEN** the upstream URL is `https://api.anthropic.com/v1/messages`

#### Scenario: Downstream path without `/v1` prefix
- **GIVEN** a request `POST /custom/hxy/messages` and provider `hxy` has baseUrl `https://api.anthropic.com/v1`
- **WHEN** the proxy composes the upstream URL
- **THEN** the upstream URL is `https://api.anthropic.com/v1/messages` (identical to the `/v1` form)

#### Scenario: OpenAI Chat with `/v1` prefix
- **GIVEN** a request `POST /custom/hxy/v1/chat/completions` and provider `hxy` has baseUrl `https://api.openai.com/v1`
- **WHEN** the proxy composes the upstream URL
- **THEN** the upstream URL is `https://api.openai.com/v1/chat/completions`

#### Scenario: OpenAI Responses with `/v1` prefix
- **GIVEN** a request `POST /custom/hxy/v1/responses` and provider `hxy` has baseUrl `https://api.openai.com/v1`
- **WHEN** the proxy composes the upstream URL
- **THEN** the upstream URL is `https://api.openai.com/v1/responses`

### Requirement: Test-connection endpoint MUST compose URLs the same way as proxy forwarding
The system SHALL use the same baseUrl-and-protocol-path composition rule
in the test-connection endpoint (`POST /api/providers/:name/test`) as in
the main proxy forwarding path. Test-connection MUST NOT add a `/v1` segment
that the main proxy would not also add.

**Rationale:** Test-connection exists to verify that the proxy can reach the
upstream. If it composes a different URL than the proxy will later send,
the test is meaningless. Both must resolve to the same upstream path.

#### Scenario: Test-connection for Anthropic Messages with `/v1` baseUrl
- **GIVEN** a provider with `anthropic-messages` endpoint `https://api.anthropic.com/v1`
- **WHEN** the test-connection endpoint runs a probe
- **THEN** the probe URL is `https://api.anthropic.com/v1/messages`
- **AND** the probe URL MUST NOT contain `/v1/v1/`

#### Scenario: Test-connection for OpenAI Chat with `/v1` baseUrl
- **GIVEN** a provider with `openai-chat` endpoint `https://api.openai.com/v1`
- **WHEN** the test-connection endpoint runs a probe
- **THEN** the probe URL is `https://api.openai.com/v1/chat/completions`

#### Scenario: Test-connection for OpenAI Responses with `/v1` baseUrl
- **GIVEN** a provider with `openai-responses` endpoint `https://api.openai.com/v1`
- **WHEN** the test-connection endpoint runs a probe
- **THEN** the probe URL is `https://api.openai.com/v1/responses`

### Requirement: First-launch default config MUST include `/v1` (or equivalent version) in the seed provider baseUrl
The system SHALL write a seed provider into `~/.lucent/config.json` on first
launch (when no config file exists) whose `anthropic-messages` baseUrl
includes the upstream's version path (`/v1`).

**Rationale:** A user starting Lucent for the first time should be able to
send a request to the seed provider without first having to fix the
baseUrl. The seed must therefore be "correct by default".

#### Scenario: First launch on a fresh machine
- **GIVEN** no `~/.lucent/config.json` exists
- **WHEN** the server starts for the first time
- **THEN** the seed `anthropic` provider's `anthropic-messages` baseUrl is `https://api.anthropic.com/v1`

### Requirement: Per-provider endpoint-URL table (verified upstreams only)
The system MUST record the following official upstream endpoints as canonical
references for the corresponding preset names in `src/constants/presets.ts`,
and the baseUrl values shown in the "baseUrl (provider config)" column
MUST be the exact strings used. The project MUST NOT introduce a new preset
for any of these upstreams without first extending this table.

| Preset name | Endpoint type | Full URL (path composed) | baseUrl (provider config) |
|---|---|---|---|
| `anthropic` | `anthropic-messages` | `https://api.anthropic.com/v1/messages` | `https://api.anthropic.com/v1` |
| `openai` | `openai-chat` | `https://api.openai.com/v1/chat/completions` | `https://api.openai.com/v1` |
| `openai` | `openai-responses` | `https://api.openai.com/v1/responses` | `https://api.openai.com/v1` |
| `zhipu` | `openai-chat` | `https://open.bigmodel.cn/api/coding/paas/v4/chat/completions` | `https://open.bigmodel.cn/api/coding/paas/v4` |
| `zhipu` | `anthropic-messages` | `https://open.bigmodel.cn/api/anthropic/v1/messages` | `https://open.bigmodel.cn/api/anthropic/v1` |

#### Scenario: `anthropic` preset in `src/constants/presets.ts`
- **WHEN** reading `src/constants/presets.ts`
- **THEN** the `anthropic` preset's `anthropic-messages` value equals `https://api.anthropic.com/v1`

#### Scenario: `openai` preset in `src/constants/presets.ts`
- **WHEN** reading `src/constants/presets.ts`
- **THEN** the `openai` preset's `openai-chat` value equals `https://api.openai.com/v1`
- **AND** the `openai` preset's `openai-responses` value equals `https://api.openai.com/v1`

#### Scenario: `zhipu` preset in `src/constants/presets.ts`
- **WHEN** reading `src/constants/presets.ts`
- **THEN** the `zhipu` preset's `openai-chat` value equals `https://open.bigmodel.cn/api/coding/paas/v4`
- **AND** the `zhipu` preset's `anthropic-messages` value equals `https://open.bigmodel.cn/api/anthropic/v1`
