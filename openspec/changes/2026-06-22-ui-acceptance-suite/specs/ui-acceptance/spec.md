## ADDED Requirements

### Requirement: The project MUST ship an independent Playwright UI test suite covering interaction and visual behavior, separate from the existing protocol-chain verify scripts
The project MUST provide a Playwright-based UI test suite rooted at
`tests/ui/`, configured by a checked-in `playwright.config.ts`, and
exposed via `npm run verify:ui`. The suite MUST be independent of the
existing `scripts/verify-*-e2e.ts` family — those scripts (the
`protocol-chain-verification` contract) MUST continue to run unchanged
and MUST NOT be migrated into or deleted by this suite. The new suite
covers the interaction/visual layer that the existing scripts do not:
provider CRUD in `SettingsModal`, `UsageGuide` modal flows, top-bar
buttons, `LogListPanel` toggles/filters/empty states, and the
`DetailPanel` KV-Cache / Meta tabs plus the SSE view toggle.

**Rationale:** The five existing `verify:*` scripts assert only that
protocol data appears in the DOM via five `data-testid`s. Every
interaction surface — `SettingsModal` (665 lines, zero coverage),
`UsageGuide` modal open/copy/jump, top-bar buttons, the timeline↔session
toggle, provider/endpoint filters, the KV-Cache tab, the Meta tab, the
SSE structured↔raw toggle — has no automated coverage. These scripts
also hand-roll `chromium.launch()` with no `playwright.config.ts`, so
`npx playwright test` cannot run standalone. A dedicated suite fills
the interaction gap and gives the project a standard Playwright entry
point for both CI and local debugging.

#### Scenario: The suite runs via npm
- **WHEN** a developer or agent runs `npm run verify:ui`
- **THEN** Playwright runs all specs under `tests/ui/` against a real
  browser
- **AND** the process exits with code `0` on full pass or non-zero on
  any failure

#### Scenario: The suite runs standalone without manual server startup
- **WHEN** a developer runs `npx playwright test` at the repo root
- **THEN** the `webServer` config in `playwright.config.ts` starts the
  `scripts/start-ui-env.ts` launcher
- **AND** that launcher brings up the backend, the vite dev server, and
  a mock upstream as a single process tree
- **AND** the launcher MUST use a temporary `LUCENT_CONFIG_DIR` and
  random ports so `~/.lucent/config.json` is never touched

#### Scenario: Existing verify scripts are untouched
- **WHEN** the suite is added
- **THEN** `scripts/verify-e2e.mjs`, `verify-anthropic-e2e.ts`,
  `verify-openai-chat-e2e.ts`, `verify-openai-responses-e2e.ts`,
  `verify-custom-providers-e2e.ts`, and `verify-custom-errors-e2e.ts`
  MUST remain present and behaviorally unchanged
- **AND** their npm scripts (`verify:e2e`, `verify:anthropic`, etc.)
  MUST still exist and run as before

### Requirement: UI components MUST expose stable data-testid selectors for every testable interaction, centralized as constants
The UI components MUST expose a stable `data-testid` attribute on every
interactive element the UI suite exercises and on every display element
the suite asserts against. The literal testid strings MUST be
centralized as named exports (constants) in a single source of truth at
`src/testids.ts`; both the React components and the Playwright Page
Objects import from there so that renaming a testid edits one symbol.
The testids MUST follow the existing kebab-case convention
(`log-row`, `tab-{key}`, `context-item`).

**Rationale:** The existing `protocol-chain-verification` contract
already mandates five testids and treats them as a contract — changing
them breaks the verify scripts. Extending that same discipline to the
new suite keeps selectors stable across refactors (renames, copy
changes, icon swaps). Centralizing in `src/testids.ts` prevents the
"classic drift" where a component hardcodes `"foo-bar"` and the spec
hardcodes `"foo-bar"` independently, then one changes and silently
breaks.

#### Scenario: New interaction surfaces carry testids
- **WHEN** reading the React component files
- **THEN** the following testids MUST be present (literal values
  centralized in `src/testids.ts`):
  - Top bar (`src/App.tsx`): `topbar-refresh`, `topbar-usage`, `topbar-settings`
  - LogListPanel: `loglist-view-timeline`, `loglist-view-session`,
    `loglist-filter-provider`, `loglist-filter-endpoint`,
    `loglist-count`, `loglist-empty`, `loglist-session-group`
    (with `data-threadid`)
  - DetailPanel KV-Cache: `kvcache-hit-rate`, `kvcache-group`
    (with `data-id`), `kvcache-copy-all`
  - DetailPanel Meta: `meta-row` (with `data-key`)
  - DetailPanel SSE toggle: `sse-toggle-structured`, `sse-toggle-raw`
  - DetailPanel generic: `copy-button` (with `data-target`),
    `collapse-button` (with `data-target`)
  - SettingsModal: `settings-modal`, `settings-preset-card`
    (with `data-name`), `settings-custom-input`,
    `settings-custom-create`, `settings-custom-error`,
    `settings-provider-card` (with `data-name`),
    `settings-provider-delete`, `settings-provider-rename`,
    `settings-endpoint-input` (with `data-endpoint`),
    `settings-endpoint-test`, `settings-endpoint-reset`,
    `settings-endpoint-warning`, `settings-copy-access-url`
  - UsageGuide: `usage-guide-modal`, `usage-access-line`
    (with `data-client`), `usage-copy-line` (with `data-client`),
    `usage-goto-settings`

