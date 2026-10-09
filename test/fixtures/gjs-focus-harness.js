// T403 against the real kernel: the parent chain read through /proc, and a
// StateWatcher that only hands out a process that is still the one recorded.
// Usage: gjs -m gjs-focus-harness.js <directory>
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import { ancestorsOf } from '../../os/linux/gnome-shell/lib/focus.js';
import { linuxStartToken } from '../../os/linux/gnome-shell/lib/snapshot.js';
import { StateWatcher, readProcStat } from '../../os/linux/gnome-shell/lib/state-reader.js';

const directory = ARGV[0];
const self = Number(readProcStat('self').split(' ')[0]);
print(JSON.stringify({ kind: 'chain', chain: ancestorsOf(self, readProcStat) }));

const child = Gio.Subprocess.new(['sleep', '30'], Gio.SubprocessFlags.NONE);
const pid = Number(child.get_identifier());
const start = linuxStartToken(readProcStat(pid));
const at = new Date().toISOString();
const row = (sessionId, agentProcess) => ({
  sessionId, projectName: sessionId, projectPath: `/home/me/${sessionId}`, source: 'claude-code',
  status: 'running', lastEventType: 'pre_tool_use', lastMessage: 'x', startedAt: at, lastSeenAt: at, agentProcess,
});
const statePath = GLib.build_filenamev([directory, 'state.json']);
GLib.file_set_contents(statePath, JSON.stringify({ schemaVersion: 1, updatedAt: at, sessions: [row('live', { pid, start }), row('reused', { pid, start: '1' })] }));

const loop = GLib.MainLoop.new(null, false);
const watcher = new StateWatcher(statePath, {}, { debounceMs: 50, fallbackIntervalMs: 100_000 });
watcher.start();
GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
  print(JSON.stringify({ kind: 'process', live: watcher.processFor('live')?.pid === pid, reused: watcher.processFor('reused'), missing: watcher.processFor('nope') }));
  child.force_exit();
  GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
    print(JSON.stringify({ kind: 'after-exit', live: watcher.processFor('live') }));
    watcher.stop();
    loop.quit();
    return GLib.SOURCE_REMOVE;
  });
  return GLib.SOURCE_REMOVE;
});
loop.run();
