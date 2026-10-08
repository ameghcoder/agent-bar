import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const run = promisify(execFile);

test('extension metadata declares a stable UUID, the tested GNOME version, and the package version', async () => {
  const metadata = JSON.parse(await readFile(new URL('os/linux/gnome-shell/metadata.json', root), 'utf8'));
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
  await run(process.execPath, ['--check', new URL('os/linux/gnome-shell/extension.js', root).pathname]);
  const source = await readFile(new URL('os/linux/gnome-shell/extension.js', root), 'utf8');
  const imports = [...source.matchAll(/^import .* from '([^']+)';$/gm)].map((match) => match[1]);
  assert.equal(imports.length > 0, true);
  for (const specifier of imports) assert.match(specifier, /^(gi:\/\/|resource:\/\/\/org\/gnome\/shell\/|\.\/lib\/)/, specifier);
  assert.match(source, /export default class \w+ extends Extension/);
  assert.match(source, /^\s+enable\(\) \{/m);
  assert.match(source, /^\s+disable\(\) \{/m);
  assert.doesNotMatch(source, /fetch\(|Soup|Gio\.Subprocess|imports\./, 'no network, no subprocesses, no legacy imports');
});

test('the build copies the portable core modules into the extension so it can load them without dist/ or node_modules', async () => {
  for (const name of ['vocabulary.js', 'snapshot.js', 'presentation.js']) {
    const [fromDist, fromExtension] = await Promise.all([
      readFile(new URL(`dist/core/${name}`, root), 'utf8'),
      readFile(new URL(`os/linux/gnome-shell/lib/${name}`, root), 'utf8'),
    ]);
    assert.equal(fromExtension, fromDist, `os/linux/gnome-shell/lib/${name} must be an exact copy of dist/core/${name}`);
  }
});

test('the copied core modules resolve entirely inside the extension lib/ and touch nothing dangerous', async () => {
  for (const name of ['vocabulary.js', 'snapshot.js', 'presentation.js']) {
    const source = await readFile(new URL(`os/linux/gnome-shell/lib/${name}`, root), 'utf8');
    const imports = [...source.matchAll(/^import .* from '([^']+)';$/gm)].map((match) => match[1]);
    for (const specifier of imports) assert.match(specifier, /^\.\//, `${name} imports ${specifier}`);
    assert.doesNotMatch(source, /fetch\(|Soup|Gio\.Subprocess|^\s*imports\./m, name);
  }
});

test('the hand-authored state reader is valid ESM, imports only GLib/Gio and its portable siblings, and stays subprocess/network-free', async () => {
  await run(process.execPath, ['--check', new URL('os/linux/gnome-shell/lib/state-reader.js', root).pathname]);
  const source = await readFile(new URL('os/linux/gnome-shell/lib/state-reader.js', root), 'utf8');
  const imports = [...source.matchAll(/^import .* from '([^']+)';$/gm)].map((match) => match[1]);
  assert.deepEqual(new Set(imports), new Set(['gi://GLib', 'gi://Gio', './snapshot.js', './presentation.js']));
  assert.doesNotMatch(source, /fetch\(|Soup|Gio\.Subprocess|^\s*imports\./m);
  assert.match(source, /export class StateWatcher/);
  assert.match(source, /^\s+start\(\) \{/m);
  assert.match(source, /^\s+stop\(\) \{/m);
});

test('the build step never overwrites the hand-authored state reader', async () => {
  const before = await readFile(new URL('os/linux/gnome-shell/lib/state-reader.js', root), 'utf8');
  const { execFile: run2 } = await import('node:child_process');
  await new Promise((resolvePromise, rejectPromise) => {
    run2(process.execPath, [new URL('os/linux/scripts/copy-extension-lib.mjs', root).pathname], (error) => (error ? rejectPromise(error) : resolvePromise()));
  });
  assert.equal(await readFile(new URL('os/linux/gnome-shell/lib/state-reader.js', root), 'utf8'), before);
});

test('packing the extension includes its lib/, not just the three top-level files gnome-extensions defaults to', async (t) => {
  const outDir = await (await import('node:fs/promises')).mkdtemp((await import('node:os')).tmpdir() + '/agentbar-pack-');
  t.after(() => rm(outDir, { recursive: true, force: true }));
  await run('os/linux/scripts/extension-dev.sh', ['pack', outDir], { cwd: fileURLToPath(root) });
  const { stdout } = await run('unzip', ['-Z1', join(outDir, 'agentbar@ameghcoder.github.io.shell-extension.zip')]);
  const entries = stdout.trim().split('\n');
  for (const expected of ['metadata.json', 'extension.js', 'lib/vocabulary.js', 'lib/snapshot.js', 'lib/presentation.js', 'lib/state-reader.js']) {
    assert.ok(entries.includes(expected), `packed zip is missing ${expected}; entries were: ${entries.join(', ')}`);
  }
});

// T313: ease() holds global.begin_work() and compositor.disable_unredirect()
// while a transition with a duration runs (GNOME Shell 50.1 environment.js), so
// an endless pulse would keep fullscreen windows off direct scanout. The pulse
// must stay finite, must honour GNOME's reduce-motion setting, and must be
// removed by disable().
test('extension.js animation stays finite, honours reduce-motion, and is cleaned up on disable', async () => {
  const source = await readFile(new URL('os/linux/gnome-shell/extension.js', root), 'utf8');
  assert.doesNotMatch(source, /repeatCount:\s*(-1|Infinity)/, 'an endless transition would hold disable_unredirect');
  assert.match(source, /enable_animations/, 'reduce-motion must be honoured');
  assert.match(source, /inFullscreen/, 'pulses are skipped while a fullscreen window hides the panel');
  const disable = source.slice(source.indexOf('    disable() {'));
  assert.match(disable, /_stopAnimation\(\)/, 'disable() must remove the timer and transitions');
  assert.match(disable, /\.disconnect\(this\._animationsChangedId\)/, 'disable() must disconnect the settings handler');
});

test('extension.js keys the pulse on the leading session, not on the title whose time text changes', async () => {
  const source = await readFile(new URL('os/linux/gnome-shell/extension.js', root), 'utf8');
  assert.match(source, /view\.leaderId/);
  assert.doesNotMatch(source, /\$\{view\.intent\}\|\$\{view\.title\}/);
});

test('extension.js shows the health line from the view and falls back to unavailable', async () => {
  const source = await readFile(new URL('os/linux/gnome-shell/extension.js', root), 'utf8');
  assert.match(source, /_healthItem\.label\.text = view\.health/);
  assert.match(source, /_healthItem\.label\.text = 'State unavailable'/);
});
