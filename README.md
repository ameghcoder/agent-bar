# AgentBar

AgentBar is a local-first Ubuntu/GNOME top-bar companion for Claude Code. It will show observable activity while you work in another window.

Current scope: **Day 1 hook capture only**. This repository contains a TypeScript CLI, a JSON state snapshot, and JSONL event history. No GNOME extension, UI, database, server, auth, or progress percentages.

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
pnpm agentbar install-hooks
# Save just the generated JSON to a separate file:
pnpm --silent agentbar install-hooks > /tmp/agentbar-hooks.json
```

The helper only prints configuration. It uses quoted absolute paths to the current Node executable and built receiver, so hooks work from other projects without pnpm on Claude's PATH. Regenerate if you move the repository or Node installation.

Merge the generated event entries into the `hooks` object in `~/.claude/settings.json` for all projects, or `.claude/settings.local.json` for one project. Append to existing arrays for the same event and preserve other settings. Restart Claude Code after merging. Do not replace an existing settings file with the generated snippet.

`examples/claude-hooks-settings.example.json` is a portable template; replace its placeholder path or use the helper. Config structure and event names follow the [official Claude Code hook reference](https://code.claude.com/docs/en/hooks). It registers the seven matching lifecycle hooks and maps `PostToolUseFailure` and `StopFailure` to AgentBar's `error`; there is no invented Claude hook named `Error`. Older Claude versions may lack `StopFailure`.

## Observable state

| AgentBar event | Status |
| --- | --- |
| `session_start` | `idle` |
| `pre_tool_use` | `running` (tool about to run) |
| `post_tool_use` | `running` (tool finished; turn may continue) |
| `notification` | `permission_required` for `permission_prompt`; `waiting` for `idle_prompt`, elicitation dialogs, or `agent_needs_input`; otherwise `unknown` |
| `permission_request` | `permission_required` |
| `stop` | `completed` (response ended) |
| `session_end` | `idle` (session ended) |
| `error` | `failed` (observed tool or turn failure) |

Status describes the last captured event, not a guarantee that the whole task succeeded. A tool error may be followed by recovery. A stop may be followed by another turn. Unknown notifications do not infer activity from message text. This Day 1 subset does not capture thinking before the first tool call, permission decisions themselves, parallel tool aggregation, or process exits without hooks.

Every history record has `id`, `timestamp`, `source`, `projectPath`, `projectName`, `sessionId`, `eventType`, `status`, `message`, and the original parsed `raw` object. IDs are UUIDs; timestamps are local capture times in UTC. Missing `cwd` falls back to the receiver's working directory.

## Storage and failure handling

Default files are `~/.local/state/agentbar/state.json` and `~/.local/state/agentbar/events.jsonl`. `AGENTBAR_STATE_DIR` can override the directory with an absolute path; `XDG_STATE_HOME` is not used. Folders are created automatically. New state directories use mode `0700`; new data files use `0600`.

The snapshot contains `updatedAt` and `sessions`. Each session stores `sessionId`, `projectName`, `projectPath`, `source`, `status`, `lastEventType`, `lastMessage`, `startedAt`, and `lastSeenAt`. `startedAt` means first observation, since capture can begin mid-session. Named session IDs identify rows even when the working directory changes. Ended rows remain available; no retention policy is implemented yet.

Writes use a shared lock, a temporary file, and an atomic rename. The future reader should reopen the snapshot after changes, and watch its directory because the file is replaced. History is appended before the snapshot is replaced. These are two files, not a transaction: a crash between writes can leave history ahead of state, and there is no power-loss durability guarantee or automatic replay yet. Locks abandoned by crashed writers become eligible for recovery after 10 seconds; normal lock contention retries for roughly 12–18 seconds.

Blank input is accepted as `{}`; non-object JSON, malformed JSON, unsupported arguments, and input over 10 MiB produce a useful stderr message and exit code 1. Success emits no stdout and exit code 0. Capture errors do not use Claude's blocking exit code 2 or emit permission decisions. Invalid existing state is preserved and reported; back it up and move it aside before retrying.

Raw payloads can include tool inputs, outputs, and local paths. All storage stays local; history grows until you archive or remove it. No transcript files are read and no network calls are made at runtime.

## Day 2

Validate the hooks against a real Claude Code session, including permission prompts, failure recovery, and two simultaneous projects. Add prompt-submission capture and decide how to represent stale sessions and parallel activity. Then build the smallest GNOME reader: monitor the state directory, reopen the snapshot, show an aggregate icon, and list each session's project, status, and last message in a menu. Keep capture independent of the extension.
