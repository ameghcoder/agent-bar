# AgentBar

AgentBar is a local-first Ubuntu/GNOME top-bar companion for Claude Code. It will show observable activity while you work in another window.

Current scope: **hook capture, safe hook installation, and a minimal GNOME Shell indicator**. This repository contains a TypeScript CLI, a versioned JSON state snapshot, JSONL event history, and a GJS extension that does not yet read state. No database, server, auth, or progress percentages.

## Setup

Requires Node.js 22+ and pnpm 11.

```sh
pnpm install
pnpm build
pnpm test
```

Build again after changing TypeScript. `pnpm typecheck` checks types without emitting files. Commander provides the command and option parsing. `proper-lockfile` serializes writes from simultaneous hook processes and recovers abandoned locks.

## Capture an event

From this repository:

```sh
echo '{"session_id":"test-1","cwd":"/home/me/project"}' | pnpm agentbar-hook --event session_start
echo '{"tool_name":"Edit","cwd":"/home/me/project"}' | pnpm agentbar-hook --event pre_tool_use
echo '{"message":"Claude needs permission","cwd":"/home/me/project"}' | pnpm agentbar-hook --event permission_request

cat ~/.local/state/agentbar/state.json
cat ~/.local/state/agentbar/events.jsonl
```

These exact examples produce two session rows: `test-1` and an `unknown:<project hash>` fallback for the two inputs without `session_id`. AgentBar never guesses which named session an incomplete event belongs to. Missing IDs in the same project share that fallback; different projects get different fallbacks. Claude's regular hook payload includes a session ID. Include it on every fake event to exercise one session:

```sh
echo '{"session_id":"test-1","cwd":"/home/me/project","tool_name":"Edit"}' | pnpm agentbar-hook --event pre_tool_use
echo '{"session_id":"test-1","cwd":"/home/me/project","message":"Claude needs permission"}' | pnpm agentbar-hook --event permission_request
echo '{"session_id":"test-1","cwd":"/home/me/project","notification_type":"idle_prompt"}' | pnpm agentbar-hook --event notification
echo '{"session_id":"test-1","cwd":"/home/me/project"}' | pnpm agentbar-hook --event stop
echo '{"session_id":"test-1","cwd":"/home/me/project","error":"Example tool failure"}' | pnpm agentbar-hook --event error
echo '{"session_id":"test-1","cwd":"/home/me/project","reason":"prompt_input_exit"}' | pnpm agentbar-hook --event session_end
```

To isolate manual tests, run `export AGENTBAR_STATE_DIR="$(mktemp -d /tmp/agentbar-manual.XXXXXX)"` first, then inspect `"$AGENTBAR_STATE_DIR/state.json"` and `"$AGENTBAR_STATE_DIR/events.jsonl"`. Run `unset AGENTBAR_STATE_DIR` to restore the default. Automated tests always use temporary directories.

Without pnpm, the equivalent receiver command is `node /absolute/path/to/agentbar/dist/hooks/claude-hook.js --event pre_tool_use`. The package also declares the `agentbar` and `agentbar-hook` executable entry points for package linking; no global installation is needed.

## Configure Claude Code

```sh
pnpm agentbar install-hooks            # preview: prints the hooks JSON, changes nothing
pnpm agentbar install-hooks --apply    # merge into ~/.claude/settings.json after a backup
pnpm agentbar uninstall-hooks          # preview removal
pnpm agentbar uninstall-hooks --apply  # remove AgentBar handlers only
```

Without `--apply` nothing is written: the generated hooks JSON goes to stdout and a per-event summary of what would change goes to stderr. Generated commands use quoted absolute paths to the current Node executable and built receiver, so hooks work from other projects without pnpm on Claude's PATH. Regenerate and re-apply if you move the repository or Node installation.

With `--apply`:

- The settings file is `$CLAUDE_CONFIG_DIR/settings.json` if that variable is set, else `~/.claude/settings.json`. Override with `--settings <path>` (for example `.claude/settings.local.json` for one project).
- The current file must parse as a JSON object with a well-formed `hooks` section, or nothing is changed.
- If the file exists it is first copied to `<name>.agentbar-backup-<timestamp>-<id>` (mode `0600`) next to it, or under `--backup-dir <dir>`. A backup failure aborts the apply.
- The new content is written to a temporary file and renamed into place. A new file is `0600`; an existing file keeps its mode minus any group/world write bits.
- Unrelated settings, other hooks, and matcher groups are preserved. AgentBar adds one handler per Claude event and recognises its own handlers by their exact command shape, so re-applying is a no-op, a handler left pointing at a moved checkout or replaced Node binary is updated in place, and uninstall never removes a hook it did not create. A symlinked settings file is followed: the link is kept and the target is what changes. Containers emptied by an uninstall are pruned; ones that were already empty are left alone.

