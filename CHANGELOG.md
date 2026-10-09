# Changelog

All notable changes to AgentBar. Versions follow [Semantic Versioning](https://semver.org/);
until 1.0 any minor version may change behaviour.

## 0.2.0 - first public beta

### What it does

- Shows the Claude Code session that matters most in the GNOME top bar as
  `project - State - time ago`, with `+N` for other working sessions.
- Menu with every session, a health line, and click-to-focus: clicking a
  session brings its terminal or VS Code window forward when AgentBar can tell
  exactly which one it is.
- One desktop notification when Claude needs permission, waits for you,
  finishes a turn, or a turn fails. Notifications show only the state and the
  project name.
- Honest states: "No updates" after 10 minutes without an event, "Ended" within
  about 10 seconds of the Claude process exiting, and no progress percentages.
- `agentbar install-hooks` / `uninstall-hooks` with preview, backup, and atomic
  apply; `agentbar doctor` for diagnosis. Man pages for both commands.
- Everything stays on the machine. The event history is capped at about 20 MB.

### Supported

Ubuntu 26.04 LTS with GNOME Shell 50 on Wayland, Ubuntu's `nodejs` (22.12 or
newer, installed by `apt`), Claude Code 2.1.29x. Tested environments are listed
in `os/linux/SUPPORT.md`.

### Install and activation

`sudo apt install ./agentbar_0.2.0_all.deb`, `agentbar install-hooks --apply`,
restart Claude Code, log out and in, `gnome-extensions enable
agentbar@ameghcoder.github.io`. The package changes nothing in your home
folder by itself.

### Upgrading from a 0.1.0 test build

Install 0.2.0 with `sudo apt install ./agentbar_0.2.0_all.deb`, then run
`agentbar install-hooks --apply` once: 0.1.0 test builds could write a Node
version manager's path into the hooks, and this replaces it with
`/usr/bin/node`. Restart Claude Code, then log out and in for the new
extension code.

### Known limitations

- Nothing is captured between a prompt and Claude's first tool call.
- Allowed or denied permission decisions are not observed.
- Parallel tool calls are not combined; the latest event wins.
- "Ended" needs Linux and a Claude Code that passes `CLAUDE_PID` to hooks.
- Click-to-focus cannot select a terminal tab, and with several windows of one
  terminal it needs the project name in the window title.
- A failed turn (`StopFailure`) has not yet been seen in a live session.
- The package is unsigned; verify the published SHA-256 checksum.
