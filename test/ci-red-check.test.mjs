import assert from 'node:assert/strict';
import test from 'node:test';

// Deliberately failing, to prove CI turns red on a broken test (#46).
// Lives only on the ci-red-check branch; never merged.
test('CI fails when a test fails', () => {
  assert.fail('deliberate failure for #46');
});
