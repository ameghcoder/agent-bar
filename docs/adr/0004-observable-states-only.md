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

## Amendment (2026-10-06): top-bar wording for stale sessions

The principle is unchanged: a stale session is never shown as a confirmed
state, failure, or completion. What changed is the words. A bare "Status
unknown" in the top bar told the user nothing and, because the leader was
chosen by status priority alone, an old stale request could hide a fresh
session. The top bar now reads `<project> - <State> - <time ago>` for the
leading fresh session, with `+N` for other fresh running sessions. Stale sessions only lead when nothing fresh exists, and then
the bar reads `<project> - No updates - <time ago>`: what we actually know (how long it has been
quiet), not a guessed state. The menu row still names the last observed status.

## Amendment (2026-10-07): notification dedupe and content

"Deduped by a stable key" is implemented as: notify when a session's status
differs between two consecutive views. No separate key is stored, because
nothing consumed one. Notification text is the status label and the project
name only. The session's last message is Claude-authored and is never shown
in a notification.

