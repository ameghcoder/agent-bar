# How AgentBar works

A guided tour for developers, with diagrams. It explains the flow from a
Claude Code hook to the pixels in the top bar. The exact rules (priorities,
thresholds, edge cases) live in [architecture.md](architecture.md), and the
reasons behind them in the [decision records](adr/). Building and running a
checkout is covered in [development.md](development.md).

## The idea in one paragraph

Claude Code runs a small command, a **hook**, at moments that matter: before
and after a tool runs, when it needs permission, when a turn ends. AgentBar's
hook turns each of those into one normalized event and saves the current
state of every session in one local JSON file. A GNOME Shell extension
watches that file and draws it. The two halves never talk to each other: the
file is the whole contract ([ADR 0003](adr/0003-local-file-state-contract.md)).
So capture works even when the extension is off, and the extension shows
"State unavailable", never a guess, if the file is missing a piece it needs.

## The big picture

```mermaid
flowchart LR
    subgraph CC["Claude Code"]
        C["claude process"]
    end
    subgraph Capture["Capture: Node, one short process per hook call"]
        H["agentbar-hook<br/>agents/claude-code/hooks"]
        T["Claude adapter<br/>agents/claude-code/translate.ts"]
        S["captureEvent<br/>src/core/state.ts"]
    end
    subgraph Files["~/.local/state/agentbar/"]
        F[("state.json<br/>current sessions")]
        J[("events.jsonl<br/>history")]
    end
    subgraph Shell["GNOME Shell extension: GJS, inside the desktop"]
        W["StateWatcher<br/>lib/state-reader.js"]
        P["presentSnapshot<br/>lib/presentation.js (pure)"]
        E["extension.js<br/>top bar, menu, banners"]
    end
    U(["you"])

    C -- "hook command<br/>JSON on stdin" --> H
    H --> T --> S
    S -- "atomic rename" --> F
    S -- "append" --> J
    F -. "file monitor" .-> W
    W --> P --> E --> U
```

| Part | Language | Runs | Folder |
| --- | --- | --- | --- |
| Hook receiver and `agentbar` CLI | TypeScript on Node | Once per hook call, then exits | `agents/claude-code/`, `src/cli/` |
| Capture, snapshot, presentation | TypeScript, no GNOME imports | Inside the hook, and copied into the extension | `src/core/` |
| Extension | JavaScript (GJS) | Inside GNOME Shell, always | `os/linux/gnome-shell/` |
| Data contract | JSON Schema and fixtures | Read by tests and by future ports | `contract/` |

## One event, end to end

What happens when Claude asks for permission while you are in another window:

```mermaid
sequenceDiagram
    autonumber
    participant Claude as Claude Code
    participant Hook as agentbar-hook
    participant Core as captureEvent
    participant File as state.json
    participant Watch as StateWatcher
    participant Shell as extension.js

    Claude->>Hook: run hook command, payload JSON on stdin
    Hook->>Core: claudeCodeCapture(event, payload)
    Core->>Core: take the write lock
    Core->>Core: normalize: status permission_required, project root, process id
    Core->>Core: reconcile with the session's previous state
    Core->>File: write temp file, append events.jsonl, rename over state.json
    Core-->>Hook: done (lock released)
    Hook-->>Claude: exit 0, nothing on stdout
    File-->>Watch: directory changed
    Watch->>Watch: wait 200 ms for the burst to settle
    Watch->>File: read (refused if over 1 MiB)
    Watch->>Watch: parse, drop sessions older than 24 h, check processes
    Watch->>Shell: new view and one notification
    Shell->>Shell: title "project - Permission needed - just now", icon pulses
    Shell->>Shell: critical banner "Permission needed" with the project name
```

The hook takes about 50 ms, almost all of it Node starting. It never writes to
stdout and exits 1, never 2, on failure, so it can never block or approve
anything in Claude Code.

## Inside capture

