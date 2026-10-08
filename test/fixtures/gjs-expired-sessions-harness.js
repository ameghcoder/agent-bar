// Drives the real StateWatcher against a snapshot holding one expired and one
// current session; prints one JSON line per view. The retention window is
// decided here, in the reader, so the pure presentation model stays untouched.
// Usage: gjs -m gjs-expired-sessions-harness.js <directory>
import GLib from 'gi://GLib';

import { StateWatcher } from '../../os/linux/gnome-shell/lib/state-reader.js';

const directory = ARGV[0];
const now = Date.parse('2026-10-06T12:00:00.000Z');
const row = (sessionId, status, lastSeenAt) => ({
  sessionId, projectName: sessionId, projectPath: `/home/me/${sessionId}`, source: 'claude-code',
  status, lastEventType: 'stop', lastMessage: 'x', startedAt: lastSeenAt, lastSeenAt,
});
GLib.file_set_contents(GLib.build_filenamev([directory, 'state.json']), JSON.stringify({
  schemaVersion: 1,
  updatedAt: new Date(now).toISOString(),
  sessions: [
    row('old-permission', 'permission_required', new Date(now - 20 * 24 * 3_600_000).toISOString()),
    row('current', 'completed', new Date(now - 120_000).toISOString()),
  ],
}));

const loop = GLib.MainLoop.new(null, false);
const watcher = new StateWatcher(GLib.build_filenamev([directory, 'state.json']), {
  onView: (view) => print(JSON.stringify({ kind: 'view', view })),
  onUnavailable: (message) => print(JSON.stringify({ kind: 'unavailable', message })),
}, { debounceMs: 50, fallbackIntervalMs: 100_000, now: () => now });
watcher.start();
GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => { watcher.stop(); loop.quit(); return GLib.SOURCE_REMOVE; });
loop.run();
