---
status: accepted
---

# Normalized events are a closed set, mapped from official Claude hook names

AgentBar exposes exactly eight lowercase normalized events (`session_start`,
`pre_tool_use`, `post_tool_use`, `permission_request`, `notification`,
`stop`, `session_end`, `error`) and seven statuses. The installer maps
Claude's official hook names onto them; `PostToolUseFailure` and
`StopFailure` both map to `error`, and there is no invented Claude hook
called `Error`. We chose a closed, AgentBar-owned vocabulary over passing
Claude's names through so the state contract and the GNOME extension never
depend on Claude renaming or adding hooks: a new Claude hook is a mapping
change in the installer, not a schema change. The original payload is kept
verbatim in `raw` for diagnostics only; nothing in the UI may depend on it.

## Consequences

- `notification` is classified only from the structured `notification_type`
  field, never from message text, so unknown kinds become `unknown` rather
  than a guessed status.
- Adding a status or event is a contract change and requires an ADR update
  and a `schemaVersion` bump (see ADR-0003).
