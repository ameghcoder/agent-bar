import assert from 'node:assert/strict';
import test from 'node:test';
import { SPARK_FRAME_COUNT, iconMotion, sparkAllowed, sparkFrame } from '../os/linux/gnome-shell/lib/icon-animation.js';

// T904: which motion the top-bar icon makes, decided from the view and the
// user's "Icon" choice. Pure, so Node tests every rule directly.
const view = (intent, stale = false) => ({ intent, stale, status: 'x', leaderId: 'a' });

test('with the animated spark, each state gets its own motion, and only a fresh Working session spins', () => {
  assert.equal(iconMotion(view('active'), 'spark'), 'spark');
  assert.equal(iconMotion(view('attention'), 'spark'), 'pulse');
  assert.equal(iconMotion(view('complete'), 'spark'), 'pop');
  assert.equal(iconMotion(view('error'), 'spark'), 'shake');
  assert.equal(iconMotion(view('quiet'), 'spark'), 'none');
  assert.equal(iconMotion(view('unknown'), 'spark'), 'none');
});

test('a stale session never moves, whatever the choice, so "stuck" never looks like "working"', () => {
  for (const choice of ['spark', 'pulse', 'still']) {
    for (const intent of ['active', 'attention', 'complete', 'error']) assert.equal(iconMotion(view(intent, true), choice), 'none', `${choice} ${intent}`);
  }
});

test('the simple pulse keeps 0.2.0 behaviour, and still never moves', () => {
  assert.equal(iconMotion(view('active'), 'pulse'), 'pulse');
  assert.equal(iconMotion(view('attention'), 'pulse'), 'pulse');
  assert.equal(iconMotion(view('complete'), 'pulse'), 'none');
  assert.equal(iconMotion(view('error'), 'pulse'), 'none');
  for (const intent of ['active', 'attention', 'complete', 'error']) assert.equal(iconMotion(view(intent), 'still'), 'none');
  assert.equal(iconMotion(null, 'spark'), 'none', 'no view yet');
});

test('the spark grows and shrinks back through its frames, without jumping from the last to the first', () => {
  assert.equal(SPARK_FRAME_COUNT, 6);
  const frames = Array.from({ length: 12 }, (_, tick) => sparkFrame(tick));
  assert.deepEqual(frames, [0, 1, 2, 3, 4, 5, 4, 3, 2, 1, 0, 1]);
});

test('the spark runs only while it can be seen and motion is welcome', () => {
  const visible = { animationsEnabled: true, fullscreen: false, locked: false, iconVisible: true };
  assert.equal(sparkAllowed(visible), true);
  assert.equal(sparkAllowed({ ...visible, animationsEnabled: false }), false, 'Reduce animation');
  assert.equal(sparkAllowed({ ...visible, fullscreen: true }), false, 'fullscreen window covers the panel');
  assert.equal(sparkAllowed({ ...visible, locked: true }), false, 'lock screen');
  assert.equal(sparkAllowed({ ...visible, iconVisible: false }), false, 'Text only');
});
