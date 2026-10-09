// Drives the real StateWatcher through one robustness scenario, named by the
// second argument, and prints one JSON line per callback firing.
// Usage: gjs -m gjs-reader-robustness-harness.js <directory> <scenario>
//   oversized            a state file over the size limit
//   overlap              two reads in flight at once; only the newest may publish
//   throwing-view        the view callback throws once
//   startup-unavailable  the first read is malformed, then a valid snapshot arrives
//   liveness-timer       no process, then a process, then none: the timer follows
import GLib from 'gi://GLib';

import { StateWatcher } from '../../os/linux/gnome-shell/lib/state-reader.js';
import { maxSnapshotBytes } from '../../os/linux/gnome-shell/lib/snapshot.js';

const [directory, scenario] = ARGV;
const statePath = GLib.build_filenamev([directory, 'state.json']);
const now = Date.parse('2026-10-07T12:00:00.000Z');
const loop = GLib.MainLoop.new(null, false);

function emit(kind, payload) {
  print(JSON.stringify({ kind, ...payload }));
}

function write(contents) {
  const tmp = `${statePath}.tmp`;
  GLib.file_set_contents(tmp, contents);
  GLib.rename(tmp, statePath);
}

function snapshot(sessionId, status, extra = {}) {
  const at = new Date(now).toISOString();
  return JSON.stringify({
    schemaVersion: 1,
    updatedAt: at,
    sessions: [{
      sessionId, projectName: sessionId, projectPath: `/home/me/${sessionId}`, source: 'claude-code',
      status, lastEventType: 'stop', lastMessage: 'x', startedAt: at, lastSeenAt: at, ...extra,
    }],
  });
}

let throwOnce = scenario === 'throwing-view';
const watcher = new StateWatcher(statePath, {
  onView: (view) => {
    if (throwOnce) {
      throwOnce = false;
      throw new Error('render failed');
    }
    emit('view', { view });
  },
  onUnavailable: (message) => emit('unavailable', { message }),
  onNotifications: (notifications) => emit('notifications', { notifications }),
}, { debounceMs: 50, fallbackIntervalMs: 100_000, now: () => now });

if (scenario === 'oversized') {
  // Valid JSON padded past the limit: the size alone must reject it.
  write(snapshot('big', 'running').replace('"x"', `"${'x'.repeat(maxSnapshotBytes)}"`));
  watcher.start();
} else if (scenario === 'overlap') {
  // Two reads in flight at once, as when a debounced re-read and the fallback
  // timer fire together. _reread is internal; it is called directly because
  // nothing public can start two reads deterministically.
  write(snapshot('first', 'running'));
  watcher._reread();
  write(snapshot('second', 'completed'));
  watcher._reread();
} else if (scenario === 'throwing-view') {
  write(snapshot('alpha', 'running'));
  watcher.start();
} else if (scenario === 'startup-unavailable') {
  write('{not json');
  watcher.start();
  GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
    write(snapshot('alpha', 'permission_required'));
    watcher._reread();
    return GLib.SOURCE_REMOVE;
  });
} else if (scenario === 'liveness-timer') {
  // _livenessSource is internal; nothing public reveals whether the timer runs.
  const timer = () => emit('timer', { running: watcher._livenessSource !== 0 });
  write(snapshot('plain', 'running'));
  watcher.start();
  GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
    timer();
    write(snapshot('tracked', 'running', { agentProcess: { pid: 1, start: '1' } }));
    watcher._reread();
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
      timer();
      write(snapshot('plain', 'running'));
      watcher._reread();
      GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => { timer(); return GLib.SOURCE_REMOVE; });
      return GLib.SOURCE_REMOVE;
    });
    return GLib.SOURCE_REMOVE;
  });
}

GLib.timeout_add(GLib.PRIORITY_DEFAULT, scenario === 'liveness-timer' ? 600 : 400, () => {
  watcher.stop();
  loop.quit();
  return GLib.SOURCE_REMOVE;
});
loop.run();
