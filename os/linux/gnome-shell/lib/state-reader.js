import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import { linuxStartToken, maxSnapshotBytes, parseSnapshot, withoutExpiredSessions } from './snapshot.js';
import { livenessIntervalMs, notificationsFor, presentSnapshot } from './presentation.js';

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

// ADR 0008: a session's agent process is alive when /proc/<pid>/stat exists
// and carries the start token recorded with it; otherwise it has ended (a
// reused PID has a different start). Only that one file is read. procfs reads
// are served from kernel memory, so this synchronous read cannot stall the
// Shell the way disk I/O could.
function livenessOf(sessions) {
  const liveness = {};
  for (const session of sessions) {
    if (!session.agentProcess) continue;
    let start;
    try {
      const [, bytes] = GLib.file_get_contents(`/proc/${session.agentProcess.pid}/stat`);
      start = linuxStartToken(new TextDecoder().decode(bytes));
    } catch {
      start = undefined;
    }
    liveness[session.sessionId] = start === session.agentProcess.start ? 'alive' : 'ended';
  }
  return liveness;
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
    this._livenessIntervalMs = options.livenessIntervalMs ?? livenessIntervalMs;
    this._staleAfterMs = options.staleAfterMs;
    this._now = options.now ?? (() => Date.now());
    this._monitor = null;
    this._debounceSource = 0;
    this._fallbackSource = 0;
    this._livenessSource = 0;
    // The last successfully read state, kept so a liveness change can be
    // presented without re-reading the file; null while state is unavailable.
    this._lastState = null;
    this._liveness = {};
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
    this._livenessSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._livenessIntervalMs, () => {
      if (this._destroyed) return GLib.SOURCE_REMOVE;
      this._refreshLiveness();
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
    if (this._livenessSource) {
      GLib.Source.remove(this._livenessSource);
      this._livenessSource = 0;
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
      this._unavailable(`Cannot read the state file: ${error.message}`);
    }
  }

  _tooLarge(bytes) {
    this._unavailable(`State file is too large (${bytes} bytes, limit ${maxSnapshotBytes}).`);
  }

  _unavailable(message) {
    this._lastState = null;
    this._onUnavailable(message);
  }

  // `text` is null when no state file exists yet. Everything after the read
  // runs inside one try: an exception here would otherwise escape from a GLib
  // callback into GNOME Shell's log on every re-read.
  _present(text) {
    try {
      const now = this._now();
      if (text === null) {
        this._lastState = null;
        this._publish(presentSnapshot(emptySnapshot(now)));
        return;
      }
      const parsed = parseSnapshot(text);
      if (!parsed.ok) {
        this._unavailable(parsed.message);
        return;
      }
      // presentSnapshot stays pure and shows whatever it is given; sessions past
      // the retention window are dropped here, where state is read.
      this._lastState = { ...parsed.state, sessions: withoutExpiredSessions(parsed.state.sessions, now) };
      this._liveness = livenessOf(this._lastState.sessions);
      this._publish(presentSnapshot(this._lastState, { now, staleAfterMs: this._staleAfterMs, liveness: this._liveness }));
    } catch (error) {
      this._unavailable(`Cannot present the state: ${error.message}`);
    }
  }

  // Runs on its own timer. Does nothing unless a session recorded a process,
  // and republishes only when some session's liveness actually changed.
  _refreshLiveness() {
    if (!this._lastState || !this._lastState.sessions.some((session) => session.agentProcess)) return;
    try {
      const liveness = livenessOf(this._lastState.sessions);
      if (JSON.stringify(liveness) === JSON.stringify(this._liveness)) return;
      this._liveness = liveness;
      this._publish(presentSnapshot(this._lastState, { now: this._now(), staleAfterMs: this._staleAfterMs, liveness }));
    } catch (error) {
      this._unavailable(`Cannot present the state: ${error.message}`);
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
