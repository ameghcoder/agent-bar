# Agents

An agent adapter connects one coding agent to AgentBar (ADR 0007). Today there
is one: [`claude-code/`](claude-code/). Everything after the normalized event
(capture, `state.json`, presentation, the GNOME extension) is shared and does
not change when an agent is added.

## An adapter's three jobs

1. **Translate.** Turn one native payload into one normalized event
   (`contract/event.schema.json`), and supply the agent's own rules for an
   existing session, through a `CaptureAdapter` (`src/core/state.ts`):
   - `normalize()` builds the event from the payload.
   - `reconcile(event, previous)` sees the session's last saved state and
     returns the event to record. Claude Code uses it to keep an active status
     across auto-compaction and to keep a stable project path.
2. **Register.** Install itself into the agent safely: preview first, back up,
   apply atomically, and recognise only its own entries (ADR 0005). Claude
   Code's version is `claude-code/install/`.
3. **Diagnose.** Contribute its own `agentbar doctor` checks.

## Rules

- Import only `src/core` and your own folder. Never another agent, never
  `os/`. `test/layout.test.mjs` enforces this.
- Map only what the agent actually emits to the observable statuses in
  `CONTEXT.md`. A guess is `unknown`, never success. No percentage progress.
- Keep native payloads in the event's `raw` field for diagnosis. Nothing from
  `raw` is ever rendered.
- Never read the agent's transcripts or infer hidden reasoning.
- Hook handlers must be fast and must never decide whether the agent may
  proceed.
- Add native-payload fixtures and tests in your own folder.

## Before a second agent lands: known Claude-shaped parts

These were left as they are on purpose until a real second agent exists, so
the change is shaped by two examples rather than guessed:

- `source` in the state and event schemas is the literal `"claude-code"`.
- Session IDs are not namespaced by agent, so two agents could collide.
- The event type vocabulary (`session_start`, `pre_tool_use`, ...) follows
  Claude Code's hooks.
- The TypeScript type for the normalized event is still named `ClaudeEvent`.

Changing the first three is an incompatible state change: it needs a
`schemaVersion` bump, a migration for version 1 files, and its own ADR. An
adapter written in another language would also need a way to hand events to
capture without writing `state.json` itself (for example an
`agentbar ingest --agent <id>` command); that is deferred until such an
adapter exists.

## Adding an agent

1. Open an issue describing the agent's events and how it can be hooked.
2. Write the ADR for the schema changes above.
3. Create `agents/<agent-id>/` with translate, register, and diagnose, plus
   fixtures and tests.
4. Wire its commands into `src/cli/index.ts`, the one composition root.
