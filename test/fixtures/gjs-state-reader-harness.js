// Drives the real StateWatcher under the real gjs runtime against a real
// temporary directory, using real renames - not a mock. Each step below is
// scripted by wall-clock delay and prints one JSON line per callback firing,
// so test/state-reader.test.mjs can assert on genuine GJS/GLib behavior.
// Usage: gjs -m gjs-state-reader-harness.js <directory>
import GLib from 'gi://GLib';

import { StateWatcher } from '../../os/linux/gnome-shell/lib/state-reader.js';

const directory = ARGV[0];
const statePath = GLib.build_filenamev([directory, 'state.json']);
const loop = GLib.MainLoop.new(null, false);

function emit(kind, payload) {
  print(JSON.stringify({ kind, ...payload }));
}

function writeAtomically(name, contents) {
  const tmp = GLib.build_filenamev([directory, `${name}.tmp`]);
  const target = GLib.build_filenamev([directory, name]);
  GLib.file_set_contents(tmp, contents);
  GLib.rename(tmp, target);
}

let now = Date.parse('2026-09-26T12:00:00.000Z');

const watcher = new StateWatcher(statePath, {
  onView: (view) => emit('view', { view }),
  onUnavailable: (message) => emit('unavailable', { message }),
  onNotifications: (notifications) => emit('notifications', { notifications }),
}, { debounceMs: 50, fallbackIntervalMs: 100_000, now: () => now });

const steps = [
  // 0: nothing written yet - must read as empty/idle, no diagnostic.
  () => {},
  // 1: a real valid, atomically-written snapshot.
  () => writeAtomically('state.json', JSON.stringify({
    schemaVersion: 1,
    updatedAt: new Date(now).toISOString(),
    sessions: [{
      sessionId: 'alpha', projectName: 'alpha', projectPath: '/home/me/alpha', source: 'claude-code',
      status: 'permission_required', lastEventType: 'permission_request', lastMessage: 'Claude needs permission',
      startedAt: new Date(now).toISOString(), lastSeenAt: new Date(now).toISOString(),
    }],
  })),
  // 2: the identical snapshot rewritten - must not re-notify.
  () => writeAtomically('state.json', JSON.stringify({
    schemaVersion: 1,
    updatedAt: new Date(now).toISOString(),
    sessions: [{
      sessionId: 'alpha', projectName: 'alpha', projectPath: '/home/me/alpha', source: 'claude-code',
      status: 'permission_required', lastEventType: 'permission_request', lastMessage: 'Claude needs permission',
      startedAt: new Date(now).toISOString(), lastSeenAt: new Date(now).toISOString(),
    }],
  })),
  // 3: malformed JSON - must not crash, must report unavailable.
  () => writeAtomically('state.json', '{not json'),
  // 4: unsupported future schema - same treatment.
  () => writeAtomically('state.json', JSON.stringify({ schemaVersion: 2, updatedAt: new Date(now).toISOString(), sessions: [] })),
  // 5: a fresh valid snapshot recovers automatically.
  () => writeAtomically('state.json', JSON.stringify({
    schemaVersion: 1,
    updatedAt: new Date(now).toISOString(),
    sessions: [{
      sessionId: 'alpha', projectName: 'alpha', projectPath: '/home/me/alpha', source: 'claude-code',
      status: 'completed', lastEventType: 'stop', lastMessage: 'Claude finished responding',
      startedAt: new Date(now).toISOString(), lastSeenAt: new Date(now).toISOString(),
    }],
  })),
  // 6: stop() must not throw and must silence further callbacks.
  () => { watcher.stop(); emit('stopped', {}); },
];

let index = 0;
watcher.start();
GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, function tick() {
  steps[index]();
  index += 1;
  if (index >= steps.length) {
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => { loop.quit(); return GLib.SOURCE_REMOVE; });
    return GLib.SOURCE_REMOVE;
  }
  return GLib.SOURCE_CONTINUE;
});
GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 10, () => { loop.quit(); return GLib.SOURCE_REMOVE; });
loop.run();
