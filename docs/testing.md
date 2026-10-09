# Release regression

Run this against the exact `.deb` being released, on a machine that matches a
row in `os/linux/SUPPORT.md`, before a release is approved. Record the date,
the machine, and anything unexpected under the release's task in
`.temp/tasks.md`, and add or update the machine's row in `SUPPORT.md`. The
automated suite (`pnpm test`) covers the package build and a dpkg lifecycle in
a throwaway root; this list covers what only a real desktop can show.

## Install

1. `sudo apt install ./agentbar_<version>_all.deb` succeeds and pulls in
   `nodejs` if it is missing.
2. `agentbar --version` prints the release version.
3. `agentbar doctor` reports `FAIL Claude hooks ... install-hooks --apply` and
   nothing else failing.

## Activate

4. `agentbar install-hooks` previews; `agentbar install-hooks --apply` writes a
   backup next to `~/.claude/settings.json` and keeps every unrelated setting.
5. The applied hooks name `/usr/bin/node` and
   `/usr/lib/agentbar/dist/agents/claude-code/hooks/claude-hook.js`.
6. Restart Claude Code, log out and in, then
   `gnome-extensions enable agentbar@ameghcoder.github.io`. The indicator
   appears. (Before the logout the extension "does not exist": Wayland reads
   extension folders only at login.)
7. `agentbar doctor` passes every check.

## Live flow

8. A Claude prompt that runs a tool shows `<project> - Working - just now`.
9. A permission prompt shows "Permission needed", pulses, and raises one
   banner while another application has focus.
10. The end of a turn shows "Turn complete" and one low-urgency banner.
11. A failing command (`exit 3`) keeps "Working"; no "Failed" banner.
12. Closing the Claude terminal turns the row to "Ended" within about 10 s.
13. Clicking a live session's row brings its window forward.

## Upgrade, removal, reinstall

14. Installing the next version over this one keeps `~/.local/state/agentbar/`
    and `~/.claude/settings.json` byte-identical; `agentbar doctor` still passes.
15. `agentbar uninstall-hooks --apply` leaves only your own settings.
16. `sudo apt remove agentbar` removes `/usr/lib/agentbar`, `/usr/bin/agentbar*`,
    and the extension folder; `~/.local/state/agentbar/` and the settings
    backups stay.
17. Reinstalling works.
