# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

Infer the repo from `git remote -v`; `gh` does this automatically when run inside a clone.

## Writing for a public tracker

The repository is public: every issue, comment, and closing note is part of
the project's record, read by contributors who were never in the
conversation that produced it. Write each one as documentation for them.

### When to open an issue

Open one for a change to AgentBar itself: a bug, a feature, a docs or
packaging change, a test gap, or approved scope split with `/to-tickets`.
A small fix made inside an existing task's commit rides on that task's issue.
Work kept outside the repository (launch videos, marketing assets, the
maintainer's local scripts) is tracked in `.temp/` and gets no issue.

### Title

The outcome in plain words, as an imperative: "Cap the event history at
10 MB". The issue number is the identifier; local schedule IDs from `.temp/`
stay out of titles.

### Body

```markdown
## Problem
What is wrong or missing, who runs into it, and how to see it
(steps, a command, or an example).

## Why it matters
The user-visible effect or the risk.

## Change
What will be done, and which files or modules it touches.

## Acceptance criteria
- [ ] Observable, testable outcomes.

## Context
Related ADRs, docs, and issues; the supported environment where relevant.
```

Keep the body self-contained:

- Summarise evidence in the issue (the command run and its result, the
  environment) rather than pointing at `.temp/` or a chat.
- Record a maintainer decision as the decision plus its reason, e.g.
  "Failed tool calls stay Working: Claude carries on after them."
- Use generic examples: `/home/dev/project`, placeholder session IDs. Real
  home paths, email addresses, tokens, prompts, transcript content, and
  `events.jsonl` excerpts stay off the tracker.
- Link the ADR when the change makes or follows a design decision.

### Comments and closing

- A scope change or decision gets a comment with its reason, so the thread
  reads correctly start to finish.
- A closing comment states what landed (commit hashes or PR), how it was
  verified (tests, commands, the environment of any manual check), and the
  release that ships it.
- Closing without the work done uses the triage vocabulary
  (`docs/agents/triage-labels.md`) and one line of reason.
- When an issue's body turns out wrong, edit the body so it stays the source
  of truth, and note the edit in a comment. An issue opened by mistake is
  closed as not planned with a one-line reason; delete one only when it
  exposes private data.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

When set to `yes`, PRs run through the same labels and states as issues, using the `gh pr` equivalents:

- **Read a PR**: `gh pr view <number> --comments` and `gh pr diff <number>` for the diff.
- **List external PRs for triage**: `gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments` then keep only `authorAssociation` of `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, or `NONE` (drop `OWNER`/`MEMBER`/`COLLABORATOR`).
- **Comment / label / close**: `gh pr comment`, `gh pr edit --add-label`/`--remove-label`, `gh pr close`.

GitHub shares one number space across issues and PRs, so a bare `#42` may be either: resolve with `gh pr view 42` and fall back to `gh issue view 42`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets.

- **Map**: a single issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body. `gh issue create --label wayfinder:map`.
- **Child ticket**: an issue linked to the map as a GitHub sub-issue (`gh api` on the sub-issues endpoint). Where sub-issues aren't enabled, add the child to a task list in the map body and put `Part of #<map>` at the top of the child body. Labels: `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`). Once claimed, the ticket is assigned to the driving dev.
- **Blocking**: GitHub's **native issue dependencies**, the canonical, UI-visible representation. Add an edge with `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`, where `<blocker-db-id>` is the blocker's numeric **database id** (`gh api repos/<owner>/<repo>/issues/<n> --jq .id`, _not_ the `#number` or `node_id`). GitHub reports `issue_dependencies_summary.blocked_by` (open blockers only, the live gate). Where dependencies aren't available, fall back to a `Blocked by: #<n>, #<n>` line at the top of the child body. A ticket is unblocked when every blocker is closed.
- **Frontier query**: list the map's open children (`gh issue list --state open`, scoped to the map's sub-issues / task list), drop any with an open blocker (`issue_dependencies_summary.blocked_by > 0`, or an open issue in the `Blocked by` line) or an assignee; first in map order wins.
- **Claim**: `gh issue edit <n> --add-assignee @me`, the session's first write.
- **Resolve**: `gh issue comment <n> --body "<answer>"`, then `gh issue close <n>`, then append a context pointer (gist + link) to the map's Decisions-so-far.

## AgentBar conventions

- One issue per task ID. Title format: `T201: Version the extension-facing
  state contract`. Gates: `GATE M2: Activation safety review`.
- The issue body carries Outcome, Work, and Acceptance criteria from
  `.temp/tasks.md`. Blockers use GitHub issue dependencies (fallback:
  `Blocked by: #n` line).
- Labels: `P0`/`P1`/`P2` for priority, `M0`..`M6` for milestone, plus the
  triage vocabulary in `triage-labels.md`.
- `.temp/tasks.md` is gitignored and keeps only the schedule and each task's
  `### Evidence` (exact commands, results, screenshots). Status and blockers
  live on the issue.
- Commits reference the issue (`Closes #n`). Commit locally after the task's
  tests pass; never push. The user reviews and pushes manually.
