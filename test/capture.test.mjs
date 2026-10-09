import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { captureEvent } from '../dist/src/core/state.js';

// T405 (M4 review): reconcile may adjust what an adapter records, but the
// event's identity and its commit-order timestamp belong to core. A reconcile
// that changed the session ID would overwrite another session's slot.
test('capture keeps id, sessionId, and timestamp from normalize, whatever reconcile returns', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'agentbar-capture-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const previous = process.env.AGENTBAR_STATE_DIR;
  process.env.AGENTBAR_STATE_DIR = directory;
  t.after(() => { if (previous === undefined) delete process.env.AGENTBAR_STATE_DIR; else process.env.AGENTBAR_STATE_DIR = previous; });
  const event = (sessionId) => ({
    id: `id-${sessionId}`, timestamp: '2026-10-09T12:00:00.000Z', source: 'claude-code', projectPath: '/home/me/p', projectName: 'p',
    sessionId, eventType: 'pre_tool_use', status: 'running', message: 'm', raw: {},
  });
  await captureEvent({ normalize: () => event('other'), reconcile: (e) => e });
  const recorded = await captureEvent({
    normalize: () => event('mine'),
    reconcile: (e) => ({ ...e, id: 'forged', sessionId: 'other', timestamp: '2000-01-01T00:00:00.000Z', status: 'completed' }),
  });
  assert.deepEqual([recorded.id, recorded.sessionId, recorded.timestamp, recorded.status], ['id-mine', 'mine', '2026-10-09T12:00:00.000Z', 'completed']);
  const state = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'));
  assert.deepEqual(state.sessions.map((session) => [session.sessionId, session.status]), [['other', 'running'], ['mine', 'completed']]);
});
