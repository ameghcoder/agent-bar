# AgentBar Domain Context

## Product promise

AgentBar lets an Ubuntu developer see when Claude Code is working, waiting for
attention, finished with a turn, or failed without switching back to the Claude
terminal.

## Primary user

A developer on Ubuntu GNOME who runs Claude Code in a terminal, moves to another
project or window, and otherwise misses permission prompts and completion.

## Ubiquitous language

| Term | Meaning |
| --- | --- |
| AgentBar | The complete local product: capture CLI, state contract, GNOME extension, and installer. |
| Claude session | One Claude Code session identified by Claude's `session_id` or a stable fallback. |
| Turn | Work Claude performs after one user prompt until `Stop` or `StopFailure`. |
| Hook event | A lifecycle signal emitted by Claude Code and delivered as JSON on stdin. |
| Normalized event | AgentBar's stable, lowercase representation of a supported Claude hook event. |
| Session snapshot | The latest observable state for every known Claude session. |
| Event history | Append-only JSONL records used for diagnostics, not the primary UI read path. |
| Active state | `running`, `waiting`, or `permission_required`. |
| Attention state | A state that should visibly alert the user: permission required, waiting for input, or failed. |
| Turn complete | Claude emitted `Stop`; this does not mean the session or project ended. |
| Stale | A derived condition where an active snapshot has not been refreshed within the configured threshold. It is not proof of a crash. |
| Indicator | The compact AgentBar item shown in the GNOME top bar. |
| Session row | One project/session entry in the indicator dropdown. |
| Hook installation | Adding AgentBar-owned hook handlers to the user's Claude settings while preserving all unrelated settings. |
| Doctor | A read-only diagnostic command that checks the local AgentBar integration. |
| Supported environment | An Ubuntu release and GNOME Shell version tested end to end and listed in the support matrix. |

## Observable statuses

| Status | Meaning | UI intent |
| --- | --- | --- |
| `idle` | Session started, resumed, or ended without current work. | Quiet neutral state. |
| `running` | Claude is processing observable work or completed a tool and may continue. | Active, low-interruption state. |
| `waiting` | Claude emitted an input/idle notification. | Attention requested. |
| `permission_required` | Claude emitted a permission request or permission notification. | Highest-priority attention state. |
| `completed` | Claude emitted `Stop` for the current turn. | Notify once, then remain readable. |
| `failed` | A tool or turn failure was observed. | Error attention state. |
| `unknown` | The event or readable state cannot be classified safely. | Honest fallback, never success. |

Staleness is presentation metadata applied to an active state. It must be shown
as "status unknown/stale", never as a confirmed failure or completion.

## Current completed capability

- TypeScript/Node project managed by pnpm.
- Commander commands `agentbar install-hooks [--apply]`,
  `agentbar uninstall-hooks [--apply]`, and `agentbar-hook --event <event>`.
- Supported normalized events: `session_start`, `pre_tool_use`,
  `post_tool_use`, `permission_request`, `notification`, `stop`, `session_end`,
  and `error`.
- Stdin JSON validation, 10 MiB input limit, raw payload preservation, stable
  fallback session IDs, and clear failure behavior.
- Atomic `state.json` with integer `schemaVersion`, append-only
  `events.jsonl`, restrictive permissions, locking, and safe multi-session
  updates under the XDG state directory; one `parseSnapshot` validator with
  typed malformed/invalid/unsupported-version results.
- Preview-first hook install and uninstall: pure merge engine, exact-ownership
  matching, timestamped `0600` backup, atomic replace, idempotent.
- Twenty-eight integration tests, including 24 concurrent hook processes.

## Current gaps

- No GNOME top-bar interface.
- No read-only doctor command.
- No explicit permission grant/denial observation.
- No crash detection, stale presentation, retention, rotation, or history-based
  snapshot repair.
- No `.deb` package or tested installation/uninstallation flow.

## Scope boundary for v1 beta

In scope:

- Claude Code only.
- Ubuntu GNOME only.
- A compact top-bar indicator and session dropdown.
- Real status/attention notifications based on captured events.
- Safe per-user hook setup and removal.
- Local state, diagnostics, and `.deb` distribution.

Out of scope:

- Gemini, Codex, ChatGPT, IDE agent APIs, macOS, Windows, KDE, and Cinnamon.
- Percentage progress, transcript reading, prompt display, token/cost analytics,
  team dashboards, cloud sync, accounts, licensing enforcement, and auto-update.
- Theme marketplace or deep visual customization.

## Success criteria

- Permission-needed and turn-complete states are visible within two seconds of
  the corresponding state-file update on the tested machine.
- A malformed or partially unavailable state never crashes GNOME Shell.
- Installing or removing AgentBar never removes unrelated Claude settings.
- Two simultaneous Claude sessions remain distinguishable by project.
- A clean install and clean uninstall succeed on every claimed supported
  environment.

