import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { sessionRetentionMs, withoutExpiredSessions } from '../dist/core/snapshot.js';
import { notificationsFor, presentSnapshot, statusIntent, statusLabel, statusPriority } from '../dist/core/presentation.js';

// Labels and intents come from CONTEXT.md's observable-status table and
// ADR 0004: "Turn complete", never "Done"; unknown is never success.
test('every observable status has a label and a visual intent', () => {
  const statuses = ['idle', 'running', 'waiting', 'permission_required', 'completed', 'failed', 'unknown'];
  assert.deepEqual(statuses.map((status) => [status, statusLabel(status), statusIntent(status)]), [
    ['idle', 'Idle', 'quiet'],
    ['running', 'Working', 'active'],
    ['waiting', 'Waiting for you', 'attention'],
    ['permission_required', 'Permission needed', 'attention'],
    ['completed', 'Turn complete', 'complete'],
    ['failed', 'Failed', 'error'],
    ['unknown', 'Status unknown', 'unknown'],
  ]);
});

// Agreed with the user 2026-09-25: permission and failure block the developer,
// waiting asks for input, running is informational, unknown outranks idle
// because an unclassifiable state is not quiet.
const byUrgency = ['permission_required', 'failed', 'waiting', 'running', 'completed', 'unknown', 'idle'];

test('status priority is total, distinct, and ordered most urgent first', () => {
  const ranks = byUrgency.map(statusPriority);
  assert.equal(new Set(ranks).size, byUrgency.length, 'every status has its own rank');
  for (let higher = 0; higher < byUrgency.length; higher += 1) {
    for (let lower = higher + 1; lower < byUrgency.length; lower += 1) {
      assert.ok(
        statusPriority(byUrgency[higher]) > statusPriority(byUrgency[lower]),
        `${byUrgency[higher]} must outrank ${byUrgency[lower]}`,
      );
    }
  }
});

const now = Date.parse('2026-09-25T12:00:00.000Z');
const minutes = (count) => new Date(now - count * 60_000).toISOString();

function session(sessionId, status, seenMinutesAgo, extra = {}) {
  return {
    sessionId,
    projectName: sessionId,
    projectPath: `/home/secret/${sessionId}`,
    source: 'claude-code',
    status,
    lastEventType: 'stop',
    lastMessage: `${sessionId} message`,
    startedAt: minutes(60),
    lastSeenAt: minutes(seenMinutesAgo),
    ...extra,
  };
}

const snapshot = (sessions) => ({ schemaVersion: 1, updatedAt: minutes(0), sessions });

test('sessions are ordered attention first, then most recently seen', () => {
  const view = presentSnapshot(snapshot([
    session('alpha', 'running', 1),
    session('bravo', 'permission_required', 5),
    session('charlie', 'completed', 0.5),
    session('delta', 'failed', 2),
  ]), { now });
  assert.deepEqual(view.sessions.map((row) => row.sessionId), ['delta', 'bravo', 'charlie', 'alpha']);
  assert.equal(view.attentionCount, 2);
});

test('an identical last-seen time falls back to session id so ordering is deterministic', () => {
  const view = presentSnapshot(snapshot([
    session('zulu', 'running', 3),
    session('alpha', 'running', 3),
  ]), { now });
  assert.deepEqual(view.sessions.map((row) => row.sessionId), ['alpha', 'zulu']);
});

test('a session row carries presentation fields only, never raw payload or full path', () => {
  const [row] = presentSnapshot(snapshot([
    session('alpha', 'waiting', 1, { raw: { tool_input: { command: 'rm -rf /' } } }),
  ]), { now }).sessions;
  assert.deepEqual(row, {
    sessionId: 'alpha',
    projectName: 'alpha',
    status: 'waiting',
    label: 'Waiting for you',
    intent: 'attention',
    message: 'alpha message',
    hint: '',
    relative: '1m ago',
    attention: true,
    stale: false,
    staleForMs: 0,
    lastSeenAt: minutes(1),
  });
  const serialised = JSON.stringify(row);
  assert.doesNotMatch(serialised, /secret|rm -rf|tool_input|projectPath|startedAt|lastEventType/);
});

test('an empty snapshot presents a quiet indicator with no sessions', () => {
  const view = presentSnapshot(snapshot([]), { now });
  assert.deepEqual(view, {
    status: 'idle', label: 'Idle', intent: 'quiet', stale: false, attentionCount: 0, sessions: [],
    title: 'AgentBar - No sessions',
    leaderId: null,
    health: 'No events yet · run "agentbar install-hooks"',
  });
});

const after = (sessions, staleAfterMs = 60_000) => presentSnapshot(snapshot(sessions), { now, staleAfterMs });
const age = (ms) => new Date(now - ms).toISOString();

