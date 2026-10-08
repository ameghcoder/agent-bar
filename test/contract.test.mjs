import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';
import { normalizeEvent } from '../dist/agents/claude-code/translate.js';
import {
  defaultStaleAfterMs, notificationsFor, presentSnapshot, statusIntent, statusLabel, statusPriority, titleNameLimit,
} from '../dist/src/core/presentation.js';
import { maxSnapshotBytes, parseSnapshot, schemaVersion, sessionRetentionMs } from '../dist/src/core/snapshot.js';
import { eventTypes, statuses } from '../dist/src/core/vocabulary.js';

// ADR 0007: contract/ is the language-neutral source other ports read. These
// tests hold it equal to the TypeScript implementation, without a schema
// validator dependency, and run its fixtures as conformance cases.
const contract = new URL('../contract/', import.meta.url);
const json = async (name) => JSON.parse(await readFile(new URL(name, contract), 'utf8'));
const state = await json('state.schema.json');
const event = await json('event.schema.json');
const presentation = await json('presentation.json');

test('the state schema names exactly the vocabulary and session fields the reader accepts', () => {
  assert.equal(state.properties.schemaVersion.const, schemaVersion);
  assert.deepEqual(state.$defs.status.enum, [...statuses]);
  assert.deepEqual(state.$defs.eventType.enum, [...eventTypes]);
  const session = {
    sessionId: 's', projectName: 'p', projectPath: '/p', source: 'claude-code', status: 'idle',
    lastEventType: 'stop', lastMessage: 'm', startedAt: '2026-10-08T12:00:00.000Z', lastSeenAt: '2026-10-08T12:00:00.000Z',
  };
  assert.deepEqual([...state.$defs.session.required].sort(), Object.keys(session).sort());
  assert.deepEqual(Object.keys(state.$defs.session.properties).sort(), Object.keys(session).sort());
  const snapshot = (sessions) => JSON.stringify({ schemaVersion, updatedAt: session.startedAt, sessions });
  assert.equal(parseSnapshot(snapshot([session])).ok, true);
  for (const field of state.$defs.session.required) {
    const { [field]: _dropped, ...missing } = session;
    assert.equal(parseSnapshot(snapshot([missing])).ok, false, `a session without ${field} must be rejected`);
  }
});

test('the event schema names exactly the fields a normalized event carries', () => {
  const normalized = normalizeEvent('stop', { session_id: 's', cwd: '/home/me/p' });
  assert.deepEqual([...event.required].sort(), Object.keys(normalized).sort());
  assert.deepEqual(Object.keys(event.properties).sort(), Object.keys(normalized).sort());
});

test('presentation.json matches every label, intent, priority, urgency, and limit', () => {
  assert.deepEqual(Object.keys(presentation.statuses), [...statuses]);
  const quiet = { schemaVersion, updatedAt: '2026-10-08T12:00:00.000Z', sessions: [] };
  for (const status of statuses) {
    const rule = presentation.statuses[status];
    assert.deepEqual([rule.label, rule.intent, rule.priority], [statusLabel(status), statusIntent(status), statusPriority(status)], status);
    const session = {
      sessionId: 's', projectName: 'p', projectPath: '/p', source: 'claude-code', status,
      lastEventType: 'stop', lastMessage: 'm', startedAt: quiet.updatedAt, lastSeenAt: quiet.updatedAt,
    };
    const [notification] = notificationsFor(presentSnapshot(quiet), presentSnapshot({ ...quiet, sessions: [session] }));
    assert.equal(rule.notify, notification?.urgency ?? null, status);
  }
  assert.equal(presentation.staleAfterMs, defaultStaleAfterMs);
  assert.equal(presentation.sessionRetentionMs, sessionRetentionMs);
  assert.equal(presentation.maxSnapshotBytes, maxSnapshotBytes);
  assert.equal(presentation.titleNameLimit, titleNameLimit);
});

test('every contract fixture is a valid snapshot and presents exactly its expected view', async () => {
  const names = (await readdir(new URL('fixtures/', contract))).filter((name) => name.endsWith('.json'));
  assert.ok(names.length >= 7);
  for (const name of names) {
    const fixture = await json(`fixtures/${name}`);
    const parsed = parseSnapshot(JSON.stringify(fixture.snapshot));
    assert.equal(parsed.ok, true, name);
    assert.deepEqual(presentSnapshot(parsed.state, { now: Date.parse(fixture.now) }), fixture.view, name);
  }
});
