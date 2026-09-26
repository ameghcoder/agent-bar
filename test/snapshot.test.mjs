import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parseSnapshot } from '../dist/core/snapshot.js';

const receiver = fileURLToPath(new URL('../dist/hooks/claude-hook.js', import.meta.url));

function fixture(name) {
  return readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
}

async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), 'agentbar-snapshot-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function hook(directory, type, raw = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [receiver, '--event', type], {
      env: { ...process.env, AGENTBAR_STATE_DIR: directory },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', (data) => { stderr += data; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stderr }));
    child.stdin.end(JSON.stringify(raw));
  });
}

test('new snapshots carry integer schemaVersion 1 alongside updatedAt and sessions', async (t) => {
  const directory = await temporaryDirectory(t);
  assert.equal((await hook(directory, 'session_start', { session_id: 'v1', cwd: '/home/me/project' })).code, 0);
  const state = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'));
  assert.equal(state.schemaVersion, 1);
  assert.equal(Number.isInteger(state.schemaVersion), true);
  assert.equal(typeof state.updatedAt, 'string');
  assert.equal(state.sessions.length, 1);
  assert.equal(state.sessions[0].sessionId, 'v1');
});

test('a version 1 snapshot parses into sessions without needing raw payloads', async () => {
  const result = parseSnapshot(await fixture('snapshot-v1.json'));
  assert.equal(result.ok, true);
  assert.equal(result.state.schemaVersion, 1);
  assert.equal(result.state.updatedAt, '2026-09-12T10:00:05.000Z');
  assert.deepEqual(result.state.sessions.map((s) => [s.sessionId, s.status]), [
    ['sess-a', 'permission_required'], ['sess-b', 'completed'],
  ]);
  assert.equal('raw' in result.state.sessions[0], false);
});

test('the legacy unversioned beta shape is accepted as version 1 and flagged legacy', async () => {
  const result = parseSnapshot(await fixture('snapshot-legacy.json'));
  assert.equal(result.ok, true);
  assert.equal(result.legacy, true);
  assert.equal(result.state.schemaVersion, 1);
  assert.equal(result.state.sessions[0].sessionId, 'legacy-1');
  const versioned = parseSnapshot(await fixture('snapshot-v1.json'));
  assert.equal(versioned.legacy, false);
});

test('a future schema version is reported as unsupported, not as malformed', async () => {
  const result = parseSnapshot(await fixture('snapshot-future.json'));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unsupported_version');
  assert.match(result.message, /version 2/);
  assert.match(result.message, /supports version 1/);
  for (const version of ['1', 1.5, 0, -1, null, true]) {
    const bad = parseSnapshot(JSON.stringify({ schemaVersion: version, updatedAt: '2026-09-12T10:00:05.000Z', sessions: [] }));
    assert.equal(bad.ok, false, `schemaVersion ${JSON.stringify(version)} should be rejected`);
    assert.equal(bad.reason, 'unsupported_version');
  }
});

test('malformed and wrong-shape snapshots return typed failures instead of throwing', async () => {
  const malformed = parseSnapshot(await fixture('snapshot-malformed.txt'));
  assert.equal(malformed.ok, false);
  assert.equal(malformed.reason, 'malformed_json');
  for (const text of ['', '   ', 'null', '[]', '42', '"state"', '{}',
    '{"schemaVersion":1,"updatedAt":"not a date","sessions":[]}',
    '{"schemaVersion":1,"updatedAt":"2026-09-12T10:00:05.000Z"}',
    '{"schemaVersion":1,"updatedAt":"2026-09-12T10:00:05.000Z","sessions":[{}]}',
    '{"schemaVersion":1,"updatedAt":"2026-09-12T10:00:05.000Z","sessions":[{"sessionId":"x","projectName":"p","projectPath":"/p","source":"claude-code","status":"bogus","lastEventType":"stop","lastMessage":"m","startedAt":"2026-09-12T10:00:05.000Z","lastSeenAt":"2026-09-12T10:00:05.000Z"}]}',
  ]) {
    const result = parseSnapshot(text);
    assert.equal(result.ok, false, `expected failure for ${JSON.stringify(text)}`);
    assert.equal(['malformed_json', 'invalid_shape'].includes(result.reason), true);
    assert.equal(typeof result.message, 'string');
  }
});

test('the writer upgrades a legacy file in place and refuses to overwrite a future version', async (t) => {
  const directory = await temporaryDirectory(t);
  await writeFile(join(directory, 'state.json'), await fixture('snapshot-legacy.json'));
  assert.equal((await hook(directory, 'stop', { session_id: 'legacy-1', cwd: '/home/dev/old' })).code, 0);
  const upgraded = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'));
  assert.equal(upgraded.schemaVersion, 1);
  assert.deepEqual(upgraded.sessions.map((s) => [s.sessionId, s.status]), [['legacy-1', 'completed']]);

  const future = await fixture('snapshot-future.json');
  await writeFile(join(directory, 'state.json'), future);
  const result = await hook(directory, 'stop', { session_id: 'future-1' });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /schema version 2/);
  assert.match(result.stderr, /not overwritten/);
  assert.equal(await readFile(join(directory, 'state.json'), 'utf8'), future);
});

test('the compiled snapshot reader only imports portable sibling files, never a node: module, so GJS can load it', async () => {
  const compiled = await readFile(new URL('../dist/core/snapshot.js', import.meta.url), 'utf8');
  const specifiers = [...compiled.matchAll(/^import .* from '([^']+)';$/gm)].map((match) => match[1]);
  assert.equal(specifiers.length > 0, true, 'sanity check: this file does import something');
  for (const specifier of specifiers) assert.match(specifier, /^\.\//, specifier);
  const vocabulary = await readFile(new URL('../dist/core/vocabulary.js', import.meta.url), 'utf8');
  assert.doesNotMatch(vocabulary, /^\s*(import|export .* from|const .* = require)\b/m, 'its one dependency must itself be import-free');
});
