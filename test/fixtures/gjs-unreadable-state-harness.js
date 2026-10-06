// Drives the real StateWatcher at a state path that exists but cannot be read
// as a file (a directory stands in for any non-NOT_FOUND I/O failure, and
// unlike a chmod 000 file it fails the same way when the tests run as root).
// Prints one JSON line per callback firing.
// Usage: gjs -m gjs-unreadable-state-harness.js <directory>
import GLib from 'gi://GLib';

import { StateWatcher } from '../../extension/lib/state-reader.js';

const directory = ARGV[0];
const statePath = GLib.build_filenamev([directory, 'state.json']);
GLib.mkdir_with_parents(statePath, 0o700);
const loop = GLib.MainLoop.new(null, false);

function emit(kind, payload) {
  print(JSON.stringify({ kind, ...payload }));
}

const watcher = new StateWatcher(statePath, {
  onView: (view) => emit('view', { view }),
  onUnavailable: (message) => emit('unavailable', { message }),
  onNotifications: (notifications) => emit('notifications', { notifications }),
}, { debounceMs: 50, fallbackIntervalMs: 100_000 });

watcher.start();
GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
  watcher.stop();
  loop.quit();
  return GLib.SOURCE_REMOVE;
});
loop.run();
