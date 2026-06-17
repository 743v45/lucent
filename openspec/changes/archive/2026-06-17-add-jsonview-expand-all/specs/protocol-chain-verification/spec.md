## ADDED Requirements

### Requirement: Web UI Request/Response tabs MUST support a user-triggered "Expand All" action to reveal deeply nested fields
The system MUST provide an "Expand All" button in the Request and Response
tab body toolbars. By default, the JsonBlock component MUST keep its
current folding behavior (collapsed to level 2) so large bodies do not
cause UI lag. When the user clicks "Expand All", the JsonBlock MUST
expand all nested levels (no folding), and the button label MUST toggle
to "Collapse All".

**Rationale:** The default folding level hides objects inside arrays
(e.g. `messages: [{}, {}]`), making it impossible to inspect a single
message's `role` and `content`. The "Expand All" action gives users
explicit control without sacrificing the default's protection against
performance issues with large bodies.

#### Scenario: Default folding keeps messages array items as empty objects
- **WHEN** the user opens a log entry's Request tab for a request that has
  a `messages` array with N items
- **THEN** the JsonBlock text MUST contain the pattern `messages:[{},{}]`
  (each message rendered as `{}` because level-2 folding hides its fields)
- **AND** an "Expand All" button MUST be visible in the body toolbar

#### Scenario: Clicking "Expand All" reveals nested object fields
- **WHEN** the user clicks the "Expand All" button
- **THEN** the JsonBlock MUST render each `messages` array item with its
  fields visible (e.g. `role`, `content`)
- **AND** the pattern `messages:[{},{}]` MUST no longer appear
- **AND** the button label MUST change to "Collapse All"

#### Scenario: Clicking "Collapse All" restores default folding
- **WHEN** the user clicks the "Collapse All" button after expanding
- **THEN** the JsonBlock MUST return to the default folding state
  (messages array items rendered as `{}`)
- **AND** the button label MUST change back to "Expand All"
