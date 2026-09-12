---
status: accepted
---

# Hook installation is preview-first, exact-ownership, and never blocks Claude

`agentbar install-hooks` prints the proposed configuration and changes
nothing by default; mutation requires an explicit apply flag, a validated
parse of the existing settings, and a restricted-permission timestamped
backup written before an atomic replace. Backup failure aborts the apply.
AgentBar identifies its own handlers by the exact receiver executable and
argument pattern, not a substring, so uninstall can never remove a user's
own hook. The receiver writes nothing to stdout, exits `1` (never Claude's
blocking `2`) on capture failure, and emits no permission decisions, so a
broken AgentBar can only lose an event, never stall or steer Claude. We
chose this over a one-shot "just merge it" installer because the settings
file is the user's, is shared with other tools, and is the single most
damaging thing a monitoring tool could corrupt.

## Consequences

- Install and uninstall transforms are pure functions over parsed settings,
  tested against mixed custom hooks on the same event, and idempotent.
- Uninstall prunes only containers that AgentBar's removal emptied.
- Tests inject settings and backup paths; no test touches real user settings.
- Package scripts (see ADR-0006) never call the installer.
