import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// os/linux/gnome-shell/lib/state-reader.js is Shell-independent (only GLib/Gio), so it
// runs under the real gjs runtime headlessly. This drives it for real against
// a real temporary directory and real atomic renames - see the harness for
// the exact scripted sequence.
const harness = fileURLToPath(new URL('fixtures/gjs-state-reader-harness.js', import.meta.url));
const unreadableHarness = fileURLToPath(new URL('fixtures/gjs-unreadable-state-harness.js', import.meta.url));

const expiredHarness = fileURLToPath(new URL('fixtures/gjs-expired-sessions-harness.js', import.meta.url));

const robustnessHarness = fileURLToPath(new URL('fixtures/gjs-reader-robustness-harness.js', import.meta.url));

async function runHarness(t, script = harness, args = []) {
  const directory = await mkdtemp(join(tmpdir(), 'agentbar-state-reader-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { code, lines } = await new Promise((resolve, reject) => {
    const child = spawn('gjs', ['-m', script, directory, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (data) => { stdout += data; });
    child.stderr.setEncoding('utf8').on('data', (data) => { stderr += data; });
    child.on('error', reject);
    child.on('close', (exitCode) => {
      if (exitCode !== 0) return reject(new Error(`gjs harness exited ${exitCode}: ${stderr}`));
      resolve({ code: exitCode, lines: stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) });
    });
  });
  return { code, lines };
}

test('a real StateWatcher, driven by the real gjs runtime against real atomic renames, reports the whole lifecycle correctly', { skip: process.platform !== 'linux' }, async (t) => {
  const { code, lines } = await runHarness(t);
  assert.equal(code, 0);
  const kinds = lines.map((line) => line.kind);

  assert.deepEqual(kinds, [
    'view', 'view', 'notifications', 'view', 'unavailable', 'unavailable', 'view', 'notifications', 'stopped',
  ]);

  assert.deepEqual(lines[0].view, {
    status: 'idle', label: 'Idle', intent: 'quiet', stale: false, attentionCount: 0, sessions: [],
    title: 'AgentBar - No sessions',
    leaderId: null,
    health: 'No events yet · run "agentbar install-hooks"',
  }, 'no state file yet reads as empty/idle, not an error');

  assert.equal(lines[1].view.status, 'permission_required');
  assert.equal(lines[2].notifications.length, 1);
  assert.equal(lines[2].notifications[0].sessionId, 'alpha');
  assert.equal(lines[2].notifications[0].title, 'Permission needed');

  assert.deepEqual(lines[3].view, lines[1].view, 'rewriting the identical snapshot still re-renders the same view');

  assert.match(lines[4].message, /not valid JSON/i);
  assert.match(lines[5].message, /schema version 2/);

  assert.equal(lines[6].view.status, 'completed');
  assert.equal(lines[7].notifications.length, 1);
  assert.equal(lines[7].notifications[0].title, 'Turn complete');

  const notificationCount = lines.filter((line) => line.kind === 'notifications').reduce((total, line) => total + line.notifications.length, 0);
  assert.equal(notificationCount, 2, 'the identical rewrite in step 2 must not add a third notification');
});

test('a state path that exists but cannot be read is unavailable, never an empty "no sessions" view', { skip: process.platform !== 'linux' }, async (t) => {
  const { lines } = await runHarness(t, unreadableHarness);
  assert.deepEqual(lines.map((line) => line.kind), ['unavailable']);
  assert.match(lines[0].message, /Cannot read the state file/);
});

test('sessions past the 24-hour retention window never reach the view, even a stale permission request', { skip: process.platform !== 'linux' }, async (t) => {
  const { lines } = await runHarness(t, expiredHarness);
  assert.deepEqual(lines.map((line) => line.kind), ['view']);
  const { view } = lines[0];
  assert.deepEqual(view.sessions.map((row) => row.sessionId), ['current']);
  assert.equal(view.attentionCount, 0);
  assert.equal(view.status, 'completed');
  assert.equal(view.stale, false);
});

const robustness = (t, scenario) => runHarness(t, robustnessHarness, [scenario]);

test('a state file over the size limit is unavailable and is never parsed', { skip: process.platform !== 'linux' }, async (t) => {
  const { lines } = await robustness(t, 'oversized');
  assert.deepEqual(lines.map((line) => line.kind), ['unavailable']);
  // No byte count: a growing file must keep the same message, so it is reported once.
  assert.equal(lines[0].message, 'State file is too large (limit 1048576 bytes).');
});

test('when two reads overlap, only the newest publishes', { skip: process.platform !== 'linux' }, async (t) => {
  const { lines } = await robustness(t, 'overlap');
  assert.deepEqual(lines.map((line) => line.kind), ['view']);
  assert.deepEqual(lines[0].view.sessions.map((row) => row.sessionId), ['second']);
});

