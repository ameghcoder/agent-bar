---
status: accepted
---

# Record the agent's process and check that it is still running

A session today ends only when Claude sends `SessionEnd`. Closing the terminal,
a crash, or `kill` sends nothing, so the session sits in its last state until it
goes stale after 10 minutes and expires after 24 hours: an old "Permission
needed" can be shown for a Claude that no longer exists. The opposite case is
also real: a long tool call emits no events for an hour while Claude is alive,
and AgentBar can only say "No updates".

Claude Code gives every hook command its own process ID in `CLAUDE_PID`
(verified 2026-10-09 on Claude Code 2.1.294: the hook's parent process is that
PID, named `claude`). That is an observable fact AgentBar can use without
reading any user content.

## Decision

- **Capture records the agent's process.** Each session gains an optional
  `agentProcess: { pid, start }`, overwritten on every event so a resumed
  session points at its current process. `start` is an opaque per-OS identity
  token; on Linux it is the `starttime` field of `/proc/<pid>/stat`. A PID
  alone is not enough, because the kernel reuses PIDs; the pair is.
- **Only `/proc/<pid>/stat` is read**, by the hook and by the extension. Never
  `cmdline`, `environ`, or any file the process has open.
- **The extension checks liveness every 10 seconds** (`livenessIntervalMs`),
  only for sessions that have an `agentProcess`, by re-reading that one small
  file per session. A missing file or a different `start` means the process is
  gone. No file is written and nothing runs when no session has a process.
- **The result is input to the pure presentation model**, like the clock:
  `presentSnapshot(state, { now, liveness })`, where `liveness` maps a session
  to `alive` or `ended`. A session not in the map is unknown and behaves
  exactly as today.
- **An ended session reads "Ended"**, with the quiet intent. It is never stale,
  never counted in `+N`, never notifies, and leads the title only when no other
  session exists. It stays in the menu until the 24-hour retention removes it.
  Its last observed status is not shown as current: a dead process is not
  waiting for permission.
- **An alive session still goes stale.** A live process proves Claude is open,
  not that it is working (ADR 0004: a missing event is not evidence). The
  title keeps "No updates"; the menu row adds "Claude open" so a long tool call
  is distinguishable from a closed terminal.
- **The field is additive**, so `schemaVersion` stays 1. Older readers ignore
  it. The parser drops a malformed `agentProcess` rather than rejecting the
  snapshot: liveness is an aid, and its absence must never hide sessions.
- **Linux only for now.** The token reader lives with the code that needs it:
  capture in `src/core` behind a platform check (returns nothing elsewhere),
  the check in `os/linux/gnome-shell`. Other OSes record no process until
  someone implements and tests them there.

## Consequences

- The same `pid` lets the extension find the session's terminal or editor
  window (T403) by walking parent processes, again through `/proc/<pid>/stat`.
- If `CLAUDE_PID` is missing (older Claude Code), nothing is recorded and
  AgentBar behaves exactly as before.
- `contract/` gains the optional field, the "Ended" label, and fixtures for
  ended and alive sessions.
- A session that ends and is resumed in a new process becomes alive again on
  its next event, because every event overwrites `agentProcess`.

## Acceptance (2026-10-09)

Accepted by the project owner, including the wording "Ended" for a session
whose process is gone and "Claude open" for a stale session whose process
still runs.
