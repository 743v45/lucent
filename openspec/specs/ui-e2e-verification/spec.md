# ui-e2e-verification Specification

## Purpose

锁定 Lucent **Web UI 交互层**的端到端验收方式：用真实浏览器（Playwright +
headless chromium）驱动可点击的用户流，覆盖 vitest 单测和 `verify:*` 脚本碰不到的
交互层（点日志行、切 detail tab 等）。本 spec 是 [`e2e-verification`](./e2e-verification/spec.md)
（后端协议链路）在 UI 层的对应物，与 [`protocol-chain-verification`](./protocol-chain-verification/spec.md)
里 Web UI 渲染断言互补：那些验「渲染出没出来」，这里验「能不能交互」。

## Requirements

### Requirement: The project MUST ship a Playwright config and an e2e/ directory for UI interaction specs

The project MUST provide `playwright.config.ts` (headless chromium) and an `e2e/`
directory holding spec files (`*.spec.ts`) plus a shared stack fixture. The fixture
MUST reuse `tests/e2e-helpers.ts`'s mock-upstream (`createMockUpstream`) and the
`scripts/verify-*-e2e.ts` orchestration pattern (temporary config directory, random
high ports, real backend via `tsx server/index.ts`, vite dev serving the UI). The
fixture MUST NOT reimplement SSE/JSON fixtures.

**Rationale:** The interaction layer had zero regression protection — only 6 static
`data-testid` assertions existed, all in one-shot verify scripts. A spec-based
Playwright harness is the reusable container that F1–F6 interaction specs plug into.

#### Scenario: Playwright config present and runnable
- **WHEN** a developer runs `npx playwright test` (or `npm run e2e:ui`)
- **THEN** Playwright loads `playwright.config.ts`, discovers `e2e/*.spec.ts`, runs
  them headless on chromium, and exits `0` on success / non-zero on failure

#### Scenario: Fixture reuses the shared mock upstream
- **WHEN** a UI e2e spec runs
- **THEN** the stack fixture MUST obtain the mock upstream from
  `tests/e2e-helpers.ts`'s `createMockUpstream`
- **AND** MUST NOT define its own SSE/JSON response fixtures

### Requirement: Each UI e2e spec MUST run against an isolated stack with no real upstream and no hardcoded keys

Every spec MUST bring up its own isolated Lucent instance: a fresh temporary
`LUCENT_CONFIG_DIR`, random ports (never fixed/well-known ports), a mock upstream
that records requests, and a real backend process. The spec MUST NOT call any real
upstream API and MUST NOT hardcode real API keys; the only credential used is a
dummy bearer token in the request header.

**Rationale:** UI e2e must be hermetic and safe to run anywhere. Fixed ports
collide in shared containers (a pre-existing test already bites on this); real
upstream calls make tests non-deterministic and leak secrets.

#### Scenario: Isolated stack per spec
- **WHEN** a UI e2e spec runs
- **THEN** the backend MUST read config from a temporary `LUCENT_CONFIG_DIR`
  created fresh for this run and removed on teardown
- **AND** the proxy and web ports MUST be randomized per run
- **AND** the provider's endpoint URL MUST point at the mock upstream, never a real API

#### Scenario: No real key in the repo
- **WHEN** reading the diff that adds UI e2e
- **THEN** no spec or fixture MAY contain a real API key
- **AND** request headers MUST use an obvious dummy token (e.g. `Bearer sk-mock-*`)

### Requirement: The seed spec MUST exercise the main flow through real interactions and serve as the F1–F6 template

There MUST be a seed spec that drives the main flow end-to-end through real browser
interactions: send a request through the proxy → the Web UI shows a `log-row` →
clicking the row opens the detail panel → the Request and Response tabs render the
request/response content. The seed MUST avoid the filter / view-switch / scroll
behaviors under review in TAE-48, asserting only currently stable behavior. It is
the structural template for the follow-up F1–F6 interaction specs.

**Rationale:** A green seed proves the harness actually drives the app through a
click (not just a URL jump), and gives F1–F6 a copy-paste starting point.

#### Scenario: Main flow via click interaction
- **GIVEN** the stack is up with an `openai-chat` provider pointed at a mock upstream
  returning a chat-SSE stream
- **WHEN** the spec sends `POST /openai/v1/chat/completions` through the proxy
- **THEN** the Web UI MUST render at least one `log-row`
- **AND** clicking that row (by `data-logid`) MUST make the detail panel visible
- **AND** the Request tab's `request-body` MUST contain the request content
- **AND** switching to the Response tab MUST render `response-body` with the SSE content

### Requirement: `npm run e2e` MUST be the unified gate that chains backend verification, vitest, and UI specs

The project MUST expose `npm run e2e` as the single canonical acceptance gate. It
MUST run three stages in order — `verify:e2e`, `npm run test:run`, and the Playwright
UI specs (`e2e:ui`) — and MUST exit non-zero if any stage fails, skipping the
remaining stages. Each stage's real stdout and exit code MUST be visible.

