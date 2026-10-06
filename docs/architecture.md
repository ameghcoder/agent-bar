# Architecture

AgentBar is four modules with narrow interfaces. Claude Code invokes the
**capture** receiver, which normalizes a hook payload and writes it to local
**state**. The **presentation** model turns that state into what the user sees.
The GNOME Shell **extension** renders it. **Installation** and **doctor** exist
so the first two can be wired up and checked safely.

```
Claude hook -> src/hooks -> src/core/events -> src/core/state -> state.json
                                                                    |
                                       src/core/snapshot (parse) <--+
                                                  |
                                       src/core/presentation (pure)
                                                  |
                                          extension/ (GJS)
```

Data flows one way. Nothing downstream of `state.json` can affect capture, and
capture never waits on the extension.

## The presentation model

`src/core/presentation.ts` converts a parsed snapshot plus the current time into
one `IndicatorView`. It is pure: same snapshot and same clock, same view. It
holds every decision about what the user sees, so all of it is testable without
GNOME Shell (`test/presentation.test.mjs`).

It imports only *types*, so the compiled `dist/core/presentation.js` has no
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
changes is confidence: its `intent` drops to `unknown`, and if it leads the
aggregate the top bar reads "Status unknown" rather than continuing to claim
"Permission needed". The menu row still names the observed status, so the fact
is not lost, only the certainty.

Degenerate clocks degrade safely. A future `lastSeenAt` (clock ran backwards) is
treated as fresh. An unparseable one is treated as stale, because a value we
cannot read cannot prove freshness, and `NaN >= threshold` is `false` — which
would silently claim the session is fine.

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
- Keys are `sessionId:status:lastSeenAt`, stable across identical reads: the
  same snapshot twice produces no second notification.
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
`dist/core/` into `extension/lib/` (`scripts/copy-extension-lib.mjs`). The
extension imports these exact compiled files - the same reader and
presentation logic Node's tests exercise - with no `dist/` or `node_modules`
dependency at runtime. `extension/lib/state-reader.js` is hand-authored, not
generated: a `StateWatcher` built only on `gi://GLib` and `gi://Gio`, so it has
no dependency on Shell UI classes (`St`, `Clutter`, `PanelMenu`, `Main`) and
runs headlessly under the plain `gjs` interpreter. `test/state-reader.test.mjs`
uses exactly that to drive it for real against a real temporary directory and
real atomic renames, rather than mocking the filesystem or GNOME APIs.

`extension/extension.js` is the one Shell-dependent file: it owns the
`PanelMenu.Button`, renders `IndicatorView` fields (`intent` chooses the icon;
`label` is the top-bar text) and builds menu rows from `sessions`, and
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
version, a permission error - never throws; it is reported once through
`onUnavailable(message)` with `parseSnapshot`'s own safe message text, and the
extension renders a fixed "Status unavailable" state until a later read
succeeds. `error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)` is what
distinguishes the two cases; also verified directly against the real Gio
error object, not assumed from its shape.

### Packaging note

`gnome-extensions pack` only bundles `metadata.json`, `extension.js`, and
`stylesheet.css` by default; it does not walk subdirectories. Packing without
`--extra-source="$src/lib"` silently ships an extension whose entry point
imports a directory that was never included. `scripts/extension-dev.sh pack`
passes it; `test/extension.test.mjs` packs for real and inspects the resulting
zip's entries so this cannot silently regress before M5 builds the `.deb` on
top of the same command.
