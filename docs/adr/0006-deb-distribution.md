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

## Note (2026-10-25): the settings schema

The extension's GSettings schema (#49) is installed to
`/usr/share/glib-2.0/schemas/`, not into the extension's own folder. GLib's
dpkg file trigger compiles it at install and removal, so the package still
has no maintainer scripts, and GNOME Shell finds it because the installed
extension has no `schemas/` folder. This is how Ubuntu's own system
extensions ship their schemas. A user's chosen settings live in their dconf
database; removing the package leaves them, like other user data.
