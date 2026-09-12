---
status: accepted
---

# Local files are the only integration point between capture and UI

The hook receiver and the GNOME extension communicate through two files under
`~/.local/state/agentbar/`: an atomically replaced `state.json` snapshot of
every known session, and an append-only `events.jsonl` history. Writers hold
a shared lock, write a temp file, and `rename()` it into place; readers
watch the directory for the rename. We rejected a daemon, D-Bus service,
socket, or SQLite database because they add a long-running process to
install, start, and debug for what is a few kilobytes of state, and because
"no daemon, no database, no network" is a product promise. The snapshot
carries an integer `schemaVersion`; the reader treats an unknown or missing
version, malformed JSON, or an unreadable file as "unavailable", never as
success and never as a crash.

## Consequences

- The contract must stay small, versioned, and independent of GNOME and of
  Claude's raw payload shape.
- The two files are not a transaction: history may run ahead of the snapshot
  after a crash. Snapshot repair from history is an explicit command (T702),
  not something hooks do silently.
- Files are `0600` in a `0700` directory; state is per-user and never shared.
