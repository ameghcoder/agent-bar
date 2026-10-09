import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { claudeCodeCapture, normalizeEvent } from '../dist/agents/claude-code/translate.js';

// T401: sanitized real payloads, one per hook kind Claude Code 2.1.295 sent
// in a live session. They pin the adapter against the real shape, including
// fields the synthetic fixtures never had (effort, prompt_id, permission_mode,
// last_assistant_message, ...).
const fixtures = JSON.parse(await readFile(new URL('../agents/claude-code/fixtures/payloads-2.1.295.json', import.meta.url), 'utf8'));

test('every real Claude Code hook payload maps to its observed status', () => {
  assert.ok(fixtures.cases.length >= 11);
  for (const { name, eventType, payload, expected } of fixtures.cases) {
    const event = normalizeEvent(eventType, payload, {});
    assert.equal(event.status, expected.status, name);
    assert.equal(event.projectName, 'project', name);
    if (expected.afterActivePrevious) {
      const previous = { status: expected.afterActivePrevious, lastMessage: 'before compaction' };
      assert.equal(claudeCodeCapture(eventType, payload).reconcile(event, previous).status, expected.afterActivePrevious, name);
    }
  }
});

test('the committed payloads hold no personal data', async () => {
  const text = await readFile(new URL('../agents/claude-code/fixtures/payloads-2.1.295.json', import.meta.url), 'utf8');
  assert.doesNotMatch(text, /\/home\/(?!me\/)|Documents|@[a-z]+\.[a-z]/);
  for (const { payload } of fixtures.cases) {
    for (const field of ['tool_input', 'tool_response']) if (field in payload) assert.deepEqual(payload[field], {}, field);
    if ('last_assistant_message' in payload) assert.equal(payload.last_assistant_message, 'redacted');
  }
});

// Decided by the owner after the T401 live run (2026-10-09): a failed tool
// call is routine - Claude reads the error and carries on - so it stays
// running and raises no "Failed" banner. Only a failed turn (StopFailure) is
// failed. A question from Claude (AskUserQuestion arrives as a permission
// request) waits for an answer; it is not a permission prompt.
test('a failed tool call keeps the session running; only a failed turn is failed', () => {
  const tool = normalizeEvent('error', { hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', error: 'Exit code 1', cwd: '/home/me/project' }, {});
  assert.deepEqual([tool.status, tool.message], ['running', 'Exit code 1'], 'the error detail is kept, only the status differs');
  const bare = normalizeEvent('error', { hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', cwd: '/home/me/project' }, {});
  assert.deepEqual([bare.status, bare.message], ['running', 'Tool failed: Bash']);
  const turn = normalizeEvent('error', { hook_event_name: 'StopFailure', error: 'API Error: overloaded', cwd: '/home/me/project' }, {});
  assert.deepEqual([turn.status, turn.message], ['failed', 'API Error: overloaded']);
  const unnamed = normalizeEvent('error', { error: 'boom', cwd: '/home/me/project' }, {});
  assert.equal(unnamed.status, 'failed', 'an error with no hook name keeps the old meaning');
});

test('a question from Claude waits for an answer instead of asking permission', () => {
  const question = normalizeEvent('permission_request', { hook_event_name: 'PermissionRequest', tool_name: 'AskUserQuestion', cwd: '/home/me/project' }, {});
  assert.deepEqual([question.status, question.message], ['waiting', 'Claude is asking you a question']);
  const permission = normalizeEvent('permission_request', { hook_event_name: 'PermissionRequest', tool_name: 'Bash', cwd: '/home/me/project' }, {});
  assert.equal(permission.status, 'permission_required');
});
