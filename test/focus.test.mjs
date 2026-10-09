import assert from 'node:assert/strict';
import test from 'node:test';
import { ancestorsOf, parentPid, pickWindow } from '../os/linux/gnome-shell/lib/focus.js';

// T403: click a session to bring its window forward - but never the wrong
// one. The matching is pure and imports nothing, so Node tests it directly.
const stat = (pid, ppid, name = 'proc') => `${pid} (${name}) S ${ppid} 1 1 0 -1`;

test('the parent PID is field 4, counted from the last parenthesis of the process name', () => {
  assert.equal(parentPid(stat(10, 7, 'a) b (c')), 7);
  assert.equal(parentPid('garbage'), undefined);
});

test('ancestors walk up from the process, stop at init, and survive a missing or looping entry', () => {
  const table = { 50: stat(50, 40), 40: stat(40, 30), 30: stat(30, 1) };
  assert.deepEqual(ancestorsOf(50, (pid) => table[pid]), [50, 40, 30]);
  assert.deepEqual(ancestorsOf(50, (pid) => (pid === 50 ? table[50] : undefined)), [50, 40]);
  const loop = { 5: stat(5, 6), 6: stat(6, 5) };
  assert.deepEqual(ancestorsOf(5, (pid) => loop[pid]), [5, 6]);
});

const window = (id, pid, title) => ({ id, pid, title });

test('one window owned by an ancestor is the target', () => {
  assert.equal(pickWindow([428, 300, 200], [window('term', 200, 'whatever'), window('other', 999, 'x')], 'agent-bar')?.id, 'term');
});

test('no window owned by an ancestor means no target', () => {
  assert.equal(pickWindow([428, 300], [window('other', 999, 'agent-bar')], 'agent-bar'), null);
});

test('the closest ancestor owning a window wins', () => {
  // e.g. Claude in a terminal started from VS Code: the terminal is nearer.
  const windows = [window('editor', 100, 'agent-bar - Visual Studio Code'), window('term', 200, 'shell')];
  assert.equal(pickWindow([428, 300, 200, 100], windows, 'agent-bar')?.id, 'term');
});

test('several windows of one process are told apart only by the project name in the title', () => {
  const windows = [window('a', 200, 'main.ts - agent-bar - Visual Studio Code'), window('b', 200, 'index.ts - solandra - Visual Studio Code')];
  assert.equal(pickWindow([428, 200], windows, 'agent-bar')?.id, 'a');
  assert.equal(pickWindow([428, 200], windows, 'solandra')?.id, 'b');
});

test('an ambiguous match never guesses', () => {
  const both = [window('a', 200, 'agent-bar one'), window('b', 200, 'agent-bar two')];
  assert.equal(pickWindow([428, 200], both, 'agent-bar'), null, 'two titles match');
  const none = [window('a', 200, 'Terminal'), window('b', 200, 'Terminal')];
  assert.equal(pickWindow([428, 200], none, 'agent-bar'), null, 'no title matches');
});

test('the project name matches as a whole word, so "api" is not found inside "rapid"', () => {
  const windows = [window('a', 200, 'rapid prototype'), window('b', 200, 'notes')];
  assert.equal(pickWindow([428, 200], windows, 'api'), null);
  assert.equal(pickWindow([428, 200], [window('a', 200, 'api: server'), window('b', 200, 'notes')], 'api')?.id, 'a');
});