```mermaid
flowchart TD
    A["Claude runs:<br/>'/usr/bin/node' '.../claude-hook.js' --event permission_request"] --> B["read stdin<br/>empty is {}; over 10 MiB is an error"]
    B --> C["lock the state directory<br/>(proper-lockfile, survives crashed writers)"]
    C --> D["read state.json<br/>refuse to overwrite a file it cannot parse"]
    D --> E["adapter.normalize()<br/>Claude hook to status and safe message<br/>project = CLAUDE_PROJECT_DIR, else cwd<br/>process = CLAUDE_PID + start time from /proc"]
    E --> F["find the session by id"]
    F --> G["adapter.reconcile(event, previous)<br/>keep an active status across auto-compaction<br/>keep the first project path when there is no CLAUDE_PROJECT_DIR"]
    G --> H["core keeps the event's id, session id, and timestamp"]
    H --> I["update the session, drop sessions idle for 24 h"]
    I --> J["write temp file (0600), append events.jsonl, rename"]
    J --> K["unlock, exit 0"]
```

Core never imports the Claude adapter; the adapter is passed in
(`CaptureAdapter`, [ADR 0007](adr/0007-os-agent-contract-repository-structure.md)).
That is the seam a second coding agent would plug into.

### Which hook becomes which state

| Claude Code hook | AgentBar state |
| --- | --- |
| `SessionStart` | Idle (an auto-compaction keeps the state it interrupted) |
| `PreToolUse`, `PostToolUse` | Working |
| `PostToolUseFailure` | Working: a failed command is routine |
| `Notification` (permission prompt) | Permission needed |
| `Notification` (idle prompt, input request) | Waiting for you |
| `PermissionRequest` | Permission needed; Waiting for you for `AskUserQuestion` |
| `Stop` | Turn complete |
| `StopFailure` | Failed |
| `SessionEnd` | Idle |

## Inside the extension

```mermaid
flowchart TD
    subgraph Triggers
        M["file monitor on the state directory"]
        FB["every 30 s: re-read and re-attach the monitor"]
        LV["every 10 s, only while a session has a process:<br/>re-check processes"]
    end
    M --> DB["debounce 200 ms"]
    DB --> R["read state.json<br/>newest read wins; older overlapping reads are dropped"]
    FB --> R
    R -->|"missing"| EMPTY["empty view: AgentBar - No sessions"]
    R -->|"too big, malformed, newer schema, unreadable"| UN["State unavailable<br/>reported once until a good read"]
    R -->|"valid"| X["drop sessions older than 24 h"]
    X --> L["liveness: /proc/pid/stat<br/>same start time = alive, else ended"]
    LV --> L
    L --> PS["presentSnapshot(state, now, liveness)<br/>pure: title, intent, rows, health"]
    PS --> NF["notificationsFor(previous, next)<br/>one per status change, none at startup"]
    PS --> V["onView: title, icon, pulse, rows, health line"]
    NF --> B["onNotifications: GNOME banners"]
```

`presentation.js`, `snapshot.js`, and `vocabulary.js` are the compiled
TypeScript from `src/core`, copied into the extension at build time. The
extension and the Node tests run the exact same rules.

## Session states

```mermaid
stateDiagram-v2
    [*] --> Idle: SessionStart
    Idle --> Working: PreToolUse
    Working --> Working: PostToolUse, failed tool call
    Working --> PermissionNeeded: permission prompt
    Working --> WaitingForYou: idle prompt, question
    PermissionNeeded --> Working: next tool event
    WaitingForYou --> Working: next tool event
    Working --> TurnComplete: Stop
    Working --> Failed: StopFailure
    TurnComplete --> Working: next prompt's first tool
    Failed --> Working: next tool event
    TurnComplete --> Idle: SessionEnd
    Idle --> [*]: no event for 24 h
```

Two things sit on top of these states. They are worked out when the view is
drawn and never saved:

- **No updates (stale).** Working, Waiting for you, or Permission needed with
  no event for 10 minutes. The top bar stops claiming the state, and the menu
  still shows what was last observed. A missing event is not evidence of
  anything ([ADR 0004](adr/0004-observable-states-only.md)).
- **Ended.** The Claude process recorded with the session is gone, or its PID
  now belongs to another process ([ADR 0008](adr/0008-agent-process-liveness.md)).
  It is never attention, never notifies, and leads the top bar only when every
  session has ended.

## Which session the top bar shows

