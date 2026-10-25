#!/usr/bin/env sh
# Development helper for the AgentBar GNOME Shell extension (GNOME 50, Wayland).
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
src="$here/os/linux/gnome-shell"
uuid=$(node -p "require('$src/metadata.json').uuid")
target="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$uuid"
# The settings schema lives outside the extension, as in the package: GNOME
# Shell reads the user's compiled schemas when the extension has no schemas/.
schema="$here/os/linux/schemas/org.gnome.shell.extensions.agentbar.gschema.xml"
schema_dir="${XDG_DATA_HOME:-$HOME/.local/share}/glib-2.0/schemas"

case "${1:-help}" in
  install)   # symlink the source tree into the user extensions directory
    mkdir -p "$(dirname "$target")"
    [ -e "$target" ] && [ ! -L "$target" ] && { echo "refusing: $target exists and is not a symlink" >&2; exit 1; }
    ln -sfn "$src" "$target"
    mkdir -p "$schema_dir"
    cp "$schema" "$schema_dir/"
    glib-compile-schemas "$schema_dir"
    echo "linked $target -> $src; schema compiled in $schema_dir" ;;
  uninstall)
    rm -f "$schema_dir/$(basename "$schema")"
    [ -d "$schema_dir" ] && glib-compile-schemas "$schema_dir"
    [ -L "$target" ] && rm "$target" && echo "removed $target" || echo "not installed" ;;
  enable)    gnome-extensions enable "$uuid" ;;
  disable)   gnome-extensions disable "$uuid" ;;
  status)    gnome-extensions info "$uuid" ;;
  logs)      # follow GNOME Shell's journal, AgentBar lines and JS errors only
    journalctl -f -o cat --user-unit org.gnome.Shell@wayland.service _COMM=gnome-shell 2>/dev/null \
      | grep --line-buffered -iE "agentbar|$uuid|JS ERROR|Extension" ;;
  devkit)    # run a nested GNOME Shell for iteration; Wayland cannot reload extension code in place
    dbus-run-session -- sh -c "SHELL_DEBUG=backtrace-warnings gnome-shell --devkit --wayland" ;;
  pack)      # validate metadata and produce a zip in the scratch dir given as \$2
    out="${2:-/tmp}"
    # lib/ holds generated files (see os/linux/scripts/copy-extension-lib.mjs);
    # gnome-extensions pack does not include subdirectories unless told to.
    gnome-extensions pack --force --out-dir "$out" --extra-source="$src/lib" --schema="$schema" "$src" && echo "packed to $out" ;;
  *)
    echo "usage: $0 install|uninstall|enable|disable|status|logs|devkit|pack [dir]" >&2
    exit 2 ;;
esac
