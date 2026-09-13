import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const cli = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url));

async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), 'agentbar-apply-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function agentbar(directory, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env: { ...process.env, AGENTBAR_STATE_DIR: directory, CLAUDE_CONFIG_DIR: join(directory, 'never-used') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (data) => { stdout += data; });
    child.stderr.setEncoding('utf8').on('data', (data) => { stderr += data; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

const unrelated = {
  permissions: { allow: ['Bash(pnpm test)'] },
  hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/home/me/bin/audit.sh' }] }] },
};

async function backups(directory) {
  return (await readdir(directory)).filter((name) => name.includes('agentbar-backup')).sort();
}

test('install preview prints the config and changes nothing on disk', async (t) => {
  const directory = await temporaryDirectory(t);
  const settings = join(directory, 'settings.json');
  const original = `${JSON.stringify(unrelated, null, 2)}\n`;
  await writeFile(settings, original);
  const result = await agentbar(directory, ['install-hooks', '--settings', settings]);
  assert.equal(result.code, 0);
  assert.match(result.stderr, /no Claude settings have been changed/);
  assert.match(result.stderr, /--apply/);
  assert.match(result.stderr, /PreToolUse: add AgentBar handler/);
  assert.doesNotMatch(result.stdout + result.stderr, /audit\.sh|pnpm test/);
  assert.equal(JSON.parse(result.stdout).hooks.Stop[0].hooks[0].command.endsWith('--event stop'), true);
  assert.equal(await readFile(settings, 'utf8'), original);
  assert.deepEqual(await backups(directory), []);
});

test('apply backs up the existing file, merges, keeps unrelated content, and is idempotent', async (t) => {
  const directory = await temporaryDirectory(t);
  const settings = join(directory, 'settings.json');
  const original = `${JSON.stringify(unrelated, null, 2)}\n`;
  await writeFile(settings, original, { mode: 0o644 });
  const first = await agentbar(directory, ['install-hooks', '--settings', settings, '--apply']);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(first.stdout, '', 'apply does not print the config');
  assert.match(first.stderr, /Backup written: .*settings\.json\.agentbar-backup-\d{8}T\d{9}Z-[0-9a-f]{8}/);
  assert.match(first.stderr, /Settings updated/);
  const [backup] = await backups(directory);
  assert.equal(await readFile(join(directory, backup), 'utf8'), original);
  assert.equal((await stat(join(directory, backup))).mode & 0o777, 0o600);
  const merged = JSON.parse(await readFile(settings, 'utf8'));
  assert.deepEqual(merged.permissions, unrelated.permissions);
  assert.deepEqual(merged.hooks.PreToolUse[0], unrelated.hooks.PreToolUse[0]);
  assert.equal(merged.hooks.PreToolUse.length, 2);
  assert.equal(Object.keys(merged.hooks).length, 9);
  assert.equal((await stat(settings)).mode & 0o777, 0o644, 'existing safe mode preserved');
  assert.deepEqual((await readdir(directory)).filter((n) => n.endsWith('.tmp')), []);

  const afterFirst = await readFile(settings, 'utf8');
  const second = await agentbar(directory, ['install-hooks', '--settings', settings, '--apply']);
  assert.equal(second.code, 0);
  assert.match(second.stderr, /Nothing to change/);
  assert.equal(await readFile(settings, 'utf8'), afterFirst);
  assert.equal((await backups(directory)).length, 1, 'no-op apply makes no second backup');
});

test('missing settings are created with restrictive modes and required parent directories', async (t) => {
  const directory = await temporaryDirectory(t);
  const settings = join(directory, 'home', '.claude', 'settings.json');
  const result = await agentbar(directory, ['install-hooks', '--settings', settings, '--apply']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /does not exist yet/);
  assert.match(result.stderr, /No backup: settings file did not exist/);
  assert.equal((await stat(settings)).mode & 0o777, 0o600);
  assert.equal((await stat(join(directory, 'home', '.claude'))).mode & 0o777, 0o700);
  assert.deepEqual(Object.keys(JSON.parse(await readFile(settings, 'utf8'))), ['hooks']);
});

test('malformed settings and failed backups leave the file byte-for-byte unchanged', async (t) => {
  const directory = await temporaryDirectory(t);
  const settings = join(directory, 'settings.json');
  for (const content of ['{bad', '[]', '{"hooks":[]}']) {
    await writeFile(settings, content);
    for (const args of [[], ['--apply']]) {
      const result = await agentbar(directory, ['install-hooks', '--settings', settings, ...args]);
      assert.equal(result.code, 1, `${content} ${args}`);
      assert.match(result.stderr, /[Nn]othing was changed/);
      assert.equal(await readFile(settings, 'utf8'), content);
    }
  }
  assert.deepEqual(await backups(directory), []);

  const original = `${JSON.stringify(unrelated)}\n`;
  await writeFile(settings, original);
  const blocker = join(directory, 'not-a-directory');
  await writeFile(blocker, 'file');
  const result = await agentbar(directory, ['install-hooks', '--settings', settings, '--apply', '--backup-dir', blocker]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Could not write backup/);
  assert.match(result.stderr, /Settings were not changed/);
  assert.equal(await readFile(settings, 'utf8'), original);
});

test('uninstall previews, then removes only AgentBar handlers with a backup, and is idempotent', async (t) => {
  const directory = await temporaryDirectory(t);
  const settings = join(directory, 'settings.json');
  await writeFile(settings, `${JSON.stringify(unrelated, null, 2)}\n`, { mode: 0o666 });
  assert.equal((await agentbar(directory, ['install-hooks', '--settings', settings, '--apply'])).code, 0);
  assert.equal((await stat(settings)).mode & 0o777, 0o644, 'group/world write bits are dropped');
  const installed = await readFile(settings, 'utf8');

  const preview = await agentbar(directory, ['uninstall-hooks', '--settings', settings]);
  assert.equal(preview.code, 0, preview.stderr);
  assert.match(preview.stderr, /Stop: remove 1 AgentBar handler/);
  assert.match(preview.stderr, /Preview only.*--apply/);
  assert.equal(await readFile(settings, 'utf8'), installed);
  assert.equal((await backups(directory)).length, 1);

  const apply = await agentbar(directory, ['uninstall-hooks', '--settings', settings, '--apply']);
  assert.equal(apply.code, 0, apply.stderr);
  assert.match(apply.stderr, /Backup written/);
  assert.equal((await backups(directory)).length, 2);
  assert.deepEqual(JSON.parse(await readFile(settings, 'utf8')), unrelated);

  const again = await agentbar(directory, ['uninstall-hooks', '--settings', settings, '--apply']);
  assert.equal(again.code, 0);
  assert.match(again.stderr, /Nothing to change/);
  assert.equal((await backups(directory)).length, 2);
});

test('help explains preview, apply, settings path, and backups for both commands', async (t) => {
  const directory = await temporaryDirectory(t);
  for (const command of ['install-hooks', 'uninstall-hooks']) {
    const help = await agentbar(directory, [command, '--help']);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /--apply/);
    assert.match(help.stdout, /--settings <path>/);
    assert.match(help.stdout, /~\/\.claude\/settings\.json/);
    assert.match(help.stdout, /--backup-dir <dir>/);
    assert.match(help.stdout, /backup/i);
  }
  const root = await agentbar(directory, ['--help']);
  assert.match(root.stdout, /install-hooks/);
  assert.match(root.stdout, /uninstall-hooks/);
});

test('apply follows a symlinked settings file: the link survives and the target is what changes', async (t) => {
  const directory = await temporaryDirectory(t);
  const dotfiles = join(directory, 'dotfiles');
  await mkdir(dotfiles);
  const target = join(dotfiles, 'settings.json');
  const original = `${JSON.stringify(unrelated, null, 2)}\n`;
  await writeFile(target, original);
  const link = join(directory, 'settings.json');
  await symlink(target, link);
  const result = await agentbar(directory, ['install-hooks', '--settings', link, '--apply']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal((await lstat(link)).isSymbolicLink(), true, 'symlink must survive');
  assert.equal(Object.keys(JSON.parse(await readFile(target, 'utf8')).hooks).length, 9, 'target received the hooks');
  assert.deepEqual(await backups(directory), [], 'backup goes next to the real file, not the link');
  const [backup] = await backups(dotfiles);
  assert.equal(await readFile(join(dotfiles, backup), 'utf8'), original);
  assert.match(result.stderr, /dotfiles\/settings\.json/);
});
