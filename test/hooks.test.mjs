import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createHooksConfig, shellQuote } from '../dist/agents/claude-code/install/hooks-config.js';

const receiver = fileURLToPath(new URL('../dist/agents/claude-code/hooks/claude-hook.js', import.meta.url));
const cli = fileURLToPath(new URL('../dist/src/cli/index.js', import.meta.url));

async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), 'agentbar-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

// CLAUDE_PROJECT_DIR and CLAUDE_PID are removed unless a test sets them, so running the suite
// from inside a Claude hook or session cannot change which root is recorded.
function run(directory, args, input = '', command = process.execPath, env = {}) {
  const { CLAUDE_PROJECT_DIR: _ignored, CLAUDE_PID: _pid, ...inherited } = process.env;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...inherited, AGENTBAR_STATE_DIR: directory, CLAUDE_CONFIG_DIR: directory, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (data) => { stdout += data; });
    child.stderr.setEncoding('utf8').on('data', (data) => { stderr += data; });
    child.on('error', reject);
    child.stdin.on('error', (error) => { if (error.code !== 'EPIPE') reject(error); });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

function hook(directory, type, raw = {}, env = {}) {
  return run(directory, [receiver, '--event', type], JSON.stringify(raw), process.execPath, env);
}

async function readState(directory) {
  return JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'));
}