Restart Claude Code after applying either command.

`examples/claude-hooks-settings.example.json` is a portable template; replace its placeholder path or use the helper. Config structure and event names follow the [official Claude Code hook reference](https://code.claude.com/docs/en/hooks). It registers the seven matching lifecycle hooks and maps `PostToolUseFailure` and `StopFailure` to AgentBar's `error`; there is no invented Claude hook named `Error`. Older Claude versions may lack `StopFailure`.

## GNOME Shell extension (development)

The extension lives in `extension/` (UUID `agentbar@ameghcoder.github.io`) and targets **GNOME Shell 50 on Ubuntu 26.04 LTS (Wayland)**, the only environment tested so far. It is a plain GNOME 45+ ESM extension: `metadata.json`, `extension.js`, `stylesheet.css`, plus a generated `lib/` (below).

`pnpm build` copies the portable, `node:`-free core modules (`vocabulary.js`, `snapshot.js`, `presentation.js`) into `extension/lib/`, so the extension reads live state through the exact same reader and presentation logic Node's tests run, with no `dist/` or `node_modules` dependency at runtime. `extension/lib/state-reader.js` is hand-authored (not generated): a Shell-independent `StateWatcher` (only `gi://GLib` and `gi://Gio`) that watches the state directory, debounces real filesystem noise into one re-read, and falls back to a periodic timer both to catch missed events and to re-attach the directory monitor if the state directory did not exist yet when watching began. Run `pnpm build` before `install`; the three copied modules in `extension/lib/` are generated and gitignored, while `state-reader.js` is tracked.

```sh
pnpm build                          # also refreshes extension/lib/ - do this after any core change
scripts/extension-dev.sh install    # symlink extension/ into ~/.local/share/gnome-shell/extensions/
scripts/extension-dev.sh enable     # or disable / status
scripts/extension-dev.sh logs       # follow GNOME Shell's journal for AgentBar lines and JS errors
scripts/extension-dev.sh pack DIR   # validate metadata and build a zip, including extension/lib
scripts/extension-dev.sh devkit     # nested GNOME Shell for iteration (needs the mutter-dev-bin package for a window)
```

On Wayland a newly installed extension is picked up at the next login, and code changes to an already loaded extension need a logout/login or a nested session; `gnome-extensions enable`/`disable` themselves work live. `pnpm test` checks the metadata, that `extension.js` and `extension/lib/state-reader.js` parse and import only `gi://`, `resource:///org/gnome/shell/`, or their own portable siblings, that the generated `lib/` files are exact copies of `dist/core/` and stay untouched by hand edits, and that packing actually includes `lib/` (`gnome-extensions pack` does not bundle subdirectories without `--extra-source`, which the script passes). It also drives the real `StateWatcher` under the real `gjs` runtime against real atomic renames of a temporary state file - not a mock - covering missing/valid/malformed/future-schema/recovered states and notification dedupe in one scripted run.

By default the extension reads `~/.local/state/agentbar/state.json`, same as the CLI. Setting `AGENTBAR_STATE_DIR` before GNOME Shell starts points it at another directory, for development.

## Diagnose

```sh
pnpm agentbar doctor
```

Read-only. Prints one `PASS`, `WARN`, or `FAIL` line per check (AgentBar and Node versions, state directory and snapshot, Claude settings and AgentBar hooks, GNOME Shell, display session, extensions tool) and exits 1 if a required check fails. Missing optional tools are warnings. Paths are shown relative to `~`; the output never includes hook payloads, session or project names, or settings content, so it is safe to paste into a bug report. `--settings <path>` points it at a different settings file.

## Observable state

| AgentBar event | Status |
| --- | --- |
| `session_start` | `idle` for `source` `startup`, `clear`, `resume`, or missing; for `compact` (auto-compaction, which can happen mid-turn) an active status (`running`, `waiting`, `permission_required`) on the same session is kept |
| `pre_tool_use` | `running` (tool about to run) |
| `post_tool_use` | `running` (tool finished; turn may continue) |
| `notification` | `permission_required` for `permission_prompt`; `waiting` for `idle_prompt`, elicitation dialogs, or `agent_needs_input`; otherwise `unknown` |
| `permission_request` | `permission_required` |
| `stop` | `completed` (response ended) |
| `session_end` | `idle` (session ended) |
| `error` | `failed` (observed tool or turn failure) |

`lastMessage` is a presentation string: the first non-blank line of the source text, whitespace collapsed, capped at 120 characters. A raw `message` field replaces the generated text only for `notification` and `permission_request`, the events where Claude authors a user-facing message; on every other event it is ignored. For `error`, the first line of `error` or `error_details` is used and the full text stays in `raw` only.

Status describes the last captured event, not a guarantee that the whole task succeeded. A tool error may be followed by recovery. A stop may be followed by another turn. Unknown notifications do not infer activity from message text. This Day 1 subset does not capture thinking before the first tool call, permission decisions themselves, parallel tool aggregation, or process exits without hooks.

The snapshot contains `schemaVersion`; history records do not. Every history record has `id`, `timestamp`, `source`, `projectPath`, `projectName`, `sessionId`, `eventType`, `status`, `message`, and the original parsed `raw` object. IDs are UUIDs; timestamps are local capture times in UTC. Missing `cwd` falls back to the receiver's working directory.

## Presentation model

`src/core/presentation.ts` turns a parsed snapshot plus the current time into
one `IndicatorView`: an aggregate status for the top bar, ordered session rows
for the menu, and the notification decisions. It is pure and has no imports, so
the same compiled file runs under Node's tests and loads in GJS.

Status priority, menu ordering, the staleness threshold and its clock-skew
behaviour, notification dedupe, and the fields deliberately kept out of the view
are specified in [`docs/architecture.md`](docs/architecture.md).

## Storage and failure handling

Default files are `~/.local/state/agentbar/state.json` and `~/.local/state/agentbar/events.jsonl`. `AGENTBAR_STATE_DIR` can override the directory with an absolute path; `XDG_STATE_HOME` is not used. Folders are created automatically. New state directories use mode `0700`; new data files use `0600`.

The snapshot contains integer `schemaVersion` (currently `1`), `updatedAt`, and `sessions`. Each session stores `sessionId`, `projectName`, `projectPath`, `source`, `status`, `lastEventType`, `lastMessage`, `startedAt`, and `lastSeenAt`. `startedAt` means first observation, since capture can begin mid-session. Named session IDs identify rows even when the working directory changes. A session with no event for 24 hours (`sessionRetentionMs`, in `src/core/snapshot.ts`) is dropped from `state.json` on the next capture by any session, and the extension ignores it even before then. `events.jsonl` is never pruned and still grows until you archive or remove it.

### Snapshot compatibility

`src/core/snapshot.ts` exports `parseSnapshot(text)`, the one validator for the state contract. It never throws; it returns `{ ok: true, state, legacy }` or `{ ok: false, reason, message }` with `reason` one of `malformed_json`, `invalid_shape`, or `unsupported_version`. Readers such as the GNOME extension must treat every failure as "state unavailable", never as success or failure of a session.

- A snapshot without `schemaVersion` (the pre-versioned beta shape) parses as version 1 with `legacy: true`; the next hook write upgrades the file in place.
- A snapshot whose `schemaVersion` is anything other than the integer `1` is `unsupported_version`. The hook exits 1 and leaves the file untouched so a newer writer's data is never clobbered.
- Adding a status, event type, or required field is a contract change and bumps `schemaVersion`.

Fixtures for each case live in `test/fixtures/` (`snapshot-v1.json`, `snapshot-legacy.json`, `snapshot-future.json`, `snapshot-malformed.txt`) so a non-Node reader can test against the same inputs.

Writes use a shared lock, a temporary file, and an atomic rename. The future reader should reopen the snapshot after changes, and watch its directory because the file is replaced. History is appended before the snapshot is replaced. These are two files, not a transaction: a crash between writes can leave history ahead of state, and there is no power-loss durability guarantee or automatic replay yet. Locks abandoned by crashed writers become eligible for recovery after 10 seconds; normal lock contention retries for roughly 12–18 seconds.

Blank input is accepted as `{}`; non-object JSON, malformed JSON, unsupported arguments, and input over 10 MiB produce a useful stderr message and exit code 1. Success emits no stdout and exit code 0. Capture errors do not use Claude's blocking exit code 2 or emit permission decisions. Invalid existing state is preserved and reported; back it up and move it aside before retrying.

Raw payloads can include tool inputs, outputs, and local paths. All storage stays local; history grows until you archive or remove it. No transcript files are read and no network calls are made at runtime.

## Day 2

Validate the hooks against a real Claude Code session, including permission prompts, failure recovery, and two simultaneous projects. Add prompt-submission capture and decide how to represent stale sessions and parallel activity. Then build the smallest GNOME reader: monitor the state directory, reopen the snapshot, show an aggregate icon, and list each session's project, status, and last message in a menu. Keep capture independent of the extension.
