// Drives the real StateWatcher through the interruptions T402 lists, against a
// real directory with real renames, deletes, and permission changes. Prints a
// {kind:'step'} marker before each step, then one line per callback, so the
// test can check what the reader settled on after each interruption.
// Usage: gjs -m gjs-interruptions-harness.js <directory>
import GLib from 'gi://GLib';

import { StateWatcher } from '../../os/linux/gnome-shell/lib/state-reader.js';

const root = ARGV[0];
const directory = GLib.build_filenamev([root, 'state']);
const statePath = GLib.build_filenamev([directory, 'state.json']);
const loop = GLib.MainLoop.new(null, false);
let now = Date.parse('2026-10-09T12:00:00.000Z');
const root_user = GLib.get_user_name() === 'root';

function emit(kind, payload = {}) {
  print(JSON.stringify({ kind, ...payload }));
}

function write(sessionId, status = 'running', seenAt = now) {
  GLib.mkdir_with_parents(directory, 0o700);
  const at = new Date(seenAt).toISOString();
  const tmp = `${statePath}.tmp`;
  GLib.file_set_contents(tmp, JSON.stringify({
    schemaVersion: 1,
    updatedAt: at,
    sessions: [{
      sessionId, projectName: sessionId, projectPath: `/home/me/${sessionId}`, source: 'claude-code',
      status, lastEventType: 'pre_tool_use', lastMessage: 'x', startedAt: at, lastSeenAt: at,
    }],
  }));
  GLib.rename(tmp, statePath);
}

const run = (argv) => GLib.spawn_sync(null, argv, null, GLib.SpawnFlags.SEARCH_PATH, null);

const watcher = new StateWatcher(statePath, {
  onView: (view) => emit('view', { sessions: view.sessions.map((row) => row.sessionId), status: view.status, stale: view.stale }),
  onUnavailable: (message) => emit('unavailable', { message }),
  onNotifications: () => {},
}, { debounceMs: 50, fallbackIntervalMs: 150, livenessIntervalMs: 100_000, now: () => now });

// [name, action, how long to let the reader settle afterwards in ms]
const steps = [
  ['valid', () => write('a'), 300],
  ['deleted', () => GLib.unlink(statePath), 300],
  ['recreated', () => write('b'), 300],
  ['corrupted', () => GLib.file_set_contents(statePath, '{oops'), 700],
  ['unreadable', () => { write('c'); if (!root_user) run(['chmod', '000', statePath]); }, 500],
  ['readable-again', () => run(['chmod', '600', statePath]), 300],
  ['rapid', () => { for (let index = 0; index < 30; index += 1) write(`d${index}`); }, 400],
  ['directory-removed', () => run(['rm', '-rf', directory]), 400],
  ['directory-recreated', () => write('e'), 500],
  ['clock-past-stale', () => { now += 11 * 60_000; }, 400],
  ['fresh-event', () => write('e', 'running', now), 300],
];

let index = 0;
watcher.start();
function next() {
  if (index >= steps.length) {
    watcher.stop();
    loop.quit();
    return GLib.SOURCE_REMOVE;
  }
  const [name, action, settle] = steps[index];
  index += 1;
  emit('step', { name, skipped: name === 'unreadable' && root_user });
  action();
  GLib.timeout_add(GLib.PRIORITY_DEFAULT, settle, next);
  return GLib.SOURCE_REMOVE;
}
GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, next);
GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 20, () => { loop.quit(); return GLib.SOURCE_REMOVE; });
loop.run();
