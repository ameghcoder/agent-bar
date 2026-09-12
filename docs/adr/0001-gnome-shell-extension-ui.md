---
status: accepted
---

# GNOME Shell extension as the only user interface

AgentBar's UI is a GNOME Shell top-bar extension written in GJS, targeting
Ubuntu GNOME only. We rejected Electron, a web dashboard, a tray app, and a
cross-desktop toolkit because the product promise is "see Claude's state
without leaving your current window": that needs a native top-bar item with
native notifications, not another window to switch to, and shipping a
browser runtime for a status dot is out of proportion. The cost is a
GNOME-version-specific API surface and a support matrix limited to versions
actually tested; we accept that and claim only tested Ubuntu/GNOME combinations.

## Consequences

- The extension must never crash GNOME Shell: malformed, missing, oversized,
  or newer-schema state are recoverable UI conditions.
- KDE, Cinnamon, macOS, and Windows are out of scope until a separate adapter
  is justified by demand (see `.temp/tasks.md` T802/T804).
