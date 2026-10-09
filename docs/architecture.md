# Architecture

AgentBar is four modules with narrow interfaces. Claude Code invokes the
**capture** receiver, which normalizes a hook payload and writes it to local
**state**. The **presentation** model turns that state into what the user sees.
The GNOME Shell **extension** renders it. **Installation** and **doctor** exist
so the first two can be wired up and checked safely.

```
Claude hook -> agents/claude-code (translate) -> src/core/state -> state.json
                                                                    |
                                       src/core/snapshot (parse) <--+
                                                  |
                                       src/core/presentation (pure)
                                                  |
                                os/linux/gnome-shell (GJS)
```

Data flows one way. Nothing downstream of `state.json` can affect capture, and
capture never waits on the extension.

## Where code lives (ADR 0007)

| Folder | Owns | May import |
|---|---|---|
| `contract/` | JSON Schemas, presentation rules as data, fixtures | nothing |
| `src/core/` | capture (lock, timestamp, retention, atomic write), snapshot parsing, presentation, paths, version | only `src/core` |
| `agents/claude-code/` | the receiver, payload translation, compaction carry-over, project root, hook install/merge, Claude doctor checks | `src/core`, itself |
| `os/linux/` | the GNOME Shell extension, its scripts, GNOME doctor checks | `src/core` (via the copied `lib/`), itself |
| `src/doctor/` | the doctor runner, AgentBar's own checks, report formatting | `src/core` |
| `src/cli/` | the `agentbar` commands: the one place that composes agents and OS | anything |

`test/layout.test.mjs` checks these rules on the real import statements.
Capture in `src/core/state.ts` takes a `CaptureAdapter` (`normalize`,
`reconcile`) as an argument, so core never imports an agent; the Claude
adapter builds one with `claudeCodeCapture` in `agents/claude-code/translate.ts`.

## The contract

`contract/` is the language-neutral copy of the state schema, the normalized
event, and the presentation rules, with conformance fixtures (ADR 0007, see
`contract/README.md`). `test/contract.test.mjs` holds it equal to the
TypeScript below, so a change to one without the other fails the suite.

## The presentation model

`src/core/presentation.ts` converts a parsed snapshot plus the current time into
one `IndicatorView`. It is pure: same snapshot and same clock, same view. It
holds every decision about what the user sees, so all of it is testable without
GNOME Shell (`test/presentation.test.mjs`).

It imports only *types*, so the compiled `dist/src/core/presentation.js` has no
imports at all and GJS can load the same file Node tests. A test enforces this.

### Status priority

When sessions disagree, the top bar shows one status. Most urgent first:

| Priority | Status | Label | Intent | Why here |
| --- | --- | --- | --- | --- |
| 7 | `permission_required` | Permission needed | attention | Blocks Claude until you decide. |
| 6 | `failed` | Failed | error | Something observably broke; you should look. |
| 5 | `waiting` | Waiting for you | attention | Asks for input, but nothing is broken. |
| 4 | `running` | Working | active | Informational; no action needed. |
| 3 | `completed` | Turn complete | complete | A turn ended. Not the project (ADR 0004). |
| 2 | `unknown` | Status unknown | unknown | Unclassifiable is not quiet. |
| 1 | `idle` | Idle | quiet | Nothing to say. |

`intent` is the visual vocabulary the extension styles against. It is
deliberately not a colour: the renderer decides that.

### Project name

A session's `projectPath` is the project root, and `projectName` is its last
path segment. The root comes from `CLAUDE_PROJECT_DIR`, which Claude Code sets
for hook commands (verified 2026-10-08 with a real hook event whose payload
`cwd` was `…/agent-bar/src` while the recorded root was `…/agent-bar`). The
payload's `cwd` follows the shell into subdirectories mid-session (the event
history showed one session under eight different directory names), so it is
only the fallback. Without `CLAUDE_PROJECT_DIR`, a session keeps the path it
was first seen with. An empty or relative value is ignored. Nothing beyond the
hook's own environment and payload is read.

### The top-bar title

`IndicatorView.title` is the complete top-bar text, built here so every renderer
shows the same words and none computes them:

- Fresh leader: `<project> - <Label> - <time ago>`, plus ` +N` where N is the
  number of *other fresh sessions whose status is `running`*. Waiting,
  permission, idle, completed, failed, and stale sessions are not counted: the
  first two are blocked on you rather than running, and the menu shows them.
- Only stale sessions: `<project> - No updates - <time ago>`.
- No sessions: `AgentBar - No sessions`.
- The project name is cut to 18 characters with an ellipsis. No path hint, and
  nothing from `raw`, ever appears in the title.
- `leaderId` names the session the title describes. The time text changes every
  minute, so a renderer keys animation on `leaderId` and status, never on the
  title.

The leader is the highest-priority session among the *fresh* ones, ties broken
by the menu order below. Stale sessions lead only when none are fresh, so an old
unanswered request can no longer hide the session you are using now.

### The health line

