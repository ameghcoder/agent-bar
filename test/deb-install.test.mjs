import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

// T503, automated part: the real .deb installed, upgraded, and removed by the
// real dpkg into a throwaway root (no sudo), with a throwaway home holding
// Claude settings and AgentBar state. The release check on a real system
// with apt and a live Claude session is recorded separately.
const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const hasDpkg = await run('dpkg', ['--version']).then(() => true, () => false);
const exists = (path) => access(path).then(() => true, () => false);

test('install, activate, upgrade, uninstall hooks, remove, and reinstall keep user data intact', { skip: process.platform !== 'linux' || !hasDpkg }, async (t) => {
  const work = await mkdtemp(join(tmpdir(), 'agentbar-dpkg-'));
  t.after(() => rm(work, { recursive: true, force: true }));
  const env = { ...process.env, SOURCE_DATE_EPOCH: '1760000000', DEB_MAINTAINER: 'Test <test@example.invalid>' };
  await run(process.execPath, [join(root, 'os/linux/packaging/deb/build.mjs'), join(work, 'v1')], { env });
  const [v1] = (await readdir(join(work, 'v1'))).map((name) => join(work, 'v1', name));

  // An upgrade candidate: the same package re-versioned, as a later release would be.
  const raw = join(work, 'raw');
  await run('dpkg-deb', ['-R', v1, raw]);
  const control = join(raw, 'DEBIAN/control');
  await writeFile(control, (await readFile(control, 'utf8')).replace(/^Version: .*$/m, 'Version: 0.1.1'));
  const v2 = join(work, 'agentbar_0.1.1_all.deb');
  await run('dpkg-deb', ['--root-owner-group', '--build', raw, v2]);

  const fakeRoot = join(work, 'root');
  await mkdir(join(fakeRoot, 'var/lib/dpkg/updates'), { recursive: true });
  await mkdir(join(fakeRoot, 'var/lib/dpkg/info'), { recursive: true });
  await writeFile(join(fakeRoot, 'var/lib/dpkg/status'), '');
  // nodejs is not registered in the throwaway database; the dependency itself is checked in deb.test.mjs.
  const dpkg = (...args) => run('dpkg', ['--force-not-root', '--force-depends', `--root=${fakeRoot}`, `--admindir=${fakeRoot}/var/lib/dpkg`, '--log=/dev/null', ...args]);

  const home = join(work, 'home');
  const claude = join(home, '.claude');
  await mkdir(claude, { recursive: true });
  const settingsPath = join(claude, 'settings.json');
  const original = `${JSON.stringify({ theme: 'dark', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'notify-send done' }] }] } }, null, 2)}\n`;
  await writeFile(settingsPath, original);
  const { CLAUDE_PID: _pid, CLAUDE_PROJECT_DIR: _dir, ...inherited } = process.env;
  const userEnv = { ...inherited, HOME: home, CLAUDE_CONFIG_DIR: claude, AGENTBAR_STATE_DIR: join(home, 'state') };
  // Through this Node: the installed shebang names /usr/bin/node, which this machine may not have.
  const agentbar = (...args) => run(process.execPath, [join(fakeRoot, 'usr/bin/agentbar'), ...args], { cwd: home, env: userEnv }).catch((error) => error);

  // Clean install; doctor before activation names the remaining user step.
  await dpkg('-i', v1);
  const before = await agentbar('doctor');
  assert.match(before.stdout, /FAIL Claude hooks .*install-hooks --apply/);

  // Activate as the user, then capture one event through the installed receiver.
  await agentbar('install-hooks', '--apply');
  const settings = await readFile(settingsPath, 'utf8');
  const receiver = join(fakeRoot, 'usr/lib/agentbar/dist/agents/claude-code/hooks/claude-hook.js');
  assert.ok(settings.includes(receiver), 'hooks call the installed receiver');
  assert.ok(settings.includes('notify-send done'), 'the user\'s own hook is kept');
  const hook = execFile(process.execPath, [join(fakeRoot, 'usr/bin/agentbar-hook'), '--event', 'stop'], { env: userEnv });
  hook.stdin.end(JSON.stringify({ session_id: 'packaged', cwd: '/home/me/project' }));
  assert.equal(await new Promise((resolve) => hook.on('close', resolve)), 0);
  const state = await readFile(join(home, 'state/state.json'), 'utf8');
  assert.match((await agentbar('doctor')).stdout, /PASS Claude hooks/);

  // Upgrade: user state and settings are untouched and hooks still resolve.
  await dpkg('-i', v2);
  assert.match((await dpkg('-s', 'agentbar')).stdout, /^Version: 0\.1\.1$/m);
  assert.equal(await readFile(join(home, 'state/state.json'), 'utf8'), state);
  assert.equal(await readFile(settingsPath, 'utf8'), settings);
  assert.match((await agentbar('doctor')).stdout, /PASS Claude hooks/);

  // Hook uninstall restores the user's own settings exactly.
  await agentbar('uninstall-hooks', '--apply');
  assert.deepEqual(JSON.parse(await readFile(settingsPath, 'utf8')), JSON.parse(original));

  // Removal deletes package files only.
  await dpkg('-r', 'agentbar');
  assert.equal(await exists(join(fakeRoot, 'usr/lib/agentbar')), false);
  assert.equal(await exists(join(fakeRoot, 'usr/bin/agentbar')), false);
  assert.equal(await exists(join(fakeRoot, 'usr/share/gnome-shell/extensions/agentbar@ameghcoder.github.io')), false);
  assert.equal(await readFile(join(home, 'state/state.json'), 'utf8'), state, 'user state survives removal');
  assert.ok((await readdir(claude)).some((name) => name.startsWith('settings.json.agentbar-backup-')), 'backups survive removal');

  // Reinstall.
  await dpkg('-i', v1);
  assert.equal((await agentbar('--version')).stdout.trim(), JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version);
});
