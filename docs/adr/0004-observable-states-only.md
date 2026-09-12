---
status: accepted
---

# Show only observed states; derive staleness in the presentation layer

The top bar shows only what a hook event proved: running, waiting,
permission required, turn complete, failed, idle, or unknown. We will not
show percentage progress, elapsed-time estimates, or anything inferred from
transcripts, because Claude Code emits no signal that would make such a
number honest, and a wrong number is worse than none. `Stop` is labelled
"Turn complete", not "Done": it ends a turn, not a project. Staleness is not
a persisted status: the extension derives it from `lastSeenAt` against a
named threshold at render time, and shows it as "status unknown/stale",
never as failure or completion, because a missing event is not evidence of
anything. Notifications fire once per meaningful transition per session,
deduped by a stable key, and never on startup replay of old state.

## Consequences

- Presentation logic (labels, priority, ordering, stale, notification
  decisions) is pure and tested outside GNOME Shell.
- The default view model excludes `raw`, prompts, tool input, and full
  project paths; a short path hint may appear in the menu only to
  disambiguate duplicate project names.
