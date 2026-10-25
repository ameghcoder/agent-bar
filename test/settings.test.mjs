import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import test from 'node:test';
import {
  ALERT_CHOICES,
  ALERT_STATES,
  DEFAULT_TOP_BAR_CONTENT,
  SCHEMA_ID,
  TOP_BAR_CONTENTS,
  alertChoiceFrom,
  planAlerts,
  testAlertRequest,
  testAlertStatus,
  topBarContentFrom,
  topBarParts,
} from '../os/linux/gnome-shell/lib/settings.js';

// T901/T902: AgentBar's settings live in one GSettings schema owned by the
// GNOME extension. The defaults and the choices are pure data, so Node tests
// them directly; the schema file must agree with them exactly.
const run = promisify(execFile);
const root = new URL('../', import.meta.url);
const schemaPath = new URL('os/linux/schemas/org.gnome.shell.extensions.agentbar.gschema.xml', root);
const hasCompiler = await run('glib-compile-schemas', ['--version']).then(() => true, () => false);

const fakeSettings = (value) => ({ get_string: (key) => (key === 'top-bar-content' ? value : undefined) });

test('the top-bar content is read from settings, and any problem falls back to icon and text', () => {
  assert.equal(DEFAULT_TOP_BAR_CONTENT, 'icon-and-text');
  for (const id of ['icon-and-text', 'icon', 'text']) assert.equal(topBarContentFrom(fakeSettings(id)), id);
  assert.equal(topBarContentFrom(null), 'icon-and-text', 'no schema installed');
  assert.equal(topBarContentFrom(fakeSettings('sideways')), 'icon-and-text', 'a value from a newer or broken schema');
  assert.equal(topBarContentFrom({ get_string: () => { throw new Error('GSettings key missing'); } }), 'icon-and-text');
});

test('each top-bar content choice says which of the icon and the title are shown', () => {
  assert.deepEqual(topBarParts('icon-and-text'), { icon: true, label: true });
  assert.deepEqual(topBarParts('icon'), { icon: true, label: false });
  assert.deepEqual(topBarParts('text'), { icon: false, label: true });
  assert.deepEqual(topBarParts('sideways'), { icon: true, label: true }, 'never hide both');
});

test('the choices are listed in the order the settings window shows them, with plain labels', () => {
  assert.deepEqual(TOP_BAR_CONTENTS.map((choice) => choice.id), ['icon-and-text', 'icon', 'text']);
  assert.deepEqual(TOP_BAR_CONTENTS.map((choice) => choice.label), ['Icon and text', 'Icon only', 'Text only']);
});

test('the schema file declares exactly the choices and default the extension uses', async () => {
  const xml = await readFile(schemaPath, 'utf8');
  assert.match(xml, new RegExp(`<schema id="${SCHEMA_ID.replaceAll('.', '\\.')}" path="/org/gnome/shell/extensions/agentbar/">`));
  const key = /<key name="top-bar-content" type="s">([\s\S]*?)<\/key>/.exec(xml)?.[1];
  assert.ok(key, 'top-bar-content key');
  assert.deepEqual([...key.matchAll(/<choice value="([^"]+)"\/>/g)].map((match) => match[1]), TOP_BAR_CONTENTS.map((choice) => choice.id));
  assert.equal(/<default>'([^']+)'<\/default>/.exec(key)?.[1], DEFAULT_TOP_BAR_CONTENT);
  // Only keys a shipped task uses (M7 rule).
  assert.deepEqual([...xml.matchAll(/<key name="([^"]+)"/g)].map((match) => match[1]),
    ['top-bar-content', ...ALERT_STATES.map((state) => state.key), 'test-alert']);
});

test('every alert key in the schema offers the shared choices and the state\'s own default', async () => {
  const xml = await readFile(schemaPath, 'utf8');
  for (const state of ALERT_STATES) {
    const key = new RegExp(`<key name="${state.key}" type="s">([\\s\\S]*?)<\\/key>`).exec(xml)?.[1];
    assert.ok(key, state.key);
    assert.deepEqual([...key.matchAll(/<choice value="([^"]+)"\/>/g)].map((match) => match[1]), ALERT_CHOICES.map((choice) => choice.id), state.key);
    assert.equal(/<default>'([^']+)'<\/default>/.exec(key)?.[1], state.default, state.key);
  }
});

test('metadata.json names the schema, so getSettings() finds it', async () => {
  const metadata = JSON.parse(await readFile(new URL('os/linux/gnome-shell/metadata.json', root), 'utf8'));
  assert.equal(metadata['settings-schema'], SCHEMA_ID);
  assert.equal(SCHEMA_ID, 'org.gnome.shell.extensions.agentbar');
});

test('glib-compile-schemas accepts the schema in strict mode', { skip: !hasCompiler }, async () => {
  await run('glib-compile-schemas', ['--strict', '--dry-run', new URL('os/linux/schemas/', root).pathname]);
});

