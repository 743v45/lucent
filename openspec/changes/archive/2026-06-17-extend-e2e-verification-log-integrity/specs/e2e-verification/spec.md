## ADDED Requirements

### Requirement: The verification script MUST assert that logged request bodies are complete (no delta truncation)
The script MUST send at least two consecutive requests through the same
provider/endpoint and assert that the resulting log entries each contain
the complete `body.messages` array (matching what the client sent), with
no truncation, slicing, or emptying. This guards against regressions of
the delta-storage bug removed in the `remove-delta-storage` change.

**Rationale:** The delta-storage bug emptied `body.messages` in the logs
and was only caught by manual inspection. The verification script must
mechanically assert log completeness so this class of bug cannot recur
silently.

#### Scenario: Two consecutive identical requests both log complete body
- **GIVEN** the script has sent two consecutive requests to the same
  custom provider with `body.messages` containing N messages
- **WHEN** the script reads the latest log file
- **THEN** the two most recent entries for that provider MUST each have
  `body.messages.length === N`
- **AND** the script MUST fail (non-zero exit) if either entry has an
  empty or truncated `body.messages`

### Requirement: The verification script MUST assert that log entries carry no delta-encoding metadata
The script MUST scan all log entries produced during the run and assert
that none of them contain any of the following fields:
`_deltaFormat`, `_isCheckpoint`, `_totalMessageCount`, `_conversationId`
(when used as a delta tag), `_inPlaceReplaceDetected`. These fields were
artifacts of the removed delta-storage mechanism and MUST NOT reappear.

**Rationale:** Dead metadata in logs creates confusion (readers may
believe the data is delta-encoded) and signals that delta logic has
crept back in. The verification script must catch any reintroduction.

#### Scenario: Fresh run produces no delta metadata
- **WHEN** the script reads the log file produced during the run
- **THEN** no entry MUST contain any of the five delta-encoding fields
- **AND** the script MUST fail (non-zero exit) if any entry has any of
  them