**Rationale:** Three layers (backend routing, unit/backend-e2e, UI interaction) catch
different regressions. One command makes the full gate discoverable and CI-ready; no
single layer can silently go red.

#### Scenario: All green
- **WHEN** a developer runs `npm run e2e` on a clean environment
- **THEN** all three stages pass and the gate exits `0`

#### Scenario: Any stage red aborts the gate
- **WHEN** any one of the three stages exits non-zero
- **THEN** the gate MUST skip the remaining stages and exit non-zero
- **AND** the failing stage MUST be named in the output

### Requirement: UI e2e teardown MUST not leak backend processes or held ports

The stack fixture MUST tear down the full process tree it spawned — the `tsx`
wrapper, its `node` child that actually holds the listening socket, and the esbuild
worker — not just the top-level wrapper. This is done via process-group kill
(`spawn` with `detached: true` then `kill(-pid)`).

**Rationale:** `tsx` is a wrapper; killing only the wrapper leaves the `node` child
alive and still listening, which leaks ports and breaks subsequent runs. A
pre-existing baseline test exhibits exactly this leak on its hardcoded port.

#### Scenario: No leaked listeners after a run
- **WHEN** a UI e2e spec finishes (pass or fail)
- **THEN** no process spawned by the fixture MAY remain alive
- **AND** the ports it used MUST be released

### Requirement: The UI ↔ spec contract MUST be stable `data-testid` hooks, documented and minimal

Specs MUST locate elements via `data-testid` attributes (not CSS class or text),
and these attributes are the stable contract between the UI and the specs. New
`data-testid`s MUST be added only where an interaction spec needs them — not
sprinkled defensively. The README MUST document the UI e2e workflow, and this spec
is the canonical contract.

**Rationale:** Class names and rendered text change with redesigns; `data-testid` is
the one selector meant to survive. Keeping the set minimal avoids test-coupling rot.

#### Scenario: Specs select by data-testid
- **WHEN** a UI e2e spec interacts with the app
- **THEN** element locators MUST use `data-testid` (or `data-logid`), not class/text selectors

#### Scenario: README documents the workflow
- **WHEN** reading `README.md`
- **THEN** it MUST contain a section describing `npm run e2e` and the Playwright UI e2e layer

### Requirement: A dedicated detail-panel spec MUST cover response multi-modes and boundary responses beyond the seed's chat-SSE flow

Beyond the seed's chat-SSE happy path, there MUST be a spec (`e2e/detail-request-response.spec.ts`)
that asserts the Request/Response detail tabs across response modes and edge cases, reusing
the shared stack fixture (no reinvented isolation stack, no hand-rolled SSE/JSON fixtures). It
MUST cover: (a) a non-streaming `chat-json` response renders in the Response tab distinctly from
`chat-sse` (the rendered body contains the `chat.completion` object and MUST NOT contain SSE
chunk markers like `chat.completion.chunk` or `data:`); (b) the JSON view's `expand-all` ↔
`collapse-all` toggle actually expands and collapses nested nodes (a deep key hidden by default
becomes visible after `expand-all` and hidden again after `collapse-all`, and the toggle button's
`data-testid` flips `expand-all` ↔ `collapse-all` accordingly); (c) an empty response body and
4xx/5xx error responses do not crash the detail panel — the panel renders, the Response tab's
`response-body` is visible, and the header surfaces the upstream status code.

**Rationale:** The seed only proves the SSE happy path. Multi-mode rendering, the collapse
interaction, and error/empty robustness are exactly where the detail panel regresses in
practice — a malformed or empty upstream response can blank or crash the panel. The upstream
modes used (`chat-json`, `error-400`, `error-500`, and the additive `empty` mode) come from the
shared `createMockUpstream`; no real upstream is contacted and no real key is used.

#### Scenario: Non-streaming chat-JSON renders distinctly from chat-SSE
- **GIVEN** the stack is up with an `openai-chat` provider pointed at a mock upstream in `chat-json` mode
- **WHEN** the spec sends a chat-completions request through the proxy and opens the detail's Response tab
- **THEN** `response-body` MUST render the `chat.completion` object (e.g. contain `chat.completion` and the chat-JSON-only `system_fingerprint`)
- **AND** MUST NOT contain SSE markers (`chat.completion.chunk`, `data:`)

#### Scenario: expand-all / collapse-all toggles nested JSON nodes
- **GIVEN** the Response tab is showing a `chat-json` body in the JSON view (default collapsed to level 2)
- **WHEN** the spec clicks `expand-all`, then `collapse-all`
- **THEN** a deep nested key hidden by default MUST become visible after `expand-all`
- **AND** the toggle button's `data-testid` MUST flip `expand-all` → `collapse-all` → `expand-all`
- **AND** the deep key MUST be hidden again after `collapse-all`

