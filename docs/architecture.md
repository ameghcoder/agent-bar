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
