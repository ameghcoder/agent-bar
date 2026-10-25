import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import test from 'node:test';
import {
  DEFAULT_TOP_BAR_CONTENT,
  SCHEMA_ID,
  TOP_BAR_CONTENTS,
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
  assert.deepEqual([...xml.matchAll(/<key name="([^"]+)"/g)].map((match) => match[1]), ['top-bar-content']);
});

test('metadata.json names the schema, so getSettings() finds it', async () => {
  const metadata = JSON.parse(await readFile(new URL('os/linux/gnome-shell/metadata.json', root), 'utf8'));
  assert.equal(metadata['settings-schema'], SCHEMA_ID);
  assert.equal(SCHEMA_ID, 'org.gnome.shell.extensions.agentbar');
});

test('glib-compile-schemas accepts the schema in strict mode', { skip: !hasCompiler }, async () => {
  await run('glib-compile-schemas', ['--strict', '--dry-run', new URL('os/linux/schemas/', root).pathname]);
});
