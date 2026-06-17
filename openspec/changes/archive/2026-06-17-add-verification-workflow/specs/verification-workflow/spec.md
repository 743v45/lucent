## ADDED Requirements

### Requirement: Completion claims MUST be backed by fresh command output from the current turn
The system SHALL require that any claim of the form "done", "fixed", "passing",
"all green", "verified", or equivalent is preceded — in the same message —
by the output of the command that proves the claim. Output from earlier
turns, agent self-reports, or "should work" statements MUST NOT be accepted
as evidence.

**Rationale:** "Should work" and "looks correct" are the most common
verification failure modes observed in this project's history. The only
reliable substitute for actually running a command is... actually running
the command.

#### Scenario: Claiming "all tests pass"
- **WHEN** an agent message contains a completion claim such as
  "all tests pass" or "全绿"
- **THEN** the same message MUST contain the verbatim output of
  `npx vitest run` (or the equivalent targeted test command), showing
  `Tests <N> passed (<N>)` and zero failed lines

#### Scenario: Reporting a bug fix
- **WHEN** an agent claims a bug is fixed
- **THEN** the same message MUST contain a test run that demonstrates
  the original symptom (e.g. `1 failed`) before the fix, and a green
  run after the fix — or, at minimum, a green run that exercises the
  exact failing path

#### Scenario: Multiple files changed
- **WHEN** the agent changes code, tests, configuration, and documentation
  in a single task
- **THEN** the final "all done" claim MUST be backed by a single
  full-suite run output (e.g. `npx vitest run`), not by per-file
  partial runs that may have been shown earlier

### Requirement: TDD red-green cycle MUST be observable for regression tests
The system SHALL require that any regression test added to lock in a bug
fix follows a verifiable red-green cycle: write test → run (must fail with
the original symptom) → implement fix → run (must pass) → revert fix →
run (must fail again, proving the test is non-vacuous) → restore fix →
run (must pass). Skipping the red demonstration is NOT acceptable.

**Rationale:** A test that "passes" before the fix proves nothing — it
could be vacuously true. The red-then-green-then-red sequence is the
only way to prove the test actually exercises the bug.

#### Scenario: Adding a regression test
- **WHEN** the agent adds a test in response to a reported bug
- **THEN** the agent MUST run the test against the unfixed code first
  and observe a failure that points at the reported bug
- **AND** the failure message MUST appear in the agent's output before
  the fix is applied

#### Scenario: Reversing the fix to validate the test
- **WHEN** the fix is in place and the regression test is green
- **THEN** the agent MUST temporarily revert the fix, re-run the test
  to confirm it fails, then restore the fix and re-run to confirm
  it passes again

### Requirement: Runtime-affecting changes MUST be verified end-to-end against a real process
The system SHALL require that changes affecting request routing, URL
composition, server startup, or other runtime behaviors are verified by
spawning the actual server process (not by reasoning from the code) and
exercising the behavior with real HTTP requests. The verification MUST
record what the upstream received (via a mock that captures path /
headers / body) so the result is observable.

**Rationale:** Unit tests cover the pieces; only an end-to-end run
proves the pieces compose into the right behavior at runtime. This
project's history includes bugs that passed all unit tests but broke
the first end-to-end run (e.g. the `/v1/v1/messages` double-prefix bug
in `server/routes/providers.ts`).

#### Scenario: URL composition fix
- **WHEN** the agent changes code that composes the upstream URL
- **THEN** the agent MUST start the server, configure a provider whose
  baseUrl matches the documented convention, send a real request through
  the proxy, and assert the recorded upstream path is correct
  (no double-prefix, no missing prefix)

#### Scenario: Test-connection behavior change
- **WHEN** the agent changes the test-connection endpoint's URL composition
- **THEN** the agent MUST verify that the test-connection URL and the
  proxy-forwarded URL resolve to the same upstream path (they are
  the same behavior and MUST be tested together)

### Requirement: Documentation and configuration changes MUST be re-read for internal consistency
The system SHALL require that any change to user-facing documentation
(README, in-app help, project specs) or local configuration files
(`~/.lucent/config.json`, project `opencode.json`) is followed by a
full re-read of the modified artifact to verify internal consistency.
Specifically: every example URL in the document MUST compose correctly
with the rules stated in the same document.

**Rationale:** Documentation drift is the silent failure mode — it
looks correct in isolation but contradicts itself. A second read catches
what a first write misses.

#### Scenario: README path-rules table
- **WHEN** the agent updates a table showing "Base URL → client appends → full path"
- **THEN** the agent MUST re-read the table and verify that for each row,
  "Base URL" + "what the client appends" equals the "full path" column
- **AND** any commands in the same document (e.g. `export ...=...`) MUST
  match the corresponding row of the table

#### Scenario: Local user config
- **WHEN** the agent modifies `~/.lucent/config.json` or any local config
  on the user's behalf
- **THEN** the agent MUST back up the file first (e.g. `cp config.json
  config.json.bak-YYYYMMDD`)
- **AND** the agent MUST show the diff (before vs. after) before
  claiming the change is complete
