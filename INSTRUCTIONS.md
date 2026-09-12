# AgentBar Execution Instructions

This file is the bootstrap prompt for Claude Code. Place this planning kit at the
root of the existing AgentBar repository, then start Claude Code from that root.

## First command

Tell Claude Code:

> Read `INSTRUCTIONS.md`, `CLAUDE.md`, `CONTEXT.md`, every accepted ADR in
> `docs/adr/`, and `.temp/tasks.md`. Inspect the actual repository and
> `package.json` before editing. Reconcile these planning files with the code;
> preserve correct existing behavior and user changes. Execute only task `T000`
> first, report the evidence, then stop for my approval.

## Matt Pocock skills

Install the managed Claude Code plugin once if it is not already installed:

```text
claude plugins install mattpocock-skills
```

Do not also install the copied `skills.sh` version. Installing both duplicates
every skill.

From a Claude Code session, run this once per repository:

```text
/setup-matt-pocock-skills
```

Use these AgentBar choices when the setup skill asks:

- Issue tracker: GitHub Issues in `ameghcoder/agent-bar` via `gh`.
- Evidence log and schedule: `.temp/tasks.md` (gitignored; not a source of
  truth for status or blockers).
- Triage labels: keep the defaults.
- Domain docs: single context at `CONTEXT.md`, with ADRs in `docs/adr/`.
- Agent instruction file: update the existing `CLAUDE.md`; do not create a
  parallel `AGENTS.md`.

The setup skill may update `CLAUDE.md` and `docs/agents/`. It must merge with
the supplied content rather than replacing AgentBar-specific instructions.

## Required working loop

For each active task (one GitHub issue per task ID):

1. Confirm all blocking issues are closed.
2. Read the relevant ADRs and repository code.
3. Use `/grill-with-docs` only when a product or architecture decision is still
   genuinely unresolved. Record the decision before implementation.
4. Use `/tdd` for behavior-bearing TypeScript and state-transition work.
5. Implement one task only. Keep the diff small enough to review in one context.
6. Run the task's tests and the full existing test suite.
7. Update the GitHub issue (status, checked acceptance criteria) and record
   exact commands and concise evidence under the task in `.temp/tasks.md`.
8. Use `/code-review` at every milestone gate. Resolve high-severity findings
   before moving to the next milestone.
9. Commit locally with `Closes #n` once the task's tests pass. Never push;
   the user reviews and pushes manually after code review.

Use `/diagnosing-bugs` when a failure is not explained after one focused
inspection. Use `/to-tickets` only when new scope is approved; create GitHub
issues following `docs/agents/issue-tracker.md` and add matching evidence
sections to `.temp/tasks.md`.

## Non-negotiable scope

- Product: Claude Code visibility for Ubuntu GNOME.
- UI: GNOME Shell top-bar extension, not Electron, React, or a web dashboard.
- Data: local files only. No account, analytics, telemetry, or network service.
- Progress: observable states only. Never invent a percentage or expose chain
  of thought.
- Compatibility: officially claim only Ubuntu and GNOME versions tested on real
  machines or VMs.
- Existing capture behavior is a compatibility contract. Do not rewrite it
  without a failing test that proves a user-visible need.

## Stop conditions

Stop and ask the user before:

- changing the public event or state schema incompatibly;
- adding a runtime, database, daemon, framework, or network dependency;
- changing the supported Ubuntu/GNOME range;
- changing Claude settings without a preview, backup, and explicit apply step;
- implementing licensing, payment, other coding agents, macOS, KDE, or themes;
- deleting or weakening an existing test;
- proceeding when the repository differs materially from `CONTEXT.md`.

## Definition of launchable beta

The beta is launchable only when all P0 tasks through milestone M6 are complete,
the release gate in `.temp/tasks.md` passes, and a clean Ubuntu user can:

1. install the `.deb`;
2. run AgentBar's hook setup command;
3. enable or reload the extension;
4. start Claude Code;
5. see running, permission-needed, waiting, completed, failed, idle, and stale
   behavior without opening the Claude terminal;
6. uninstall AgentBar without losing unrelated Claude settings.