test('the stale boundary is inclusive: just before is fresh, exactly on and past it are stale', () => {
  const rows = after([
    { ...session('just-fresh', 'running', 0), lastSeenAt: age(59_999) },
    { ...session('on-boundary', 'running', 0), lastSeenAt: age(60_000) },
    { ...session('just-stale', 'running', 0), lastSeenAt: age(60_001) },
  ]).sessions;
  assert.deepEqual(
    rows.map((row) => [row.sessionId, row.stale, row.staleForMs]),
    [['just-fresh', false, 0], ['on-boundary', true, 0], ['just-stale', true, 1]],
  );
});

test('staleness applies only to active states; settled states never decay', () => {
  const rows = after([
    session('ran', 'running', 600),
    session('waited', 'waiting', 600),
    session('asked', 'permission_required', 600),
    session('done', 'completed', 600),
    session('broke', 'failed', 600),
    session('quiet', 'idle', 600),
    session('dunno', 'unknown', 600),
  ]).sessions;
  assert.deepEqual(
    Object.fromEntries(rows.map((row) => [row.sessionId, row.stale])),
    { ran: true, waited: true, asked: true, done: false, broke: false, quiet: false, dunno: false },
  );
});

test('a clock running backwards degrades safely: a future timestamp is fresh, not stale', () => {
  const [row] = after([{ ...session('skewed', 'running', 0), lastSeenAt: age(-3_600_000) }]).sessions;
  assert.deepEqual([row.stale, row.staleForMs], [false, 0]);
});

test('an unreadable timestamp on an active session is stale, never assumed fresh', () => {
  const [row] = after([{ ...session('broken-clock', 'running', 0), lastSeenAt: 'not-a-date' }]).sessions;
  assert.deepEqual([row.stale, row.staleForMs], [true, 0]);
});

test('a stale active session keeps its observed status but is never shown as fact', () => {
  const view = after([session('asked', 'permission_required', 600)]);
  assert.deepEqual(view.sessions[0].status, 'permission_required', 'permission stays pending until an event replaces it');
  assert.deepEqual(
    [view.sessions[0].label, view.sessions[0].intent],
    ['Permission needed', 'unknown'],
    'the menu keeps the observed label but drops the confident intent',
  );
  assert.deepEqual([view.status, view.label, view.intent, view.stale], ['permission_required', 'Status unknown', 'unknown', true]);
});

test('a fresh session outranks a stale one of the same status in the aggregate', () => {
  const view = after([session('old', 'permission_required', 600), session('new', 'permission_required', 0)]);
  assert.deepEqual([view.label, view.stale], ['Permission needed', false]);
});

const view = (sessions) => presentSnapshot(snapshot(sessions), { now });

test('the first render never notifies, so restarting the shell does not replay old state', () => {
  assert.deepEqual(notificationsFor(undefined, view([session('alpha', 'permission_required', 1)])), []);
});

test('entering an attention state notifies once, and repeating the same snapshot notifies nothing', () => {
  const before = view([session('alpha', 'running', 2)]);
  const asked = view([{ ...session('alpha', 'permission_required', 1), lastMessage: 'Claude needs permission' }]);
  assert.deepEqual(notificationsFor(before, asked), [{
    key: `alpha:permission_required:${minutes(1)}`,
    sessionId: 'alpha',
    title: 'Permission needed',
    body: 'alpha: Claude needs permission',
    intent: 'attention',
    urgency: 'critical',
  }]);
  assert.deepEqual(notificationsFor(asked, asked), []);
});

test('a finished turn notifies; progress within a turn does not', () => {
  const running = view([session('alpha', 'running', 3)]);
  assert.deepEqual(notificationsFor(running, view([session('alpha', 'running', 1)])), []);
  assert.deepEqual(
    notificationsFor(running, view([session('alpha', 'completed', 1)])).map((item) => item.title),
    ['Turn complete'],
  );
});

test('quiet statuses never notify, whatever they replace', () => {
  const asked = view([session('alpha', 'permission_required', 3)]);
  for (const status of ['running', 'idle', 'unknown']) {
    assert.deepEqual(notificationsFor(asked, view([session('alpha', status, 1)])), [], status);
  }
});

test('a session first seen after startup notifies on its own attention state', () => {
  const before = view([session('alpha', 'running', 3)]);
  const joined = view([session('alpha', 'running', 3), session('bravo', 'failed', 1)]);
  assert.deepEqual(notificationsFor(before, joined).map((item) => [item.sessionId, item.title]), [['bravo', 'Failed']]);
});