#### Scenario: Empty response body does not crash the detail panel
- **GIVEN** the mock upstream returns a `200` with an empty body (the `empty` mode)
- **WHEN** the spec opens that log's detail and switches to the Response tab
- **THEN** the detail panel MUST render without error
- **AND** `response-body` MUST remain visible (empty body handled, not a blank/crash)

#### Scenario: 4xx/5xx error responses render status and error body without crashing
- **GIVEN** the mock upstream returns a `400` (or `500`) error response with an error JSON body
- **WHEN** the spec opens that log's detail
- **THEN** the header MUST surface the upstream status code (`400` / `500`)
- **AND** the detail panel MUST render without error
- **AND** the Response tab's `response-body` MUST render the error body (contain `error`)

### Requirement: A dedicated global-interactions spec MUST cover the top bar and global UI behavior (refresh / URL sync / sidebar drag / realtime push)

Beyond the seed and detail specs, there MUST be a spec (`e2e/global-interactions.spec.ts`) that drives the
top bar and global interactions through real browser input, reusing the shared stack fixture (no reinvented
isolation stack, no real upstream, no real key). It MUST assert the actual app behavior (not guessed intent)
across four areas: (a) the refresh button (`refresh-btn`) re-fetches logs and surfaces a request that landed
after the page loaded; (b) URL state sync — selecting a log writes `?log=<id>`, switching to a non-default
tab writes `?tab=<key>`, the default tab writes no `tab` param, and a full `page.reload()` restores the exact
same log and tab; (c) sidebar drag-resize — real mouse events on `sidebar-splitter` change the
`log-list-panel` width, clamp to the min/max bounds, persist to `localStorage` (`logListWidth`), and survive
reload; (d) realtime push — the spec locks in the CURRENT reality that a second request does NOT silently
appear in the list (the frontend has no `EventSource`/polling and `server/routes/logs.ts`'s `/api/logs/stream`
is a heartbeat-only skeleton whose comments state realtime push is not wired), so the new row only appears
after clicking refresh.

**Rationale:** These four interactions are where global UI regressions hide — a broken refresh silently stalls
the list, a URL-sync regression loses the shared-link/deep-link contract (reload drops selection or tab), a
drag bug lets the sidebar collapse past its bounds or forget the width on reload, and a misassumed "realtime
push" would let a regression in the refresh path go unnoticed. Asserting actual behavior — including the
currently-unwired push — keeps the spec honest; if push is later wired up, the realtime scenario fails loudly
and forces the spec to be updated to assert auto-appearance.

#### Scenario: Refresh button surfaces a request that landed after page load
- **GIVEN** the stack is up and the Web UI is already showing a first `log-row`
- **WHEN** the spec sends a second request through the proxy (which lands in the backend) and then clicks `refresh-btn`
- **THEN** the second request's `log-row` (by `data-logid`) MUST appear in the list
- **AND** the spec MUST first confirm the second row was NOT present before the refresh click

#### Scenario: URL state sync for log selection and active tab, surviving reload
- **GIVEN** a log exists and the Web UI is open
- **WHEN** the spec clicks that log's row, switches to a non-default tab (e.g. `response`), then `page.reload()`
- **THEN** the URL MUST carry `log=<id>` after selection (and no `tab` param while the default tab is active)
- **AND** the URL MUST carry `tab=response` after switching to the Response tab
- **AND** after reload the same log MUST remain selected (the detail panel renders, not the empty state) and the same tab MUST remain active
- **AND** switching back to the default tab MUST remove the `tab` param while keeping `log=<id>`

#### Scenario: Sidebar drag-resize changes width, clamps to bounds, persists, and survives reload
- **GIVEN** the Web UI is open with the sidebar at its default width (fresh `localStorage`)
- **WHEN** the spec drives real mouse events (down on `sidebar-splitter`, move, up) to a target x
- **THEN** the `log-list-panel` width MUST follow the drag (increase when dragged right)
- **AND** dragging far past the max bound MUST clamp the width to the configured maximum
- **AND** dragging far below the min bound MUST clamp the width to the configured minimum
- **AND** on mouse-up the width MUST be written to `localStorage` (`logListWidth`)
- **AND** a full `page.reload()` MUST restore the dragged width

#### Scenario: Realtime push is currently not wired — a second request does not auto-appear
- **GIVEN** the stack is up and the Web UI is already showing a first `log-row`
- **WHEN** the spec sends a second request through the proxy (which lands in the backend) and waits without refreshing
- **THEN** the second request's `log-row` MUST NOT appear in the list (the frontend has no realtime consumer)
- **AND** clicking `refresh-btn` afterwards MUST make it appear (the list updates via refresh, not push)
- **NOTE** this scenario locks in current behavior; when realtime push is implemented it MUST be updated to assert auto-appearance