async function readHistory(directory) {
  return (await readFile(join(directory, 'events.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
}

test('captures the lifecycle, keeps raw input and preserves first-seen time', async (t) => {
  const directory = join(await temporaryDirectory(t), 'nested', 'state');
  const payload = { session_id: 'lifecycle', cwd: '/home/me/project', tool_name: 'Edit', tool_input: { file_path: 'a.ts' } };
  let startedAt;
  for (const [type, status] of [
    ['session_start', 'idle'], ['pre_tool_use', 'running'], ['post_tool_use', 'running'],
    ['notification', 'waiting'], ['permission_request', 'permission_required'],
    ['stop', 'completed'], ['error', 'failed'], ['session_end', 'idle'],
  ]) {
    const raw = { ...payload, notification_type: 'idle_prompt' };
    assert.deepEqual(await hook(directory, type, raw), { code: 0, stdout: '', stderr: '' });
    const state = await readState(directory);
    startedAt ??= state.sessions[0].startedAt;
    assert.equal(state.sessions.length, 1);
    assert.equal(state.sessions[0].status, status);
    assert.equal(state.sessions[0].startedAt, startedAt);
    assert.equal(state.sessions[0].projectName, 'project');
    assert.equal(state.sessions[0].lastSeenAt, state.updatedAt);
    const event = (await readHistory(directory)).at(-1);
    assert.deepEqual(event.raw, raw);
    assert.equal(event.eventType, type);
    assert.equal(event.source, 'claude-code');
  }
  const history = await readHistory(directory);
  assert.equal(new Set(history.map((event) => event.id)).size, 8);
  assert.equal((await stat(join(directory, 'state.json'))).mode & 0o777, 0o600);
  assert.equal((await stat(join(directory, 'events.jsonl'))).mode & 0o777, 0o600);
});

test('missing session IDs have stable project fallbacks without merging named sessions', async (t) => {
  const directory = await temporaryDirectory(t);
  await hook(directory, 'session_start', { session_id: 'test-1', cwd: '/home/me/project' });
  await hook(directory, 'pre_tool_use', { tool_name: 'Edit', cwd: '/home/me/project' });
  await hook(directory, 'permission_request', { message: 'Claude needs permission', cwd: '/home/me/project' });
  const state = await readState(directory);
  assert.equal(state.sessions.length, 2);
  assert.equal(state.sessions[0].sessionId, 'test-1');
  assert.match(state.sessions[1].sessionId, /^unknown:/);
  assert.equal(state.sessions[1].status, 'permission_required');
  assert.equal(state.sessions[1].lastMessage, 'Claude needs permission');
});

test('notifications use structured type, not message guesses; failures keep details', async (t) => {
  const directory = await temporaryDirectory(t);
  await hook(directory, 'notification', { notification_type: 'permission_prompt' });
  assert.equal((await readState(directory)).sessions[0].status, 'permission_required');
  await hook(directory, 'notification', { notification_type: 'auth_success', message: 'Permission granted' });
  assert.equal((await readState(directory)).sessions[0].status, 'unknown');
  await hook(directory, 'error', { hook_event_name: 'PostToolUseFailure', error: 'Tool failed' });
  assert.equal((await readState(directory)).sessions[0].lastMessage, 'Tool failed');
  await hook(directory, 'error', { hook_event_name: 'StopFailure', error_details: 'Rate limit reached' });
  assert.equal((await readState(directory)).sessions[0].lastMessage, 'Rate limit reached');
});

test('rejects malformed payloads and arguments without changing saved data', async (t) => {
  const directory = await temporaryDirectory(t);
  await hook(directory, 'session_start');
  const beforeState = await readFile(join(directory, 'state.json'), 'utf8');
  const beforeHistory = await readFile(join(directory, 'events.jsonl'), 'utf8');
  for (const input of ['{bad', '[]', 'null', '42', '"text"']) {
    const result = await run(directory, [receiver, '--event', 'pre_tool_use'], input);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /JSON/);
    assert.equal(result.stdout, '');
  }
  for (const args of [[], ['--event', 'bogus'], ['--event', 'stop', '--unexpected']]) {
    assert.equal((await run(directory, [receiver, ...args])).code, 1);
  }
  assert.equal(await readFile(join(directory, 'state.json'), 'utf8'), beforeState);
  assert.equal(await readFile(join(directory, 'events.jsonl'), 'utf8'), beforeHistory);
});

test('Commander provides CLI help and version output', async (t) => {
  const directory = await temporaryDirectory(t);
  const rootHelp = await run(directory, [cli, '--help']);
  assert.equal(rootHelp.code, 0);
  assert.match(rootHelp.stdout, /Usage: agentbar \[options\] \[command\]/);
  assert.match(rootHelp.stdout, /install-hooks/);

  const hookHelp = await run(directory, [receiver, '--help']);
  assert.equal(hookHelp.code, 0);
  assert.match(hookHelp.stdout, /Usage: agentbar-hook \[options\]/);
  assert.match(hookHelp.stdout, /permission_request/);

  // test/version.test.mjs holds every version source equal to package.json.
  const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal((await run(directory, [cli, '--version'])).stdout.trim(), version);
  assert.equal((await run(directory, [receiver, '--version'])).stdout.trim(), version);
});

test('accepts empty stdin and reports oversized input', async (t) => {
  const directory = await temporaryDirectory(t);
  assert.equal((await run(directory, [receiver, '--event', 'session_start'])).code, 0);
  const result = await run(directory, [receiver, '--event', 'stop'], 'x'.repeat(10 * 1024 * 1024 + 1));
  assert.equal(result.code, 1);
  assert.match(result.stderr, /10 MiB/);
});

test('preserves corrupt state and surfaces filesystem failures', async (t) => {
  const directory = await temporaryDirectory(t);
  for (const content of ['{broken', '{"updatedAt":"today","sessions":[{}]}']) {
    await writeFile(join(directory, 'state.json'), content);
    const result = await hook(directory, 'stop');
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Invalid state file/);
    assert.equal(await readFile(join(directory, 'state.json'), 'utf8'), content);
  }
  const file = join(directory, 'not-a-directory');
  await writeFile(file, 'keep');
  const result = await hook(file, 'stop');
  assert.equal(result.code, 1);
  assert.match(result.stderr, /agentbar-hook:/);
});

test('concurrent hook processes retain every session and complete JSONL record', async (t) => {
  const directory = await temporaryDirectory(t);
  const results = await Promise.all(Array.from({ length: 24 }, (_, index) => hook(directory, 'pre_tool_use', {
    session_id: `parallel-${index}`, cwd: `/tmp/project-${index}`, tool_name: 'Bash',
  })));
  for (const result of results) assert.deepEqual(result, { code: 0, stdout: '', stderr: '' });
  assert.equal((await readState(directory)).sessions.length, 24);
  const history = await readHistory(directory);
  assert.equal(history.length, 24);
  assert.equal(new Set(history.map((event) => event.id)).size, 24);
  assert.equal((await readState(directory)).updatedAt, history.at(-1).timestamp);
});

test('install helper prints usable JSON; example matches the generator', async (t) => {
  const directory = await temporaryDirectory(t);
  const result = await run(directory, [cli, 'install-hooks']);
  assert.equal(result.code, 0);
  assert.match(result.stderr, /no Claude settings have been changed/);
  const config = JSON.parse(result.stdout);
  assert.equal(config.hooks.StopFailure[0].hooks[0].command.endsWith('--event error'), true);
  const command = config.hooks.PreToolUse[0].hooks[0].command;
  assert.equal((await run(directory, ['-c', command], '{"session_id":"config-test","cwd":"/tmp/project"}', '/bin/sh')).code, 0);
  assert.equal((await readState(directory)).sessions[0].sessionId, 'config-test');
  const example = JSON.parse(await readFile(new URL('../agents/claude-code/settings.example.json', import.meta.url), 'utf8'));
  assert.deepEqual(example, createHooksConfig('node /absolute/path/to/agentbar/dist/agents/claude-code/hooks/claude-hook.js'));
  const literal = "/tmp/path with spaces/it's a $(literal) `name`";
  const quoted = await run(directory, ['-c', `printf '%s' ${shellQuote(literal)}`], '', '/bin/sh');
  assert.equal(quoted.stdout, literal);
});

test('session_start from compact keeps an active status; every other source resets to idle', async (t) => {
  const directory = await temporaryDirectory(t);
  const base = { session_id: 'carry', cwd: '/home/me/project' };
  await hook(directory, 'pre_tool_use', { ...base, tool_name: 'Edit' });
  await hook(directory, 'session_start', { ...base, source: 'compact' });
  let session = (await readState(directory)).sessions[0];
  assert.equal(session.status, 'running');
  assert.equal(session.lastMessage, 'Preparing tool: Edit');
  assert.equal(session.lastEventType, 'session_start');
  assert.equal((await readHistory(directory)).at(-1).status, 'running', 'history records the effective status');

  await hook(directory, 'permission_request', { ...base, tool_name: 'Bash' });
  await hook(directory, 'session_start', { ...base, source: 'resume' });
  session = (await readState(directory)).sessions[0];
  assert.equal(session.status, 'idle', 'resume always starts at an empty prompt, so a stale permission prompt must not be revived');
  assert.equal(session.lastMessage, 'Session started');

  await hook(directory, 'session_start', { ...base, source: 'startup' });
  assert.equal((await readState(directory)).sessions[0].status, 'idle');
  await hook(directory, 'pre_tool_use', { ...base, tool_name: 'Edit' });
  await hook(directory, 'session_start', { ...base, source: 'clear' });
  assert.equal((await readState(directory)).sessions[0].status, 'idle');
  await hook(directory, 'pre_tool_use', { ...base, tool_name: 'Edit' });
  await hook(directory, 'session_start', base);
  assert.equal((await readState(directory)).sessions[0].status, 'idle', 'missing source keeps prior behavior');

  await hook(directory, 'session_start', { session_id: 'fresh', cwd: '/home/me/other', source: 'compact' });
  const fresh = (await readState(directory)).sessions.find((s) => s.sessionId === 'fresh');
  assert.equal(fresh.status, 'idle', 'no previous row: nothing to carry');
  await hook(directory, 'stop', base);
  await hook(directory, 'session_start', { ...base, source: 'compact' });
  assert.equal((await readState(directory)).sessions[0].status, 'idle', 'compact after a completed turn has nothing active to carry');
});

test('lastMessage is a short single line and raw message only overrides attention events', async (t) => {
  const directory = await temporaryDirectory(t);
  const base = { session_id: 'msg', cwd: '/home/me/project' };
  const dump = `Traceback (most recent call last):\n  File "/home/me/secret/app.py"\n${'x'.repeat(5000)}\nTOKEN=abc`;
  await hook(directory, 'error', { ...base, hook_event_name: 'PostToolUseFailure', error: dump });
  let session = (await readState(directory)).sessions[0];
  assert.equal(session.lastMessage, 'Traceback (most recent call last):');
  assert.equal((await readHistory(directory)).at(-1).raw.error, dump, 'raw is untouched');

  await hook(directory, 'error', { ...base, error: `   ${'y'.repeat(300)}   ` });
  session = (await readState(directory)).sessions[0];
  assert.equal(session.lastMessage.length, 120);
  assert.equal(session.lastMessage.endsWith('…'), true);

  await hook(directory, 'error', { ...base, error: `${'a'.repeat(118)}🚀🚀🚀` });
  const emoji = (await readState(directory)).sessions[0].lastMessage;
  assert.equal(emoji, `${'a'.repeat(118)}🚀…`, 'truncation never splits a surrogate pair');
  assert.equal(emoji.isWellFormed(), true);

  await hook(directory, 'error', { ...base, error: '  \n\n  \t ' });
  assert.equal((await readState(directory)).sessions[0].lastMessage, 'Claude reported an error', 'blank text falls back to the curated label');

  await hook(directory, 'pre_tool_use', { ...base, tool_name: 'Edit', message: 'sneaky override' });
  assert.equal((await readState(directory)).sessions[0].lastMessage, 'Preparing tool: Edit');
  await hook(directory, 'stop', { ...base, message: 'sneaky override' });
  assert.equal((await readState(directory)).sessions[0].lastMessage, 'Claude finished responding');
  await hook(directory, 'notification', { ...base, notification_type: 'idle_prompt', message: 'Claude is  waiting\nfor you' });
  assert.equal((await readState(directory)).sessions[0].lastMessage, 'Claude is waiting');
  await hook(directory, 'permission_request', { ...base, tool_name: 'Bash', message: 'Allow Bash?' });
  assert.equal((await readState(directory)).sessions[0].lastMessage, 'Allow Bash?');
});

test('capture drops sessions with no event for 24 hours, keeps the rest, and keeps history', async (t) => {
  const directory = await temporaryDirectory(t);
  const ago = (hours) => new Date(Date.now() - hours * 3_600_000).toISOString();
  const row = (sessionId, status, lastSeenAt) => ({
    sessionId, projectName: sessionId, projectPath: `/home/me/${sessionId}`, source: 'claude-code',
    status, lastEventType: 'stop', lastMessage: 'x', startedAt: lastSeenAt, lastSeenAt,
  });
  await writeFile(join(directory, 'state.json'), JSON.stringify({
    schemaVersion: 1,
    updatedAt: ago(1),
    sessions: [row('old-active', 'permission_required', ago(24 * 20)), row('old-idle', 'idle', ago(25)), row('recent', 'completed', ago(23))],
  }));
  await writeFile(join(directory, 'events.jsonl'), '{"id":"earlier"}\n');

  assert.equal((await hook(directory, 'pre_tool_use', { session_id: 'live', cwd: '/home/me/live', tool_name: 'Edit' })).code, 0);

  const state = await readState(directory);
  assert.deepEqual(state.sessions.map((session) => session.sessionId).sort(), ['live', 'recent']);
  const history = await readHistory(directory);
  assert.equal(history.length, 2, 'pruning the snapshot never rewrites history');
  assert.equal(history[0].id, 'earlier');
});

// T311: Claude's `cwd` follows the shell into subdirectories mid-session, so it
// cannot name the project. CLAUDE_PROJECT_DIR, which Claude Code sets for hook
// commands, is the project root; without it the session's first directory holds.
test('the project root comes from CLAUDE_PROJECT_DIR, not the current directory', async (t) => {
  const directory = await temporaryDirectory(t);
  const env = { CLAUDE_PROJECT_DIR: '/home/me/agent-bar' };
  await hook(directory, 'session_start', { session_id: 'rooted', cwd: '/home/me/agent-bar' }, env);
  await hook(directory, 'pre_tool_use', { session_id: 'rooted', cwd: '/home/me/agent-bar/src/lib', tool_name: 'Bash' }, env);
  const [session] = (await readState(directory)).sessions;
  assert.deepEqual([session.projectName, session.projectPath], ['agent-bar', '/home/me/agent-bar']);
});

test('without CLAUDE_PROJECT_DIR a session keeps the directory it was first seen in', async (t) => {
  const directory = await temporaryDirectory(t);
  await hook(directory, 'session_start', { session_id: 'drifting', cwd: '/home/me/agent-bar' });
  await hook(directory, 'pre_tool_use', { session_id: 'drifting', cwd: '/home/me/agent-bar/src', tool_name: 'Bash' });
  const [session] = (await readState(directory)).sessions;
  assert.deepEqual([session.projectName, session.projectPath], ['agent-bar', '/home/me/agent-bar']);
});

test('CLAUDE_PROJECT_DIR corrects a session first seen from a subdirectory', async (t) => {
  const directory = await temporaryDirectory(t);
  await hook(directory, 'pre_tool_use', { session_id: 'late', cwd: '/home/me/agent-bar/src', tool_name: 'Bash' });
  await hook(directory, 'pre_tool_use', { session_id: 'late', cwd: '/home/me/agent-bar/src', tool_name: 'Bash' }, { CLAUDE_PROJECT_DIR: '/home/me/agent-bar' });
  const [session] = (await readState(directory)).sessions;
  assert.equal(session.projectName, 'agent-bar');
});

test('an empty or relative CLAUDE_PROJECT_DIR is ignored', async (t) => {
  for (const value of ['', 'relative/agent-bar']) {
    const directory = await temporaryDirectory(t);
    await hook(directory, 'session_start', { session_id: 'odd', cwd: '/home/me/real' }, { CLAUDE_PROJECT_DIR: value });
    assert.equal((await readState(directory)).sessions[0].projectPath, '/home/me/real', JSON.stringify(value));
  }
});

// ADR 0008: Claude Code passes its own PID to hooks as CLAUDE_PID. The session
// records it with its /proc start time, so a reused PID is never mistaken for it.
test('a hook records the Claude process from CLAUDE_PID with its start token', async (t) => {
  const directory = await temporaryDirectory(t);
  const stat = await readFile(`/proc/${process.pid}/stat`, 'utf8');
  const start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  await hook(directory, 'pre_tool_use', { session_id: 'live', cwd: '/home/me/p', tool_name: 'Bash' }, { CLAUDE_PID: String(process.pid) });
  assert.deepEqual((await readState(directory)).sessions[0].agentProcess, { pid: process.pid, start });
}, );

test('no usable CLAUDE_PID records no process', async (t) => {
  for (const value of [undefined, '', 'abc', '-3', '999999999']) {
    const directory = await temporaryDirectory(t);
    await hook(directory, 'pre_tool_use', { session_id: 'none', cwd: '/home/me/p', tool_name: 'Bash' }, value === undefined ? {} : { CLAUDE_PID: value });
    assert.equal('agentProcess' in (await readState(directory)).sessions[0], false, String(value));
  }
});

// T604: the history is capped. When the next line would take events.jsonl past
// 10 MiB it becomes events.jsonl.1 (replacing an older one) and a new file
// starts, so history never uses more than about twice the cap.
const { historyRotateBytes: historyCap } = await import('../dist/src/core/state.js');

test('history below the cap is appended to in place', async (t) => {
  const directory = await temporaryDirectory(t);
  await hook(directory, 'stop', { session_id: 'a', cwd: '/home/me/p' });
  await hook(directory, 'stop', { session_id: 'a', cwd: '/home/me/p' });
  assert.equal((await readHistory(directory)).length, 2);
  await assert.rejects(stat(join(directory, 'events.jsonl.1')), { code: 'ENOENT' });
});

test('history that would pass 10 MiB moves to events.jsonl.1 and a new file starts', async (t) => {
  const directory = await temporaryDirectory(t);
  const { truncate } = await import('node:fs/promises');
  await hook(directory, 'stop', { session_id: 'a', cwd: '/home/me/p' });
  await truncate(join(directory, 'events.jsonl'), historyCap - 10);
  await writeFile(join(directory, 'events.jsonl.1'), 'older history\n');
  await hook(directory, 'pre_tool_use', { session_id: 'a', cwd: '/home/me/p', tool_name: 'Bash' });
  assert.equal((await stat(join(directory, 'events.jsonl.1'))).size, historyCap - 10, 'the full file moved, replacing the older one');
  const fresh = await readHistory(directory);
  assert.deepEqual(fresh.map((event) => event.eventType), ['pre_tool_use']);
  assert.equal((await stat(join(directory, 'events.jsonl'))).mode & 0o777, 0o600);
  assert.equal((await readState(directory)).sessions[0].status, 'running', 'state is unaffected');
});

// T605 (M6 review): rotation is housekeeping. If it fails, the event is still
// recorded and state still updates, so the top bar never stalls on history.
test('a history rotation that fails never stops capture', async (t) => {
  const directory = await temporaryDirectory(t);
  const { mkdir, truncate } = await import('node:fs/promises');
  await hook(directory, 'stop', { session_id: 'a', cwd: '/home/me/p' });
  await truncate(join(directory, 'events.jsonl'), historyCap - 10);
  await mkdir(join(directory, 'events.jsonl.1', 'blocker'), { recursive: true });
  const result = await hook(directory, 'pre_tool_use', { session_id: 'a', cwd: '/home/me/p', tool_name: 'Bash' });
  assert.deepEqual(result, { code: 0, stdout: '', stderr: '' });
  assert.equal((await readState(directory)).sessions[0].status, 'running');
  assert.ok((await stat(join(directory, 'events.jsonl'))).size > historyCap - 10, 'the event was appended to the current file');
});

test('concurrent hooks across a rotation lose no event', async (t) => {
  const directory = await temporaryDirectory(t);
  const { truncate } = await import('node:fs/promises');
  await hook(directory, 'stop', { session_id: 'seed', cwd: '/home/me/p' });
  await truncate(join(directory, 'events.jsonl'), historyCap - 2000);
  const results = await Promise.all(Array.from({ length: 16 }, (_, index) => hook(directory, 'pre_tool_use', {
    session_id: `parallel-${index}`, cwd: `/tmp/project-${index}`, tool_name: 'Bash',
  })));
  for (const result of results) assert.equal(result.code, 0);
  const lines = (await readFile(join(directory, 'events.jsonl'), 'utf8')).trim().split('\n')
    .concat((await readFile(join(directory, 'events.jsonl.1'), 'latin1')).split('\n'))
    // truncate() pads with NUL bytes, which the first appended line follows.
    .map((line) => line.replace(/^\0+/, ''))
    .filter((line) => line.startsWith('{'));
  const ids = new Set(lines.map((line) => JSON.parse(line).sessionId));
  for (let index = 0; index < 16; index += 1) assert.ok(ids.has(`parallel-${index}`), `parallel-${index}`);
  assert.equal((await readState(directory)).sessions.length, 17);
  assert.ok((await stat(join(directory, 'events.jsonl'))).size < historyCap, 'rotation happened once and the new file is small');
});