test('going stale is not an event, so it raises no notification', () => {
  const fresh = presentSnapshot(snapshot([session('alpha', 'running', 0)]), { now, staleAfterMs: 60_000 });
  const stale = presentSnapshot(snapshot([session('alpha', 'running', 0)]), { now: now + 600_000, staleAfterMs: 60_000 });
  assert.equal(stale.sessions[0].stale, true);
  assert.deepEqual(notificationsFor(fresh, stale), []);
});

test('a second permission request in the same session notifies again under a new key', () => {
  const first = view([session('alpha', 'permission_required', 5)]);
  const working = view([session('alpha', 'running', 3)]);
  const second = view([session('alpha', 'permission_required', 1)]);
  const keys = [...notificationsFor(undefined, first), ...notificationsFor(first, working), ...notificationsFor(working, second)]
    .map((item) => item.key);
  assert.deepEqual(keys, [`alpha:permission_required:${minutes(1)}`]);
  assert.notEqual(`alpha:permission_required:${minutes(5)}`, `alpha:permission_required:${minutes(1)}`);
});

// ADR 0004 allows a short path hint in the menu, only where project names collide.
test('sessions sharing a project name get a parent-directory hint; unique ones get none', () => {
  const rows = view([
    { ...session('alpha', 'running', 1), projectName: 'agent-bar', projectPath: '/home/me/work/agent-bar' },
    { ...session('bravo', 'running', 2), projectName: 'agent-bar', projectPath: '/home/me/play/agent-bar' },
    { ...session('charlie', 'running', 3), projectName: 'solo', projectPath: '/home/me/work/solo' },
  ]).sessions;
  assert.deepEqual(rows.map((row) => [row.projectName, row.hint]), [
    ['agent-bar', 'work'], ['agent-bar', 'play'], ['solo', ''],
  ]);
});

test('the compiled presentation model imports nothing, so the GJS extension can load it', async () => {
  const compiled = await readFile(new URL('../dist/core/presentation.js', import.meta.url), 'utf8');
  assert.doesNotMatch(compiled, /^\s*(import|export .* from|const .* = require)\b/m);
});

test('a session row reports a short relative last-seen time, refreshed by whatever now is passed in', () => {
  const rows = presentSnapshot(snapshot([
    { ...session('now', 'running', 0), lastSeenAt: age(500) },
    { ...session('secs', 'running', 0), lastSeenAt: age(45_000) },
    { ...session('min', 'running', 0), lastSeenAt: age(5 * 60_000) },
    { ...session('hour', 'running', 0), lastSeenAt: age(3 * 3_600_000) },
    { ...session('day', 'running', 0), lastSeenAt: age(2 * 86_400_000) },
  ]), { now }).sessions;
  assert.deepEqual(Object.fromEntries(rows.map((row) => [row.sessionId, row.relative])), {
    now: 'just now', secs: 'just now', min: '5m ago', hour: '3h ago', day: '2d ago',
  });
});

test('relative time degrades safely: an unreadable or future timestamp never claims a specific age', () => {
  const rows = presentSnapshot(snapshot([
    { ...session('skewed', 'running', 0), lastSeenAt: age(-60_000) },
    { ...session('broken', 'running', 0), lastSeenAt: 'not-a-date' },
    { ...session('week-plus', 'running', 0), lastSeenAt: age(9 * 86_400_000) },
  ]), { now }).sessions;
  assert.deepEqual(Object.fromEntries(rows.map((row) => [row.sessionId, row.relative])), {
    skewed: 'just now', broken: 'unknown', 'week-plus': new Date(now - 9 * 86_400_000).toISOString().slice(0, 10),
  });
});

test('notification urgency is decided by presentation.ts, not left for the extension to infer from intent alone', () => {
  const transitions = [
    ['permission_required', 'critical'],
    ['failed', 'high'],
    ['waiting', 'normal'],
    ['completed', 'low'],
  ];
  for (const [status, expected] of transitions) {
    const before = view([session('alpha', 'running', 2)]);
    const after = view([session('alpha', status, 1)]);
    const [notification] = notificationsFor(before, after);
    assert.equal(notification.urgency, expected, status);
  }
});

// T314: a session with no event for 24 hours is gone, whatever its status.
const hours = (count) => count * 60;

test('retention is 24 hours', () => {
  assert.equal(sessionRetentionMs, 24 * 60 * 60 * 1000);
});

test('withoutExpiredSessions drops sessions older than the window and keeps the rest', () => {
  const sessions = [
    session('fresh', 'running', 1),
    session('edge', 'idle', hours(24) - 1),
    session('old-idle', 'idle', hours(24) + 1),
    session('old-active', 'permission_required', hours(24 * 20)),
  ];
  assert.deepEqual(withoutExpiredSessions(sessions, now).map((row) => row.sessionId), ['fresh', 'edge']);
});