`IndicatorView.health` is one neutral line shown above the version row. It is
derived from the newest readable `lastSeenAt` across all sessions: no sessions is
`No events yet · run "agentbar install-hooks"`; newer than the stale window is
`Receiving events · <time ago>`; older is `No recent events · <time ago>`; no
readable timestamp is `No recent events`. It states only what the state file
proves. It never claims hooks are installed or missing (that is
`agentbar doctor`) and carries no session data. The extension adds the one case
the view cannot express, `State unavailable`, when the file cannot be read.

### Ordering in the menu

Attention states (`permission_required`, `waiting`, `failed`) sort above
everything else. Within each group, most recently seen first, with session ID as
the tiebreak so the list never reshuffles between identical reads.

Note this differs from the priority table on purpose: priority answers "what one
word goes in the top bar", ordering answers "what do I read first". Inside the
attention group, a failure from a minute ago sits above a permission request
from ten minutes ago, because the recent thing is the thing you were doing.

### Staleness

Staleness is derived at render time from `lastSeenAt` against
`defaultStaleAfterMs` (10 minutes). It is never persisted and never a status.

Ten minutes, not five: a single long `Bash` call emits nothing between
`pre_tool_use` and `post_tool_use`, so a few silent minutes are normal.

Only **active** states (`running`, `waiting`, `permission_required`) go stale. A
`completed` turn, an observed `failed`, and `idle` are settled facts that do not
decay.

A stale session keeps the status it was last observed in — a permission request
stays pending until an event replaces it, per the product invariant. What
changes is confidence: its `intent` drops to `unknown`, and the top bar never
claims "Permission needed" for it. A stale session only leads the aggregate when
no fresh session exists; then `title` reads `<project> - No updates - <time ago>`
(ADR 0004 amendment). The menu row still names the observed status, so the fact
is not lost, only the certainty.

Degenerate clocks degrade safely. A future `lastSeenAt` (clock ran backwards) is
treated as fresh. An unparseable one is treated as stale, because a value we
cannot read cannot prove freshness, and `NaN >= threshold` is `false` — which
would silently claim the session is fine.

### Liveness (ADR 0008)

Capture records the agent's process as `agentProcess: { pid, start }`: Claude
Code passes its PID to hooks in `CLAUDE_PID`, and `start` is the `starttime`
field of `/proc/<pid>/stat`, so a reused PID never matches. `StateWatcher`
re-reads that one file per session every `livenessIntervalMs` (10 s), only for
sessions that recorded a process, and republishes only when a session's
liveness changes. The result is passed to `presentSnapshot` as
`options.liveness`; a session not in the map is unknown and presented as
before.

An **ended** session (file gone or `start` differs) reads "Ended" with the quiet
intent: never stale, never attention, never in `+N`, never a notification, and
it leads the title only when every session has ended. An **alive** session
still goes stale after 10 minutes, because a running process proves Claude is
open, not that it is working; its menu row adds "Claude open". Only
`/proc/<pid>/stat` is ever read, never `cmdline` or `environ`.

### Retention

Separate from staleness: a session whose `lastSeenAt` is more than 24 hours
old (`sessionRetentionMs`, `src/core/snapshot.ts`) is gone, whatever its
status. The writer drops it from `state.json` on every capture, and
`StateWatcher` drops it before presenting, so an idle machine with a long-lived
extension stays clean. `presentSnapshot` deliberately does not apply it: it
stays pure and import-free (asserted by a test) and shows whatever it is given.
A future or unreadable timestamp is kept, not expired. History is never pruned.

### Notifications

`notificationsFor(previous, next)` decides *when* to notify; the extension
decides *how* (T305).

- One notification per transition *into* `permission_required`, `waiting`,
  `failed`, or `completed`. Transitions into `running`, `idle`, or `unknown` are
  silent.
- `previous === undefined` yields nothing, so restarting GNOME Shell never
  replays old state as new alerts (ADR 0004).
- A transition is a session's status differing between two consecutive views.
  The same snapshot read twice notifies nothing; a second permission request
  after work in between notifies again.
- Title is the status label and body is the project name, nothing else. The
  session's `message` is never used: Claude writes it for permission,
  notification, and failure events, so it may hold a command, a path, or an
  error dump.
- The first view `StateWatcher` publishes is the baseline, even when earlier
  reads were unavailable: nothing proves its contents are newer than the reader.
- Going stale is not an event and raises nothing.

### What never reaches the view

`raw`, prompts, tool input, and the full project path stay out of the view
model. The only path-derived field is `hint`: the parent directory name, added
only when two sessions share a project name, as ADR 0004 permits.

## Reaching the GNOME extension

`src/core/vocabulary.ts` holds the fixed vocabulary (`EventType`, `Status`,
`JsonObject`, `isRecord`) with zero imports. `src/core/snapshot.ts` imports
only from it, so its compiled output imports one relative sibling file and
never a `node:` module. `src/core/presentation.ts` imports only *types*, so it
compiles to zero imports at all. Both properties are asserted by tests, not
left as convention, because the extension depends on them.

