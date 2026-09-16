#!/usr/bin/env sh
# Development helper for the AgentBar GNOME Shell extension (GNOME 50, Wayland).
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
src="$here/extension"
uuid=$(node -p "require('$src/metadata.json').uuid")
target="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$uuid"

case "${1:-help}" in
  install)   # symlink the source tree into the user extensions directory
    mkdir -p "$(dirname "$target")"
    [ -e "$target" ] && [ ! -L "$target" ] && { echo "refusing: $target exists and is not a symlink" >&2; exit 1; }
    ln -sfn "$src" "$target"
    echo "linked $target -> $src" ;;
  uninstall)
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
    gnome-extensions pack --force --out-dir "$out" "$src" && echo "packed to $out" ;;
  *)
    echo "usage: $0 install|uninstall|enable|disable|status|logs|devkit|pack [dir]" >&2
    exit 2 ;;
esac
