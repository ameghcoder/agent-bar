// Drives the real StateWatcher's liveness check (ADR 0008) against a real
// child process: alive while it runs, ended once it is killed, and a session
// whose start token does not match (a reused PID) ended from the first read.
// Usage: gjs -m gjs-liveness-harness.js <directory>
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import { StateWatcher } from '../../os/linux/gnome-shell/lib/state-reader.js';
import { linuxStartToken } from '../../os/linux/gnome-shell/lib/snapshot.js';

const directory = ARGV[0];
const statePath = GLib.build_filenamev([directory, 'state.json']);
const loop = GLib.MainLoop.new(null, false);
const now = Date.now();
const at = new Date(now).toISOString();

const child = Gio.Subprocess.new(['sleep', '30'], Gio.SubprocessFlags.NONE);
const pid = Number(child.get_identifier());
const [, bytes] = GLib.file_get_contents(`/proc/${pid}/stat`);
const start = linuxStartToken(new TextDecoder().decode(bytes));

const row = (sessionId, agentProcess) => ({
  sessionId, projectName: sessionId, projectPath: `/home/me/${sessionId}`, source: 'claude-code',
  status: 'permission_required', lastEventType: 'permission_request', lastMessage: 'x', startedAt: at, lastSeenAt: at,
  ...(agentProcess ? { agentProcess } : {}),
});
GLib.file_set_contents(statePath, JSON.stringify({
  schemaVersion: 1,
  updatedAt: at,
  sessions: [row('child', { pid, start }), row('reused', { pid, start: '1' }), row('plain')],
}));

const summary = (view) => Object.fromEntries(view.sessions.map((session) => [session.sessionId, session.ended ? 'ended' : session.alive ? 'alive' : 'unknown']));
const watcher = new StateWatcher(statePath, {
  onView: (view) => print(JSON.stringify({ kind: 'view', liveness: summary(view), attentionCount: view.attentionCount })),
  onUnavailable: (message) => print(JSON.stringify({ kind: 'unavailable', message })),
  onNotifications: (notifications) => print(JSON.stringify({ kind: 'notifications', notifications })),
}, { debounceMs: 50, fallbackIntervalMs: 100_000, livenessIntervalMs: 100, now: () => now });

watcher.start();
GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
  child.force_exit();
  return GLib.SOURCE_REMOVE;
});
GLib.timeout_add(GLib.PRIORITY_DEFAULT, 900, () => {
  watcher.stop();
  loop.quit();
  return GLib.SOURCE_REMOVE;
});
loop.run();
