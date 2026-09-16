import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const run = promisify(execFile);

test('extension metadata declares a stable UUID, the tested GNOME version, and the package version', async () => {
  const metadata = JSON.parse(await readFile(new URL('extension/metadata.json', root), 'utf8'));
  const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  assert.equal(metadata.uuid, 'agentbar@ameghcoder.github.io');
  assert.match(metadata.uuid, /^[a-z0-9_-]+@[a-z0-9.-]+$/i);
  assert.equal(metadata.name, 'AgentBar');
  assert.equal(typeof metadata.description, 'string');
  assert.deepEqual(metadata['shell-version'], ['50'], 'claim only the GNOME version tested on a real machine');
  assert.equal(metadata['version-name'], pkg.version);
  assert.equal(metadata.url, 'https://github.com/ameghcoder/agent-bar');
  assert.equal('version' in metadata, false, 'integer version is assigned by extensions.gnome.org, not by us');
});

test('extension.js is valid ESM that only imports GNOME Shell resources and gi modules', async () => {
  await run(process.execPath, ['--check', new URL('extension/extension.js', root).pathname]);
  const source = await readFile(new URL('extension/extension.js', root), 'utf8');
  const imports = [...source.matchAll(/^import .* from '([^']+)';$/gm)].map((match) => match[1]);
  assert.equal(imports.length > 0, true);
  for (const specifier of imports) assert.match(specifier, /^(gi:\/\/|resource:\/\/\/org\/gnome\/shell\/)/, specifier);
  assert.match(source, /export default class \w+ extends Extension/);
  assert.match(source, /^\s+enable\(\) \{/m);
  assert.match(source, /^\s+disable\(\) \{/m);
  assert.doesNotMatch(source, /fetch\(|Soup|Gio\.Subprocess|imports\./, 'no network, no subprocesses, no legacy imports');
});