```mermaid
flowchart TD
    A["all sessions"] --> B{"any not ended?"}
    B -->|no| Z["pool = all (every one ended)"]
    B -->|yes| C{"any of those fresh?"}
    C -->|yes| D["pool = fresh sessions"]
    C -->|no| Y["pool = stale sessions"]
    D --> P["leader = highest priority in the pool<br/>permission > failed > waiting > working > complete > unknown > idle<br/>ties: attention first, then most recent"]
    Y --> P
    Z --> P
    P --> T["title = project - State - time ago<br/>+N = other fresh sessions that are Working"]
```

## Clicking a session

```mermaid
flowchart TD
    O["menu opens"] --> Q["for each row: is its Claude process still the recorded one?"]
    Q -->|no| N["row stays inert"]
    Q -->|yes| A["walk parent processes via /proc/pid/stat<br/>claude, bash, ptyxis-agent, ptyxis ..."]
    A --> W["windows owned by the nearest such process"]
    W -->|none| N
    W -->|one| OK["row is clickable"]
    W -->|several| TI{"exactly one title contains the project name?"}
    TI -->|yes| OK
    TI -->|no| N
    OK --> CL["click: look it up again, then Main.activateWindow"]
```

Terminals such as Ptyxis and GNOME Terminal, and VS Code, run every window from
one process, hence the title check. AgentBar never brings forward a window it
is unsure of. Window titles are only compared, never logged or stored.

## Installing, and when things take effect

```mermaid
sequenceDiagram
    participant You
    participant apt
    participant CLI as agentbar
    participant Claude as Claude Code
    participant Shell as GNOME Shell

    You->>apt: sudo apt install ./agentbar_version_all.deb
    apt-->>You: files in /usr/bin, /usr/lib/agentbar, /usr/share/gnome-shell/extensions (no scripts run)
    You->>CLI: agentbar install-hooks --apply
    CLI-->>You: backup written, 9 hooks added to ~/.claude/settings.json
    You->>Claude: restart
    Claude-->>Claude: hooks active from now on
    You->>Shell: log out and in
    Shell-->>Shell: finds the new extension
    You->>Shell: gnome-extensions enable agentbar@ameghcoder.github.io
    Shell-->>You: indicator in the top bar
```

The package deliberately does nothing per user: it never edits your settings,
enables the extension, or touches your home folder
([ADR 0006](adr/0006-deb-distribution.md)). The hooks name `/usr/bin/node`
and the installed receiver by absolute path, so they work from any project
and are unaffected by Node version managers.

## Where the code lives

```mermaid
flowchart BT
    core["src/core<br/>capture, snapshot, presentation"]
    contract["contract/<br/>schemas and fixtures"]
    claude["agents/claude-code<br/>hook, translation, install, doctor checks"]
    linux["os/linux<br/>extension, packaging, GNOME doctor checks"]
    doctor["src/doctor<br/>runner"]
    cli["src/cli<br/>agentbar commands"]
    claude --> core
    linux --> core
    doctor --> core
    cli --> claude
    cli --> linux
    cli --> doctor
    contract -. "kept equal by tests" .- core
```

Arrows point at what a folder may import. `test/layout.test.mjs` fails the
build if code crosses these lines: core never imports an agent or an OS
folder, and agents and OS folders never import each other.

## Where to change what

| You want to | Look at |
| --- | --- |
| Map a Claude hook to a different state | `agents/claude-code/translate.ts`, then the payload fixtures in `agents/claude-code/fixtures/` |
| Change wording, priority, the stale threshold, or notifications | `src/core/presentation.ts`, then `contract/presentation.json` and `contract/fixtures/` |
| Change what is saved | `src/core/snapshot.ts` and `contract/state.schema.json`; an incompatible change needs a new `schemaVersion` and an ADR |
| Change how the top bar or menu looks | `os/linux/gnome-shell/extension.js` and `stylesheet.css` |
| Change how the file is watched | `os/linux/gnome-shell/lib/state-reader.js` |
| Add another coding agent | [agents/README.md](../agents/README.md) |
| Change the package | `os/linux/packaging/` |

After any change: `pnpm typecheck` and `pnpm test`. Extension changes also
need a nested GNOME Shell or a logout and login; see
[development.md](development.md).
