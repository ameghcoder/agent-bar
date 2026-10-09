# Support, known issues, and triage

## Getting help

1. Run `agentbar doctor`. Most problems show up there as a `FAIL` or `WARN`
   line with the fix next to it. The README's
   [troubleshooting table](../README.md#troubleshooting) covers the rest.
2. Still stuck, or something is wrong: open a
   [bug report](https://github.com/ameghcoder/agent-bar/issues/new?template=bug_report.yml).
   It asks for versions and `agentbar doctor` output, which contains no
   project names, prompts, or settings.
3. Ideas and impressions: the
   [beta feedback form](https://github.com/ameghcoder/agent-bar/issues/new?template=beta_feedback.yml).
4. Security problems: privately, as described in [SECURITY.md](../SECURITY.md).

Never attach `~/.local/state/agentbar/events.jsonl`, `state.json`, or your
Claude settings. They can contain your commands, file contents, and paths. If
a report needs data, a maintainer will ask for a small, redacted example.

## Known issues

These are known in 0.2.0 and are not bugs to report:

| Issue | Why | Workaround |
| --- | --- | --- |
| The extension "does not exist" right after installing | GNOME on Wayland finds new extensions only at login | Log out and back in once |
| A session shows its previous state while Claude is only thinking | Claude Code sends no hook between a prompt and the first tool call | None; it updates at the first tool call |
| "No updates" during a long command | No event arrives while one tool runs | Normal; the menu says "Claude open" while the process is alive |
| Clicking a session does nothing with several windows of one terminal | Terminals run all windows from one process; AgentBar only picks a window whose title names the project | Use one window per project, or tabs in one window |
| Clicking a session cannot pick a terminal tab | No public API for tabs | Switch tabs by hand |
| Reinstalling a `.deb` with the same version is skipped | apt treats an equal version as installed | `sudo apt install --reinstall ./agentbar_<version>_all.deb` |
| Upgrading from a 0.1.0 test build leaves hooks on another Node | 0.1.0 used the first `node` on PATH | Run `agentbar install-hooks --apply` once after upgrading |

The full list of product limitations is in the README's
[known limitations](../README.md#known-limitations).

## Triage rule

Every new issue starts as `needs-triage`. A maintainer reads it within a week
and gives it one priority label, then `needs-info` (waiting on the reporter),
`ready-for-human` or `ready-for-agent` (understood and ready to fix), or
`wontfix` (with the reason).

| Priority | When | Target |
| --- | --- | --- |
| **P0** | AgentBar blocks, approves, or noticeably slows Claude Code; loses or corrupts Claude settings; shows a prompt, command, file content, or path in the top bar or a notification; sends data off the machine; crashes or freezes GNOME Shell; the package changes anything in a home folder; install fails on a supported environment | Fix in the next release, as soon as possible |
| **P1** | A wrong or missing state (for example Working while Claude waits for permission), missing or duplicate notifications, the extension fails to load, `agentbar doctor` gives wrong advice | Next planned release |
| **P2** | Wording, looks, an unsupported environment, a feature request | When it fits the roadmap |

When unsure between two priorities, take the higher one; it can always go
down once the cause is known.
