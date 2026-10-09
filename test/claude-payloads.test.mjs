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
