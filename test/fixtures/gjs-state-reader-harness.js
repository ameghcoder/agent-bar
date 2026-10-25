// Drives the real StateWatcher under the real gjs runtime against a real
// temporary directory, using real renames - not a mock. It prints a `step`
// line as each step starts and one JSON line per callback firing, so
// test/state-reader.test.mjs can assert on genuine GJS/GLib behavior step by
// step. A step starts once the watcher has reported the previous step's
// outcome, not on a clock, so a busy or slow machine cannot merge two writes
// into one read (#48).
// Usage: gjs -m gjs-state-reader-harness.js <directory> [debounceMs] [renameGapMs]
import GLib from 'gi://GLib';

import { StateWatcher } from '../../os/linux/gnome-shell/lib/state-reader.js';

const directory = ARGV[0];
const statePath = GLib.build_filenamev([directory, 'state.json']);
const loop = GLib.MainLoop.new(null, false);

let onEmit = () => {};
function emit(kind, payload) {
  print(JSON.stringify({ kind, ...payload }));
  onEmit(kind);
}

// ARGV[2], when given, waits that many milliseconds between writing the
// temporary file and renaming it: what a busy machine does to a real writer.
const renameGapMs = Number(ARGV[2] ?? 0);
function writeAtomically(name, contents) {
  const tmp = GLib.build_filenamev([directory, `${name}.tmp`]);
  const target = GLib.build_filenamev([directory, name]);
  GLib.file_set_contents(tmp, contents);
  if (renameGapMs > 0)
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, renameGapMs, () => { GLib.rename(tmp, target); return GLib.SOURCE_REMOVE; });
  else
    GLib.rename(tmp, target);
}

let now = Date.parse('2026-09-26T12:00:00.000Z');

const watcher = new StateWatcher(statePath, {
  onView: (view) => emit('view', { view }),
  onUnavailable: (message) => emit('unavailable', { message }),
  onNotifications: (notifications) => emit('notifications', { notifications }),
}, { debounceMs: Number(ARGV[1] ?? 50), fallbackIntervalMs: 100_000, now: () => now });

// Each step is [action, the callback that reports its outcome].
const steps = [
  // 0: nothing written yet - must read as empty/idle, no diagnostic.
  [() => {}, 'view'],
  // 1: a real valid, atomically-written snapshot: a view and a notification.
  [() => writeAtomically('state.json', JSON.stringify({
    schemaVersion: 1,
    updatedAt: new Date(now).toISOString(),
    sessions: [{
      sessionId: 'alpha', projectName: 'alpha', projectPath: '/home/me/alpha', source: 'claude-code',
      status: 'permission_required', lastEventType: 'permission_request', lastMessage: 'Claude needs permission',
      startedAt: new Date(now).toISOString(), lastSeenAt: new Date(now).toISOString(),
    }],
  })), 'notifications'],
  // 2: the identical snapshot rewritten - must not re-notify.
  [() => writeAtomically('state.json', JSON.stringify({
    schemaVersion: 1,
    updatedAt: new Date(now).toISOString(),
    sessions: [{
      sessionId: 'alpha', projectName: 'alpha', projectPath: '/home/me/alpha', source: 'claude-code',
      status: 'permission_required', lastEventType: 'permission_request', lastMessage: 'Claude needs permission',
      startedAt: new Date(now).toISOString(), lastSeenAt: new Date(now).toISOString(),
    }],
  })), 'view'],
  // 3: malformed JSON - must not crash, must report unavailable.
  [() => writeAtomically('state.json', '{not json'), 'unavailable'],
  // 4: unsupported future schema - same treatment.
  [() => writeAtomically('state.json', JSON.stringify({ schemaVersion: 2, updatedAt: new Date(now).toISOString(), sessions: [] })), 'unavailable'],
  // 5: a fresh valid snapshot recovers automatically: a view and a notification.
  [() => writeAtomically('state.json', JSON.stringify({
    schemaVersion: 1,
    updatedAt: new Date(now).toISOString(),
    sessions: [{
      sessionId: 'alpha', projectName: 'alpha', projectPath: '/home/me/alpha', source: 'claude-code',
      status: 'completed', lastEventType: 'stop', lastMessage: 'Claude finished responding',
      startedAt: new Date(now).toISOString(), lastSeenAt: new Date(now).toISOString(),
    }],
  })), 'notifications'],
  // 6: stop() must not throw and must silence further callbacks.
  [() => { watcher.stop(); emit('stopped', {}); }, 'stopped'],
];

// After a step's outcome arrives, the harness waits a short settle time, so a
// late repeat of that read lands in its own step. If an outcome never arrives,
// the harness moves on after stepTimeoutMs and the test fails on that step.
const settleMs = 2 * Number(ARGV[1] ?? 50) + 50;
const stepTimeoutMs = 5000;
let index = 0;
let awaiting = null;
let stepTimer = 0;

function runStep() {
  if (index >= steps.length) {
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, settleMs, () => { loop.quit(); return GLib.SOURCE_REMOVE; });
    return;
  }
  const [action, outcome] = steps[index];
  print(JSON.stringify({ kind: 'step', index }));
  index += 1;
  awaiting = outcome;
  stepTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, stepTimeoutMs, () => { stepTimer = 0; nextStep(); return GLib.SOURCE_REMOVE; });
  action();
}

function nextStep() {
  if (stepTimer) GLib.Source.remove(stepTimer);
  stepTimer = 0;
  awaiting = null;
  GLib.timeout_add(GLib.PRIORITY_DEFAULT, settleMs, () => { runStep(); return GLib.SOURCE_REMOVE; });
}

onEmit = (kind) => {
  if (awaiting !== null && kind === awaiting) nextStep();
};

watcher.start();
runStep();
GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 60, () => { loop.quit(); return GLib.SOURCE_REMOVE; });
loop.run();
