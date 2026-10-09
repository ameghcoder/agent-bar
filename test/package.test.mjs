import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, readlink, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

// T501: the staged install tree the .deb is built from. Staged into a
// temporary directory, so it is exercised outside the source checkout.
const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const stageScript = join(root, 'os/linux/packaging/stage.mjs');
const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const uuid = 'agentbar@ameghcoder.github.io';

async function stage(t) {
  const directory = await mkdtemp(join(tmpdir(), 'agentbar-stage-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await run(process.execPath, [stageScript, directory], { cwd: root, env: { ...process.env, SOURCE_DATE_EPOCH: '1760000000' } });
  return directory;
}

async function tree(directory) {
  const entries = [];
  for (const name of (await readdir(directory, { recursive: true })).sort()) {
    const path = join(directory, name);
    const info = await lstat(path);
    const kind = info.isSymbolicLink() ? `-> ${await readlink(path)}` : info.isDirectory() ? 'dir' : createHash('sha256').update(await readFile(path)).digest('hex');
    entries.push(`${name} ${(info.mode & 0o7777).toString(8)} ${Math.floor(info.mtimeMs / 1000)} ${kind}`);
  }
  return entries;
}

const withoutClaude = () => {
  const { CLAUDE_PID: _pid, CLAUDE_PROJECT_DIR: _dir, AGENTBAR_STATE_DIR: _state, CLAUDE_CONFIG_DIR: _config, ...rest } = process.env;
  return rest;
};

test('the staged tree has only the intended files: no sources, maps, typings, or dev dependencies', async (t) => {
  const directory = await stage(t);
  const files = (await readdir(directory, { recursive: true })).sort();
  assert.ok(files.includes('usr/bin/agentbar') && files.includes('usr/bin/agentbar-hook'));
  assert.equal(await readlink(join(directory, 'usr/bin/agentbar')), '../lib/agentbar/dist/src/cli/index.js');
  assert.equal(await readlink(join(directory, 'usr/bin/agentbar-hook')), '../lib/agentbar/dist/agents/claude-code/hooks/claude-hook.js');
  assert.deepEqual(files.filter((file) => /\.(ts|map|tsbuildinfo)$/.test(file) && !file.endsWith('.d.ts')), []);
  assert.deepEqual(files.filter((file) => file.endsWith('.d.ts')), []);
  const modules = (await readdir(join(directory, 'usr/lib/agentbar/node_modules'))).sort();
  assert.deepEqual(modules, ['commander', 'graceful-fs', 'proper-lockfile', 'retry', 'signal-exit']);
  const extension = (await readdir(join(directory, 'usr/share/gnome-shell/extensions', uuid), { recursive: true })).sort();
  assert.deepEqual(extension, [
    'extension.js', 'lib', 'lib/focus.js', 'lib/presentation.js', 'lib/snapshot.js', 'lib/state-reader.js', 'lib/vocabulary.js',
    'metadata.json', 'stylesheet.css',
  ]);
  const metadata = JSON.parse(await readFile(join(directory, 'usr/share/gnome-shell/extensions', uuid, 'metadata.json'), 'utf8'));
  assert.equal(metadata['version-name'], version);
  for (const entry of ['usr/lib/agentbar/dist/src/cli/index.js', 'usr/lib/agentbar/dist/agents/claude-code/hooks/claude-hook.js']) {
    assert.equal((await lstat(join(directory, entry))).mode & 0o777, 0o755, entry);
  }
  assert.doesNotMatch((await tree(directory)).join('\n'), new RegExp(root.replaceAll('/', '\\/')), 'no file names the build checkout');
});

test('the staged commands work outside the checkout, and generated hooks call the staged receiver', async (t) => {
  const directory = await stage(t);
  const home = await mkdtemp(join(tmpdir(), 'agentbar-stage-home-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = { ...withoutClaude(), HOME: home, AGENTBAR_STATE_DIR: join(home, 'state'), CLAUDE_CONFIG_DIR: join(home, '.claude') };
  const bin = (name) => join(directory, 'usr/bin', name);
  const options = { cwd: tmpdir(), env };
  assert.equal((await run(bin('agentbar'), ['--version'], options)).stdout.trim(), version);
  assert.equal((await run(bin('agentbar-hook'), ['--version'], options)).stdout.trim(), version);
  assert.match((await run(bin('agentbar'), ['--help'], options)).stdout, /install-hooks/);
  const preview = await run(bin('agentbar'), ['install-hooks'], options);
  const receiver = join(directory, 'usr/lib/agentbar/dist/agents/claude-code/hooks/claude-hook.js');
  assert.ok(preview.stdout.includes(receiver), 'hook commands point at the staged receiver');
  assert.ok(!preview.stdout.includes(root), 'and never at the source checkout');
  const child = execFile(bin('agentbar-hook'), ['--event', 'stop'], options);
  child.stdin.end(JSON.stringify({ session_id: 'staged', cwd: '/home/me/project' }));
  const code = await new Promise((resolve) => child.on('close', resolve));
  assert.equal(code, 0);
  const state = JSON.parse(await readFile(join(home, 'state', 'state.json'), 'utf8'));
  assert.deepEqual(state.sessions.map((session) => [session.sessionId, session.status]), [['staged', 'completed']]);
  const doctor = await run(bin('agentbar'), ['doctor'], options).catch((error) => error);
  assert.match(doctor.stdout, /PASS AgentBar version +0\.1\.0/);
});

test('two clean stages produce identical trees: names, modes, timestamps, and content', async (t) => {
  const [first, second] = [await stage(t), await stage(t)];
  assert.deepEqual(await tree(first), await tree(second));
  const times = new Set((await tree(first)).map((line) => line.split(' ')[2]));
  assert.deepEqual([...times], ['1760000000'], 'every entry carries SOURCE_DATE_EPOCH');
});
