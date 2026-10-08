import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import { maxSnapshotBytes, parseSnapshot, withoutExpiredSessions } from './snapshot.js';
import { notificationsFor, presentSnapshot } from './presentation.js';

// Shell-independent: only GLib/Gio, no St/Clutter/PanelMenu/Main, so this
// module runs headlessly under `gjs` in tests as well as inside GNOME Shell.
// See test/state-reader.test.mjs.

export const defaultDebounceMs = 200;
// A single long Bash call is silent between pre_tool_use and post_tool_use;
// this also re-checks staleness and re-attaches the monitor on a timer, since
// a directory monitor created before its directory exists never catches up
// (verified against gjs 1.88 - see docs/architecture.md).
export const defaultFallbackIntervalMs = 30_000;

function emptySnapshot(now) {
  return { schemaVersion: 1, updatedAt: new Date(now).toISOString(), sessions: [] };
}

export class StateWatcher {
  constructor(statePath, callbacks = {}, options = {}) {
    this._statePath = statePath;
    this._directory = GLib.path_get_dirname(statePath);
    this._onView = callbacks.onView ?? (() => {});
    this._onUnavailable = callbacks.onUnavailable ?? (() => {});
    this._onNotifications = callbacks.onNotifications ?? (() => {});
    this._debounceMs = options.debounceMs ?? defaultDebounceMs;
    this._fallbackIntervalMs = options.fallbackIntervalMs ?? defaultFallbackIntervalMs;
    this._staleAfterMs = options.staleAfterMs;
    this._now = options.now ?? (() => Date.now());
    this._monitor = null;
    this._debounceSource = 0;
    this._fallbackSource = 0;
    this._previousView = undefined;
    // Bumped by every read; a read whose number is no longer current drops its
    // result, so an older read finishing late cannot overwrite a newer view.
    this._generation = 0;
    this._destroyed = false;
  }

  start() {
    this._attachMonitor();
    this._reread();
    this._fallbackSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._fallbackIntervalMs, () => {
      if (this._destroyed) return GLib.SOURCE_REMOVE;
      this._attachMonitor();
      this._reread();
      return GLib.SOURCE_CONTINUE;
    });
  }

  // Idempotent and safe to call more than once; disable() must never throw.
  stop() {
    this._destroyed = true;
    if (this._debounceSource) {
      GLib.Source.remove(this._debounceSource);
      this._debounceSource = 0;
    }
    if (this._fallbackSource) {
      GLib.Source.remove(this._fallbackSource);
      this._fallbackSource = 0;
    }
    if (this._monitor) {
      this._monitor.cancel();
      this._monitor = null;
    }
  }

  _attachMonitor() {
    if (this._monitor) {
      this._monitor.cancel();
      this._monitor = null;
    }
    try {
      const directory = Gio.File.new_for_path(this._directory);
      this._monitor = directory.monitor_directory(Gio.FileMonitorFlags.NONE, null);
      this._monitor.connect('changed', () => this._scheduleReread());
    } catch {
      // Directory unreadable right now (e.g. parent missing); the fallback
      // timer retries this on its own schedule.
      this._monitor = null;
    }
  }

  // Real rename-based atomic writes surface as noisy, inconsistent event
  // sequences (verified against gjs 1.88), so every 'changed' signal - of
  // any kind - just schedules one debounced re-read rather than trying to
  // interpret which event type occurred.
  _scheduleReread() {
    if (this._destroyed) return;
    if (this._debounceSource) GLib.Source.remove(this._debounceSource);
    this._debounceSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._debounceMs, () => {
      this._debounceSource = 0;
      this._reread();
      return GLib.SOURCE_REMOVE;
    });
  }

  // The size is checked before the contents are loaded, so an oversized file
  // never enters GNOME Shell's memory, and again after loading, since the file
  // can be replaced between the two calls.
  _reread() {
    const generation = ++this._generation;
    const current = () => !this._destroyed && generation === this._generation;
    const file = Gio.File.new_for_path(this._statePath);
    file.query_info_async('standard::size', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, null, (source, result) => {
      if (!current()) return;
      let size;
      try {
        size = source.query_info_finish(result).get_size();
      } catch (error) {
        this._readFailed(error);
        return;
      }
      if (size > maxSnapshotBytes) {
        this._tooLarge(size);
        return;
      }
      source.load_contents_async(null, (_, loaded) => {
        if (!current()) return;
        let contents;
        try {
          [, contents] = source.load_contents_finish(loaded);
        } catch (error) {
          this._readFailed(error);
          return;
        }
        if (contents.length > maxSnapshotBytes) {
          this._tooLarge(contents.length);
          return;
        }
        this._present(new TextDecoder().decode(contents));
      });
    });
  }

  _readFailed(error) {
    // Only NOT_FOUND means "nothing written yet". `instanceof Gio.IOErrorEnum`
    // is true for every Gio error, so it would hide permission and
    // is-a-directory failures behind an empty "no sessions" view.
    if (error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)) {
      // No state written yet is not a failure; it is an honest "no sessions".
      this._present(null);
    } else {
      this._onUnavailable(`Cannot read the state file: ${error.message}`);
    }
  }

  _tooLarge(bytes) {
    this._onUnavailable(`State file is too large (${bytes} bytes, limit ${maxSnapshotBytes}).`);
  }

  // `text` is null when no state file exists yet. Everything after the read
  // runs inside one try: an exception here would otherwise escape from a GLib
  // callback into GNOME Shell's log on every re-read.
  _present(text) {
    try {
      const now = this._now();
      if (text === null) {
        this._publish(presentSnapshot(emptySnapshot(now)));
        return;
      }
      const parsed = parseSnapshot(text);
      if (!parsed.ok) {
        this._onUnavailable(parsed.message);
        return;
      }
      // presentSnapshot stays pure and shows whatever it is given; sessions past
      // the retention window are dropped here, where state is read.
      const state = { ...parsed.state, sessions: withoutExpiredSessions(parsed.state.sessions, now) };
      this._publish(presentSnapshot(state, { now, staleAfterMs: this._staleAfterMs }));
    } catch (error) {
      this._onUnavailable(`Cannot present the state: ${error.message}`);
    }
  }

  // Startup rule: the first view published is the baseline and notifies
  // nothing, even when earlier reads were unavailable, because nothing proves
  // its contents are newer than the reader (ADR 0004).
  _publish(view) {
    const notifications = notificationsFor(this._previousView, view);
    this._previousView = view;
    this._onView(view);
    if (notifications.length > 0) this._onNotifications(notifications);
  }
}
