---
status: accepted
---

# Distribute as an unsigned `.deb` that owns system files only

The beta ships as a single Debian package installing the CLI, the hook
receiver, and the GNOME extension under system paths (`/usr/...` and the
system extensions directory with a stable UUID). Maintainer scripts are
minimal and idempotent: they never write to `$HOME`, edit Claude settings,
enable the extension for a user, start a daemon, or delete user state.
Per-user activation (hook apply, extension enable) is always a separate,
documented, user-run step. We chose `.deb` over `npm -g`, a curl-installer,
a Snap, or extensions.gnome.org because the target user is on Ubuntu, the
extension and CLI must be versioned together, and `dpkg` gives clean
install/upgrade/remove that we can test in a VM. The beta is unsigned and
manually distributed; signing and a hosted repository wait until a real key
and distribution channel exist.

## Considered options

- Bundled JavaScript per executable with a declared system Node dependency
  versus a native executable: deferred to T501, decided from the target
  Ubuntu's packaged Node version.

## Consequences

- Package version, CLI version, extension metadata version, changelog, and
  filename must agree.
- Removing the package leaves `~/.local/state/agentbar/` and Claude settings
  intact; hook removal is `agentbar uninstall-hooks`, not `apt remove`.