test('a future last-seen time (clock ran backwards) is kept, not expired', () => {
  const sessions = [session('skewed', 'running', -hours(48))];
  assert.equal(withoutExpiredSessions(sessions, now).length, 1);
});

// T312: the top bar reads "<project> - <State>" for the session that matters.
test('a single fresh session reads "project - State"', () => {
  assert.equal(view([session('alpha', 'running', 1)]).title, 'alpha - Working - 1m ago');
});

test('+N counts only the other fresh running sessions, not waiting, permission, idle, completed, failed, or stale ones', () => {
  const result = view([
    session('alpha', 'permission_required', 1),
    session('bravo', 'running', 2),
    session('charlie', 'waiting', 3),
    session('delta', 'idle', 1),
    session('echo', 'completed', 1),
    session('stale-one', 'running', 600),
    session('failed-one', 'failed', 1),
  ]);
  assert.equal(result.title, 'alpha - Permission needed - 1m ago +1');
});

test('a fresh session leads over an older stale one, whatever the stale status', () => {
  const result = view([session('old', 'permission_required', 600), session('new', 'idle', 1)]);
  assert.equal(result.title, 'new - Idle - 1m ago');
  assert.deepEqual([result.status, result.intent, result.stale], ['idle', 'quiet', false]);
});

test('when every session is stale the title says how long it has been quiet, not a guessed state', () => {
  const result = view([session('old', 'permission_required', 600)]);
  assert.equal(result.title, 'old - No updates - 10h ago');
  assert.deepEqual([result.intent, result.stale], ['unknown', true]);
  assert.equal(after([session('old', 'running', 5)]).title, 'old - No updates - 5m ago');
  assert.equal(after([session('old', 'running', 60 * 24 * 3)]).title, 'old - No updates - 3d ago');
});

test('a long project name is cut to 18 characters so the top bar does not grow', () => {
  const result = view([session('a'.repeat(30), 'running', 1)]);
  assert.equal(result.title, `${'a'.repeat(17)}… - Working - 1m ago`);
  assert.equal(view([session('b'.repeat(18), 'running', 1)]).title, `${'b'.repeat(18)} - Working - 1m ago`);
});

test('the title never carries a path hint or raw data', () => {
  const result = view([
    session('same', 'running', 1, { projectPath: '/home/secret/one/same' }),
    session('same', 'running', 2, { sessionId: 'other', projectPath: '/home/secret/two/same' }),
  ]);
  assert.equal(result.title, 'same - Working - 1m ago +1');
  assert.doesNotMatch(result.title, /secret|one|two/);
});

test('an unreadable timestamp on the only session names no age', () => {
  const result = view([session('odd', 'running', 0, { lastSeenAt: 'not a date' })]);
  assert.equal(result.title, 'odd - No updates');
});

test('the leader id is stable while the time text changes, so a pulse is not restarted every minute', () => {
  const sessions = [session('alpha', 'permission_required', 0), session('bravo', 'idle', 0)];
  const early = presentSnapshot(snapshot(sessions), { now });
  const later = presentSnapshot(snapshot(sessions), { now: now + 3 * 60_000 });
  assert.equal(early.title, 'alpha - Permission needed - just now');
  assert.equal(later.title, 'alpha - Permission needed - 3m ago');
  assert.equal(early.leaderId, 'alpha');
  assert.equal(later.leaderId, 'alpha');
});

// T316: the health row says only what the state file proves. It never claims
// hooks are or are not installed - that is `agentbar doctor`'s job.
test('health says no events yet when the state holds no sessions', () => {
  assert.equal(view([]).health, 'No events yet · run "agentbar install-hooks"');
});

test('health reports receiving events when the newest event is within the stale window', () => {
  const result = view([session('old', 'completed', 300), session('fresh', 'running', 2)]);
  assert.equal(result.health, 'Receiving events · last 2m ago');
});

test('health reports no recent events once the newest event is older than the stale window, even for settled sessions', () => {
  assert.equal(view([session('done', 'completed', 180)]).health, 'No recent events · last 3h ago');
});

test('health names no age when no timestamp is readable', () => {
  assert.equal(view([session('odd', 'running', 0, { lastSeenAt: 'not a date' })]).health, 'No recent events');
});

test('health ignores an unreadable timestamp when another session has a good one', () => {
  const result = view([session('odd', 'running', 0, { lastSeenAt: 'not a date' }), session('ok', 'running', 1)]);
  assert.equal(result.health, 'Receiving events · last 1m ago');
});

test('health carries no session data', () => {
  assert.doesNotMatch(view([session('alpha', 'running', 1, { lastMessage: 'secret' })]).health, /alpha|secret/);
});

test('health reads naturally for an event that just arrived', () => {
  assert.equal(view([session('now', 'running', 0)]).health, 'Receiving events · just now');
});
