import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// extension/lib/state-reader.js is Shell-independent (only GLib/Gio), so it
// runs under the real gjs runtime headlessly. This drives it for real against
// a real temporary directory and real atomic renames - see the harness for
// the exact scripted sequence.
const harness = fileURLToPath(new URL('fixtures/gjs-state-reader-harness.js', import.meta.url));
const unreadableHarness = fileURLToPath(new URL('fixtures/gjs-unreadable-state-harness.js', import.meta.url));

const expiredHarness = fileURLToPath(new URL('fixtures/gjs-expired-sessions-harness.js', import.meta.url));

async function runHarness(t, script = harness) {
  const directory = await mkdtemp(join(tmpdir(), 'agentbar-state-reader-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { code, lines } = await new Promise((resolve, reject) => {
    const child = spawn('gjs', ['-m', script, directory], { stdio: ['ignore', 'pipe', 'pipe'] });
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