`pnpm build` copies `vocabulary.js`, `snapshot.js`, and `presentation.js` from
`dist/src/core/` into `os/linux/gnome-shell/lib/` (`os/linux/scripts/copy-extension-lib.mjs`). The
extension imports these exact compiled files - the same reader and
presentation logic Node's tests exercise - with no `dist/` or `node_modules`
dependency at runtime. `os/linux/gnome-shell/lib/state-reader.js` is hand-authored, not
generated: a `StateWatcher` built only on `gi://GLib` and `gi://Gio`, so it has
no dependency on Shell UI classes (`St`, `Clutter`, `PanelMenu`, `Main`) and
runs headlessly under the plain `gjs` interpreter. `test/state-reader.test.mjs`
uses exactly that to drive it for real against a real temporary directory and
real atomic renames, rather than mocking the filesystem or GNOME APIs.

`os/linux/gnome-shell/extension.js` is the one Shell-dependent file: it owns the
`PanelMenu.Button`, renders `IndicatorView` fields (`intent` chooses the icon;
`title` is the top-bar text; `health` is the menu's health line) and builds menu rows from `sessions`, and
forwards `StateWatcher`'s callbacks. It never computes a status, priority,
staleness, or notification urgency itself - including urgency, which it
would be tempting to infer from `intent` in the Shell layer, but `intent`
collapses `waiting` and `permission_required` into the same value and
urgency must not. `notificationsFor` (`src/core/presentation.ts`) decides it
explicitly per status - `permission_required` critical, `failed` high,
`waiting` normal, `completed` low - so the rule stays pure and tested, and
the extension's job is only the GNOME enum lookup.

Desktop notifications go through one long-lived `MessageTray.Source` titled
"AgentBar" (created on `enable()`, destroyed on `disable()`); each
`NotificationView` becomes one `MessageTray.Notification` on that source,
with `title`/`body` taken as-is from `notificationsFor` (already deduped,
already startup-safe: `previous === undefined` yields no notifications, so
enabling the extension never replays old state as new alerts) and `urgency`
mapped through the table above.

### Animation

The extension pulses the icon's opacity, keyed by `intent`: `attention` pulses
three times once per new project/state, `active` ("Working") pulses once every
8 seconds, and every other intent, including stale, stays still. Pulses are
finite on purpose: for any non-zero duration Clutter's `ease()` holds
`global.begin_work()` and `compositor.disable_unredirect()` until the
transition stops (GNOME Shell 50.1 `environment.js`), so an endless pulse would
keep fullscreen windows off direct scanout. Animation is skipped when GNOME's
`enable-animations` setting is off or a fullscreen window is on the primary
monitor, an identical re-read never restarts a running pulse, and `disable()`
removes the timer, the transitions, and the settings handler. The text is never
animated: ticking dots would change the width and make the panel jump.

### Watching the state file

A `Gio.FileMonitor` on the state *directory* (not the file) reports real
atomic renames as a noisy, inconsistent sequence of event types - verified
against gjs 1.88, not assumed from documentation. Rather than pattern-match
specific event enums, every `changed` signal, of any kind, schedules one
debounced re-read (`defaultDebounceMs`, 200 ms). A separate fallback timer
(`defaultFallbackIntervalMs`, 30 s) unconditionally re-reads and re-attaches
the directory monitor: a monitor created before its directory exists is not
retroactively notified once the directory appears, also verified directly, so
periodic re-attachment is the recovery path, not an event the monitor itself
will ever deliver.

A missing state file is read as an empty, `idle` snapshot: not an error, no
diagnostic. Every other read failure - malformed JSON, an unsupported schema
version, a permission error, a file larger than `maxSnapshotBytes` (1 MiB,
checked before loading and again after), or an exception while presenting -
never throws; it is reported once through
`onUnavailable(message)` with `parseSnapshot`'s own safe message text, and the
extension renders a fixed "Status unavailable" state until a later read
succeeds. `error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)` is what
distinguishes the two cases; also verified directly against the real Gio
error object, not assumed from its shape.

Each distinct unavailable message is reported once, until a good read
publishes a view again. Without this the 30-second fallback re-read would log
the same line for as long as a file stays broken. `test/state-reader.test.mjs`
drives the real watcher through deletion, recreation, corruption, an
unreadable file, a burst of 30 writes, removal and recreation of the whole
state directory, a clock crossing the stale threshold, and a fresh event
clearing it.

Each read takes a generation number, and a read that is no longer the newest
drops its result. A debounced re-read and the fallback timer can overlap, and
without this an older read finishing late could overwrite a newer view and
raise a notification for a state that has already passed.

### Packaging note

`gnome-extensions pack` only bundles `metadata.json`, `extension.js`, and
`stylesheet.css` by default; it does not walk subdirectories. Packing without
`--extra-source="$src/lib"` silently ships an extension whose entry point
imports a directory that was never included. `os/linux/scripts/extension-dev.sh pack`
passes it; `test/extension.test.mjs` packs for real and inspects the resulting
zip's entries so this cannot silently regress before M5 builds the `.deb` on
top of the same command.
