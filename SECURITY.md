# Security policy

## Supported versions

AgentBar is in beta. Only the latest released version receives fixes.

## Reporting a vulnerability

Please report security problems privately, not in a public issue:

- Use **Report a vulnerability** on the repository's
  [Security tab](https://github.com/ameghcoder/agent-bar/security), or
- email the maintainer address listed in the package (`apt show agentbar`).

Include the AgentBar version, your Ubuntu and GNOME versions, and the steps to
reproduce. Do not include your `events.jsonl`, `state.json`, or Claude settings;
if they are needed to reproduce, we will ask for a minimal, redacted example.

You will get an acknowledgement within 7 days. Fixes are released as a new
package version and noted in the release notes.

## What is in scope

- The hook receiver (`agentbar-hook`) and anything it writes.
- Hook installation and removal: changes to `~/.claude/settings.json` beyond
  AgentBar's own entries, lost settings, unsafe backups.
- File permissions of `~/.local/state/agentbar/` and settings backups.
- The GNOME Shell extension, including anything that could crash or freeze
  the Shell or reveal hook payload content on screen.
- The `.deb` package: files outside its own paths, install or removal side
  effects.

## By design

- `events.jsonl` keeps full hook payloads locally, readable only by you; see
  "Privacy and your data" in the README.
- The beta package is unsigned (ADR 0006). Verify the SHA-256 checksum
  published with each release before installing.