#### Scenario: Existing five testids remain unchanged
- **WHEN** the change is implemented
- **THEN** the five testids mandated by `protocol-chain-verification`
  (`log-row` + `data-logid`, `tab-{key}`, `request-body`,
  `response-body`, `context-item` + `data-role`) MUST keep their
  literal values and semantics
- **AND** the existing `scripts/verify-*-e2e.ts` MUST still pass against
  them

### Requirement: The UI suite MUST cover eight spec files organized by interaction surface, each combining behavioral assertions with visual snapshots
The suite MUST contain exactly these eight spec files under
`tests/ui/`, each scoped to one interaction surface:
`topbar.spec.ts`, `loglist.spec.ts`,
`detail-request-response.spec.ts`, `detail-kvcache.spec.ts`,
`detail-meta.spec.ts`, `detail-context.spec.ts`, `settings.spec.ts`,
`usage-guide.spec.ts`. Each spec MUST assert behavior (click / type /
toggle → expected DOM state via testid) AND, for the key states of
that surface, call `toHaveScreenshot()` to lock the visual layout.

**Rationale:** One spec per surface keeps failure messages scoped
("settings.spec.ts failed" immediately localizes the regression to
provider CRUD). Splitting `DetailPanel` into four files (one per tab
group) prevents a single thousand-line spec that is painful to
maintain. Visual snapshots catch the regressions the behavioral
assertions miss — a button moving, a color flipping, a panel
collapsing by default — at the cost of managing baselines.

#### Scenario: The eight spec files exist with the required coverage
- **WHEN** reading `tests/ui/`
- **THEN** the following eight files MUST be present and non-empty:
  `topbar.spec.ts`, `loglist.spec.ts`,
  `detail-request-response.spec.ts`, `detail-kvcache.spec.ts`,
  `detail-meta.spec.ts`, `detail-context.spec.ts`, `settings.spec.ts`,
  `usage-guide.spec.ts`
- **AND** each file MUST assert at least the behaviors enumerated in
  the change proposal's coverage table for that surface

#### Scenario: Visual snapshots lock key states
- **WHEN** a spec exercises a stable visual state (empty log list,
  populated list, each DetailPanel tab's default render, the
  SettingsModal preset grid, an expanded provider card, the
  UsageGuide modal)
- **THEN** the spec MUST call `expect(locator).toHaveScreenshot(...)`
- **AND** the baseline PNGs MUST be committed under
  `tests/ui/**/__snapshots__/` so a clean checkout reproduces them
- **AND** the project MUST expose `npm run verify:ui:update` running
  `playwright test --update-snapshots` for regenerating baselines

### Requirement: The UI suite MUST seed a fixed corpus of log entries covering the states the specs branch on
The suite MUST, via a seed helper (`tests/ui/fixtures/seed.ts`),
populate the temporary log directory with a fixed corpus of JSONL
entries before specs run. The corpus MUST cover at minimum: an empty
state (no entries), a single entry, multiple entries, a streaming SSE
entry, a non-streaming JSON entry, error-status entries (401, 429,
500), KV-Cache entries straddling both `CACHE_HIT_RATE_GOOD_THRESHOLD`
and `CACHE_HIT_RATE_BAD_THRESHOLD`, entries across multiple providers
× multiple endpoint types (to exercise the filter dropdowns), and
entries carrying a `threadId` (to exercise the session view).

**Rationale:** The existing verify scripts generate their fixtures
live by sending HTTP requests through the proxy. That is correct for
protocol-chain verification but too slow and too indirect for UI specs
that need to assert ten branching render paths in one file. Seeding
JSONL directly gives deterministic, fast, named fixtures. Threshold
values matter because the KV-Cache tab color-codes the hit rate, and
the corpus must land on both sides of each threshold or the color
assertion is meaningless.

#### Scenario: The seed corpus covers all branch states
- **WHEN** the UI suite's global setup runs
- **THEN** the temporary `LUCENT_LOG_DIR` MUST contain JSONL entries
  covering every state enumerated above
- **AND** any spec that branches on provider, endpoint type, error
  status, KV-Cache threshold, or `threadId` MUST find a matching entry
  in the corpus without sending live traffic

### Requirement: The project MUST land an `openspec/specs/ui-acceptance/spec.md` capability and deprecate the stale Expand-All requirement in `protocol-chain-verification`
On archive, the change MUST create
`openspec/specs/ui-acceptance/spec.md` consolidating this capability's
requirements as the stable contract, and MUST mark
`protocol-chain-verification` Requirement 8 (Expand All / Collapse All
buttons) as deprecated/superseded — those buttons were removed by the
`2026-06-18-fix-detailpanel-collapse-duplicate` change and the
requirement is factually stale.

**Rationale:** OpenSpec specs are the durable contract surface; a
capability without a landed spec is an orphan. Marking the stale
Requirement 8 here (rather than spinning up a separate change) is
justified because discovering it was a direct side-effect of auditing
UI coverage for this suite — the two belong together.

#### Scenario: ui-acceptance spec lands on archive
- **WHEN** `openspec archive 2026-06-22-ui-acceptance-suite` runs
  successfully
- **THEN** `openspec/specs/ui-acceptance/spec.md` MUST exist
- **AND** its requirements MUST match this change's delta
- **AND** `openspec validate ui-acceptance` MUST pass

#### Scenario: Stale Expand-All requirement is marked deprecated
- **WHEN** the change is archived
- **THEN** `protocol-chain-verification` Requirement 8 MUST be marked
  deprecated or superseded
- **AND** the existing `scripts/verify-*-e2e.ts` (which never reference
  `expand-all`/`collapse-all` testids) MUST still pass