// T903: alerts per state. One choice per notifying state decides whether its
// banner shows and whether its sound plays.
test('each notifying state has its own alert setting, label, sound, and the agreed default', () => {
  assert.deepEqual(ALERT_CHOICES.map((choice) => [choice.id, choice.label]), [
    ['banner-and-sound', 'Banner and sound'], ['banner', 'Banner only'], ['sound', 'Sound only'], ['top-bar', 'Top bar only'],
  ]);
  assert.deepEqual(ALERT_STATES.map((state) => [state.status, state.key, state.label, state.default]), [
    ['permission_required', 'alert-permission', 'Permission needed', 'banner-and-sound'],
    ['waiting', 'alert-waiting', 'Waiting for you', 'banner-and-sound'],
    ['failed', 'alert-failed', 'Failed', 'banner-and-sound'],
    ['completed', 'alert-complete', 'Turn complete', 'banner'],
  ]);
  const sounds = ALERT_STATES.map((state) => state.sound);
  assert.ok(sounds.every((sound) => /^[a-z-]+$/.test(sound)), 'sound theme names, not files');
  assert.equal(new Set(sounds).size, 4, 'every state sounds different');
});

test('the alert choice is read per state, and any problem falls back to that state\'s default', () => {
  const stored = { 'alert-permission': 'sound', 'alert-waiting': 'top-bar', 'alert-failed': 'nonsense' };
  const settings = { get_string: (key) => { if (!(key in stored)) throw new Error('missing key'); return stored[key]; } };
  assert.equal(alertChoiceFrom(settings, 'permission_required'), 'sound');
  assert.equal(alertChoiceFrom(settings, 'waiting'), 'top-bar');
  assert.equal(alertChoiceFrom(settings, 'failed'), 'banner-and-sound', 'unknown value');
  assert.equal(alertChoiceFrom(settings, 'completed'), 'banner', 'missing key');
  assert.equal(alertChoiceFrom(null, 'permission_required'), 'banner-and-sound', 'no schema');
  assert.equal(alertChoiceFrom(settings, 'some_new_status'), 'banner', 'an unknown state still shows its banner, silently');
});

const note = (sessionId, status, urgency) => ({ sessionId, status, urgency, title: status, body: sessionId, intent: 'attention' });
const choose = (choices) => (status) => choices[status] ?? 'banner-and-sound';

test('each choice turns into the right banner and sound', () => {
  const notes = [note('a', 'permission_required', 'critical')];
  const sound = ALERT_STATES[0].sound;
  for (const [choice, banner, expectedSound] of [['banner-and-sound', true, sound], ['banner', true, null], ['sound', false, sound], ['top-bar', false, null]]) {
    const { alerts } = planAlerts(notes, choose({ permission_required: choice }), { lastSoundAt: -Infinity, now: 0 });
    assert.deepEqual(alerts.map((alert) => [alert.banner, alert.sound]), [[banner, expectedSound]], choice);
  }
});

test('several alerts at once play one sound, for the most urgent, and back-to-back batches do not stack sounds', () => {
  const batch = [note('a', 'completed', 'low'), note('b', 'failed', 'high'), note('c', 'permission_required', 'critical')];
  const all = choose({ completed: 'banner-and-sound' });
  const first = planAlerts(batch, all, { lastSoundAt: -Infinity, now: 10_000 });
  assert.deepEqual(first.alerts.map((alert) => [alert.notification.sessionId, alert.banner, alert.sound]), [
    ['a', true, null], ['b', true, null], ['c', true, ALERT_STATES[0].sound],
  ]);
  assert.equal(first.lastSoundAt, 10_000);
  const soon = planAlerts([note('d', 'waiting', 'normal')], all, { lastSoundAt: first.lastSoundAt, now: 11_000 });
  assert.deepEqual(soon.alerts.map((alert) => [alert.banner, alert.sound]), [[true, null]], 'within 2 s: banner, no sound');
  assert.equal(soon.lastSoundAt, 10_000);
  const later = planAlerts([note('e', 'waiting', 'normal')], all, { lastSoundAt: first.lastSoundAt, now: 12_500 });
  assert.deepEqual(later.alerts.map((alert) => alert.sound), [ALERT_STATES[1].sound]);
});

test('a sound-only alert that is held back by the gap raises nothing at all, and top-bar-only alerts never sound', () => {
  const { alerts, lastSoundAt } = planAlerts([note('a', 'failed', 'high'), note('b', 'completed', 'low')],
    choose({ failed: 'sound', completed: 'top-bar' }), { lastSoundAt: 0, now: 500 });
  assert.deepEqual(alerts.map((alert) => [alert.banner, alert.sound]), [[false, null], [false, null]]);
  assert.equal(lastSoundAt, 0);
});

// Test buttons in the settings window: prefs.js runs in another process, so it
// asks the extension through the 'test-alert' key. Each press writes a new
// value, so pressing twice still counts.
test('a test request names one known state and changes on every press', () => {
  const first = testAlertRequest('permission_required', 1000);
  const second = testAlertRequest('permission_required', 1001);
  assert.notEqual(first, second);
  assert.equal(testAlertStatus(first), 'permission_required');
  for (const state of ALERT_STATES) assert.equal(testAlertStatus(testAlertRequest(state.status, 5)), state.status);
  assert.equal(testAlertStatus(''), null, 'the default value tests nothing');
  assert.equal(testAlertStatus('running@5'), null, 'only states that alert');
  assert.equal(testAlertStatus('garbage'), null);
  assert.equal(testAlertStatus(null), null);
});
