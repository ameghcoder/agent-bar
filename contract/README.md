# AgentBar contract

The language-neutral description of AgentBar's data (ADR 0007). A renderer or
agent adapter in any language reads these files instead of the TypeScript.

- `state.schema.json`: `state.json`, schema version 1. JSON Schema 2020-12.
- `event.schema.json`: one normalized event, one line of `events.jsonl`.
- `presentation.json`: per-status label, intent, priority, and notification
  urgency, plus the limits every reader applies (stale threshold, 24-hour
  retention, 1 MiB snapshot cap, 18-character title name, 10-second liveness
  check), and the "Ended" rule for a session whose process is gone.
- `fixtures/`: conformance cases. Each holds a snapshot, a clock (`now`), and
  the exact view the presentation model must produce. Ordering, staleness, the
  leader choice, and notification transitions are logic, not data, so a port
  reimplements them and must reproduce every fixture exactly.

`test/contract.test.mjs` holds these files equal to the TypeScript
implementation and runs the fixtures, so the two cannot drift. Changing the
contract is a deliberate act: update the TypeScript, these files, and the
fixtures together, and an incompatible change needs a `schemaVersion` bump and
an ADR.