test('a throw while presenting becomes unavailable instead of escaping into GNOME Shell', { skip: process.platform !== 'linux' }, async (t) => {
  const { lines } = await robustness(t, 'throwing-view');
  assert.deepEqual(lines.map((line) => line.kind), ['unavailable']);
  assert.match(lines[0].message, /render failed/);
});

// Startup rule: the first valid view is the baseline, even after an unreadable
// first read, because nothing proves its contents are newer than the reader.
test('the first valid view after an unavailable start is a baseline and notifies nothing', { skip: process.platform !== 'linux' }, async (t) => {
  const { lines } = await robustness(t, 'startup-unavailable');
  // The directory monitor may also re-read the same write, so views can repeat.
  const kinds = lines.map((line) => line.kind);
  assert.equal(kinds[0], 'unavailable');
  assert.ok(kinds.includes('view'));
  assert.ok(!kinds.includes('notifications'), 'the baseline view must not notify');
  assert.equal(lines.at(-1).view.status, 'permission_required');
});

// ADR 0008: liveness is checked against a real process, not a mock.
const livenessHarness = fileURLToPath(new URL('fixtures/gjs-liveness-harness.js', import.meta.url));

test('a session reads alive while its process runs and ended once it is gone, without notifying', { skip: process.platform !== 'linux' }, async (t) => {
  const { lines } = await runHarness(t, livenessHarness);
  assert.ok(!lines.some((line) => line.kind === 'notifications'), 'liveness changes never notify');
  const views = lines.filter((line) => line.kind === 'view');
  assert.deepEqual(views[0].liveness, { child: 'alive', reused: 'ended', plain: 'unknown' });
  assert.equal(views[0].attentionCount, 2, 'the ended session is no longer attention');
  assert.deepEqual(views.at(-1).liveness, { child: 'ended', reused: 'ended', plain: 'unknown' });
  assert.equal(views.at(-1).attentionCount, 1);
});

// T402: every interruption ends in an honest state without restarting
// anything, and a persistent failure is reported once, not on every re-read.
const interruptionsHarness = fileURLToPath(new URL('fixtures/gjs-interruptions-harness.js', import.meta.url));

test('the reader recovers from every listed interruption and reports a persistent failure once', { skip: process.platform !== 'linux' }, async (t) => {
  const { lines } = await runHarness(t, interruptionsHarness);
  const steps = new Map();
  let current = 'start';
  for (const line of lines) {
    if (line.kind === 'step') {
      current = line.name;
      steps.set(current, { skipped: line.skipped, lines: [] });
    } else {
      steps.get(current)?.lines.push(line);
    }
  }
  const last = (name) => steps.get(name).lines.at(-1);
  assert.deepEqual(last('valid').sessions, ['a']);
  assert.deepEqual(last('deleted').sessions, [], 'a deleted file reads as no sessions');
  assert.deepEqual(last('recreated').sessions, ['b']);
  assert.equal(last('corrupted').kind, 'unavailable');
  assert.equal(steps.get('corrupted').lines.filter((line) => line.kind === 'unavailable').length, 1,
    'a file that stays corrupt across several re-reads is reported once');
  if (!steps.get('unreadable').skipped) assert.match(last('unreadable').message, /Cannot read the state file/);
  assert.deepEqual(last('readable-again').sessions, ['c']);
  assert.deepEqual(last('rapid').sessions, ['d29'], 'a burst of writes settles on the last one');
  assert.ok(steps.get('rapid').lines.length < 30, 'a burst is debounced, not rendered once per write');
  assert.deepEqual(last('directory-removed').sessions, []);
  assert.deepEqual(last('directory-recreated').sessions, ['e'], 'a recreated state directory is watched again');
  assert.equal(last('clock-past-stale').stale, true, 'an active session goes stale with no new write');
  assert.equal(last('clock-past-stale').status, 'running', 'stale keeps the observed status, never completed or failed');
  assert.equal(last('fresh-event').stale, false, 'a later event clears staleness');
});

test('the liveness timer runs only while some session recorded a process', { skip: process.platform !== 'linux' }, async (t) => {
  const { lines } = await robustness(t, 'liveness-timer');
  assert.deepEqual(lines.filter((line) => line.kind === 'timer').map((line) => line.running), [false, true, false]);
});

// T403: the window lookup starts from processFor and walks real /proc parents.
const focusHarness = fileURLToPath(new URL('fixtures/gjs-focus-harness.js', import.meta.url));

test('the parent chain is read from /proc, and only a still-running recorded process is handed out', { skip: process.platform !== 'linux' }, async (t) => {
  const { lines } = await runHarness(t, focusHarness);
  const chain = lines.find((line) => line.kind === 'chain').chain;
  assert.equal(chain[1], process.pid, 'gjs was started by this test process, so it is the first ancestor');
  assert.deepEqual(lines.find((line) => line.kind === 'process'), { kind: 'process', live: true, reused: null, missing: null });
  assert.deepEqual(lines.find((line) => line.kind === 'after-exit'), { kind: 'after-exit', live: null });
});
