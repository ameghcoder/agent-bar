# AgentBar

AgentBar is a local-first Ubuntu GNOME top-bar companion for Claude Code. It
shows observable Claude activity while the developer works in another window.

## Read first

Before changing code, read:

1. `CONTEXT.md` for product language and invariants.
2. Accepted records in `docs/adr/` for architectural constraints, and
   `docs/architecture.md` for module boundaries and the presentation contract.
3. The active GitHub issue for the task, blockers, and acceptance criteria;
   `.temp/tasks.md` for the schedule and recorded test evidence.
4. `README.md`, `package.json`, and the code involved in the active task.

If documentation and code disagree, stop and describe the mismatch. Do not
silently rewrite either side.

## Current baseline

AgentBar 0.2.0 is released on GitHub as an unsigned `.deb`: the Claude Code
hook adapter, atomic multi-session capture (raw payload kept, history capped
at 10 MiB, concurrent writes locked), the GNOME Shell 50 extension with
liveness and click-to-focus, preview-first hook install, and `agentbar
doctor`. The suite covers these guarantees and the dependency direction in
ADR 0007; preserve both.

Changes now reach real users: every published build gets a new version, a
`CHANGELOG.md` entry, and release notes in `docs/release-notes/`.

## Product invariants

- Never show percentage progress.
- `Stop` means the current Claude turn completed, not the whole project.
- A successful tool call means Claude may still be running.
- Permission state remains pending until a later observable event replaces it.
- Missing events are not success. Old active states become visibly stale.
- `raw` payload data is diagnostic data. Do not render secrets, prompts, tool
  input, or arbitrary raw fields in the top bar.
- All data stays local. No telemetry or network calls.
- Multiple sessions must remain independent.
- Hook handlers must be fast, non-blocking in normal use, and must never control
  whether Claude is allowed to proceed.
- Existing Claude settings belong to the user. Preserve them byte-for-byte where
  practical and semantically always.

## Engineering rules

- Use TypeScript and the existing pnpm/Node toolchain for the CLI and core.
- Use GJS and GNOME Shell APIs for the extension.
- Keep the state contract small, versioned, and independent of GNOME APIs.
- Keep normalization, persistence, presentation, and installation as separate
  modules with narrow interfaces.
- Prefer the existing Node test runner and repository conventions. Do not add a
  test framework only for style.
- Use atomic writes for any mutable JSON configuration or state.
- Set restrictive permissions on user state and backups.
- Treat malformed, missing, oversized, or newer-schema state as recoverable UI
  conditions. The extension must not crash GNOME Shell.
- Do not read Claude transcripts or infer hidden reasoning.
- Keep each change scoped to its issue; a broad refactor gets its own issue
  first.

## Validation

Before marking a task complete:

- Run the narrow failing test first for behavior changes.
- Run typecheck, build, and the complete automated test suite using commands
  discovered from `package.json`.
- For extension changes, reload the extension and inspect GNOME Shell logs.
- For visual changes, capture a real screenshot at the tested resolution.
- Record exact commands and results under the task's Evidence section.

Never claim a command passed unless it was run in the current worktree.

## Agent skills

### Issue tracker

Work is tracked as GitHub issues in the public repository
`ameghcoder/agent-bar` via `gh`. Outside contributors read every issue and
comment, so before you create, comment on, or close one, follow "Writing for
a public tracker" in `docs/agents/issue-tracker.md`. The rules every issue
keeps:

- An issue is for a change to AgentBar itself: code, docs, packaging, tests.
  Work that lives outside the repository (launch videos, marketing, local
  tooling) is tracked in `.temp/` only.
- An issue stands on its own: problem, why it matters, the change, and
  acceptance criteria, readable by a stranger with only the repository.
- A closing comment says what landed (commits), how it was verified, and
  which release ships it.

`.temp/tasks.md` is the maintainer's local schedule and evidence log. It adds
detail to an issue; the issue carries everything a reader needs.

### Triage labels

Use the default Matt Pocock triage vocabulary. See
`docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repository: vocabulary lives in `CONTEXT.md` and
decisions live in `docs/adr/`. See `docs/agents/domain.md`.

### Skill routing

- `/setup-matt-pocock-skills`: reconcile the repository's agent workflow once.
- `/grill-with-docs`: resolve a real product or architecture ambiguity and
  update context/ADRs.
- `/tdd`: implement behavior one red-green-refactor slice at a time.
- `/diagnosing-bugs`: diagnose failures that resist one focused inspection.
- `/code-review`: review every milestone diff against standards and task scope.
- `/to-tickets`: split newly approved scope into GitHub issues using the task
  ID and label conventions in `docs/agents/issue-tracker.md`.
- `/improve-codebase-architecture`: run when a concrete design problem shows
  up, and track the result in its own issue.

## Task discipline

- Work on one task ID at a time.
- Respect `Blocked by` edges.
- P0 is what the next release needs. P1 and P2 wait unless the user promotes
  them.
- Update task status as `todo`, `in_progress`, `blocked`, or `done`.
- A task is `done` only after its acceptance criteria and evidence are complete.
- At milestone gates, stop and give the user a short demo-oriented report.
- Per task: create (following the issue rules above) or claim the GitHub
  issue, implement, run the full suite, commit locally with `Closes #n`.
  Never `git push`. The user reviews the code and pushes manually.

