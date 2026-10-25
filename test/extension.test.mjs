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
      readFile(new URL(`dist/src/core/${name}`, root), 'utf8'),
      readFile(new URL(`os/linux/gnome-shell/lib/${name}`, root), 'utf8'),
    ]);
    assert.equal(fromExtension, fromDist, `os/linux/gnome-shell/lib/${name} must be an exact copy of dist/src/core/${name}`);
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
  for (const expected of ['metadata.json', 'extension.js', 'prefs.js', 'lib/vocabulary.js', 'lib/snapshot.js', 'lib/presentation.js', 'lib/state-reader.js', 'lib/settings.js', 'lib/upgrade.js', 'schemas/org.gnome.shell.extensions.agentbar.gschema.xml']) {
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

// T403: a row brings a window forward only through the never-guess matcher,
// recomputed at click time, and a window title is never logged.
test('extension.js focuses a session window only via pickWindow, rechecked on click, and never logs titles', async () => {
  const source = await readFile(new URL('os/linux/gnome-shell/extension.js', root), 'utf8');
  const focus = source.slice(source.indexOf('    _focusSession(sessionId) {'), source.indexOf('    disable() {'));
  assert.match(focus, /this\._focusTarget\(sessionId\)/);
  assert.match(focus, /Main\.activateWindow\(window\)/);
  assert.equal((source.match(/Main\.activateWindow/g) ?? []).length, 1, 'activateWindow has one caller');
  assert.match(source, /pickWindow\(ancestorsOf\(agent\.pid, readProcStat\), windows, projectName\)/);
  assert.doesNotMatch(source, /console\.log\([^)]*title/i);
});

// T901: the settings window. prefs.js runs in the Extensions app's process,
// not in GNOME Shell, and must stay as contained as extension.js.
test('prefs.js is valid ESM that builds the window from Adwaita and the shared settings choices', async () => {
  const path = new URL('os/linux/gnome-shell/prefs.js', root).pathname;
  await run(process.execPath, ['--check', path]);
  const source = await readFile(path, 'utf8');
  const imports = [...source.matchAll(/^import .* from '([^']+)';$/gm)].map((match) => match[1]);
  for (const specifier of imports) assert.match(specifier, /^(gi:\/\/|resource:\/\/\/org\/gnome\/Shell\/Extensions\/js\/extensions\/prefs\.js$|\.\/lib\/settings\.js$)/, specifier);
  assert.match(source, /export default class \w+ extends ExtensionPreferences/);
  assert.match(source, /fillPreferencesWindow\(window\)/);
  assert.match(source, /TOP_BAR_CONTENTS/, 'the choices come from lib/settings.js, not a second copy');
  assert.doesNotMatch(source, /fetch\(|Soup|Gio\.Subprocess|imports\./, 'no network, no subprocesses, no legacy imports');
});

test('prefs.js shows a readable message instead of failing when the schema is missing', async () => {
  const source = await readFile(new URL('os/linux/gnome-shell/prefs.js', root), 'utf8');
  assert.match(source, /try \{\s*settings = this\.getSettings\(\);/);
});

// T901: a missing or broken schema must never stop the extension.
test('extension.js reads settings defensively, follows changes live, and lets go of them on disable', async () => {
  const source = await readFile(new URL('os/linux/gnome-shell/extension.js', root), 'utf8');
  assert.match(source, /try \{\s*this\._settings = this\.getSettings\(\);/);
  assert.match(source, /topBarContentFrom\(this\._settings\)/);
  assert.match(source, /'changed::top-bar-content'/);
  const disable = source.slice(source.indexOf('    disable() {'));
  assert.match(disable, /this\._settings\.disconnect\(this\._settingsChangedId\)/);
  assert.match(disable, /this\._settings = null/);
});

test('the AgentBar menu opens the settings window', async () => {
  const source = await readFile(new URL('os/linux/gnome-shell/extension.js', root), 'utf8');
  assert.match(source, /new PopupMenu\.PopupMenuItem\('Settings'\)/);
  assert.match(source, /this\.openPreferences\(\)/);
});

// T902: with the title hidden, screen readers still hear the whole title, and
// a hidden icon never pulses.
test('extension.js keeps the full title as the accessible name and skips the pulse for a hidden icon', async () => {
  const source = await readFile(new URL('os/linux/gnome-shell/extension.js', root), 'utf8');
  assert.match(source, /this\._indicator\.accessible_name = /);
  assert.match(source, /topBarParts\(/);
  const pulse = source.slice(source.indexOf('    _pulseOnce(roundTrips) {'), source.indexOf('    _stopAnimation() {'));
  assert.match(pulse, /!this\._icon\.visible/);
});

// T903: alerts per state. The extension only turns a plan into GNOME calls:
// banners carry their sound, so Do Not Disturb silences both; a sound-only
// alert checks Do Not Disturb itself.
test('extension.js raises alerts from the per-state plan and respects Do Not Disturb for sound-only alerts', async () => {
  const source = await readFile(new URL('os/linux/gnome-shell/extension.js', root), 'utf8');
  const show = source.slice(source.indexOf('    _showNotifications(notifications) {'), source.indexOf('    _renderPlaceholder('));
  assert.match(show, /planAlerts\(notifications, status => alertChoiceFrom\(this\._settings, status\)/);
  assert.match(show, /sound: sound \? new MessageTray\.Sound\(null, sound\) : null/);
  assert.match(show, /get_sound_player\(\)\.play_from_theme\(sound,/);
  assert.match(show, /this\._doNotDisturb\(\)/);
  assert.match(source, /get_boolean\('show-banners'\)/);
});

test('prefs.js offers one alert choice per state from the shared list', async () => {
  const source = await readFile(new URL('os/linux/gnome-shell/prefs.js', root), 'utf8');
  assert.match(source, /ALERT_STATES/);
  assert.match(source, /ALERT_CHOICES/);
  assert.match(source, /title: 'Alerts'/);
});

// T905: after an upgrade, ask for a logout: a menu row and one notification,
// each with a Log Out button that opens GNOME's normal confirmation. Never
// log out unasked, and never use the network to find out.
test('extension.js watches its installed metadata and offers a logout only through a button', async () => {
  const source = await readFile(new URL('os/linux/gnome-shell/extension.js', root), 'utf8');
  assert.match(source, /needsRelogin\(this\.metadata\['version-name'\]/);
  assert.match(source, /'Log out to finish updating AgentBar'/);
  assert.match(source, /addAction\('Log Out'/);
  assert.equal((source.match(/activateLogout\(\)/g) ?? []).length, 1, 'one caller, the shared button handler');
  const logout = source.slice(source.indexOf('    _logOut() {'), source.indexOf('    _logOut() {') + 400);
  assert.match(logout, /try \{/, 'logout can be unavailable (for example in a locked-down session)');
  const disable = source.slice(source.indexOf('    disable() {'));
  assert.match(disable, /this\._metadataMonitor\?\.cancel\(\)/);
});
