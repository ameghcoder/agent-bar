# Linux support

AgentBar only claims environments it has been tested in (CONTEXT.md). Linux
code is organised by desktop, then packaging, never by distro: the extension
is GNOME-specific, not Ubuntu-specific. A distro gets its own folder only if
its code genuinely diverges.

| Distro | Version | Arch | Desktop | Session | How | Status |
|---|---|---|---|---|---|---|
| Ubuntu | 26.04.1 LTS | amd64 | GNOME Shell 50.1 | Wayland | Source checkout, live Claude Code 2.1.295 | Tested (development machine) |
| Ubuntu | 26.04.1 LTS | amd64 | GNOME Shell 50.1 | Wayland | `.deb` in a throwaway dpkg root (automated) | Tested (package lifecycle only) |
| Ubuntu | 26.04.1 LTS | not recorded | GNOME Shell 50.1 | Wayland | `.deb` (0.1.0 release candidate) via App Center, second machine with Node 24 from a version manager | Tested by the owner: extension works after one login; after the T504 fix, reinstall + `install-hooks --apply` replaced all 9 hooks (backup written) and `agentbar doctor` passes on Ubuntu's Node 22.22.1 |

The release regression in `docs/testing.md` is what moves a row to "Tested".

Everything else is untested. Fedora and other distributions shipping GNOME
Shell 50 may work with the same extension, but are not supported until
someone runs the test plan there and records the result in this table.

## What lives here

- `gnome-shell/`: the GNOME Shell extension (GJS). `lib/` holds three modules
  copied from `dist/src/core/` by `pnpm build`, plus the hand-written
  `state-reader.js`.
- `scripts/`: the build step that copies those modules, and the development
  helper (`extension-dev.sh install|enable|logs|pack|devkit`).
- `packaging/stage.mjs`: stages the installed tree every Linux package is built
  from (`usr/bin`, `usr/lib/agentbar` with only the runtime dependencies,
  `usr/share/gnome-shell/extensions/<uuid>`). It compiles into a private
  temporary directory, never the checkout's `dist/`, needs no network, and sets
  fixed modes and `SOURCE_DATE_EPOCH` timestamps so two stages are identical.
  Runtime requirement: Ubuntu's `nodejs` (26.04 ships 22.22.1; AgentBar needs
  22.12 or newer).
- `packaging/deb/build.mjs`: builds `agentbar_<version>_all.deb` from the staged
  tree with `dpkg-deb --root-owner-group`. No maintainer scripts. Run it with
  `pnpm package:deb`.
