import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const cli = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url));

async function temporaryHome(t) {
  const home = await mkdtemp(join(tmpdir(), 'agentbar-doctor-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

function run(home, args, { input = '', command = process.execPath, extraEnv = {} } = {}) {
  const env = { ...process.env, HOME: home, ...extraEnv };
  delete env.AGENTBAR_STATE_DIR;
  delete env.CLAUDE_CONFIG_DIR;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (data) => { stdout += data; });
    child.stderr.setEncoding('utf8').on('data', (data) => { stderr += data; });
    child.on('error', reject);
    child.stdin.on('error', (error) => { if (error.code !== 'EPIPE') reject(error); });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

async function tree(root) {
  const out = {};
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath ?? entry.path, entry.name);
    out[path] = entry.isFile() ? await readFile(path, 'utf8') : 'dir';
  }
  return out;
}

test('doctor on a fresh home fails, names the failing checks, modifies nothing, and hides home paths', async (t) => {
  const home = await temporaryHome(t);
  const before = await tree(home);
  const result = await run(home, [cli, 'doctor']);
  assert.equal(result.code, 1);
  assert.deepEqual(await tree(home), before);
  assert.match(result.stdout, /^(PASS|WARN|FAIL) /m);
  assert.match(result.stdout, /FAIL +Claude hooks/);
  assert.match(result.stdout, /install-hooks --apply/);
  assert.match(result.stdout, /WARN +State snapshot/);
  assert.match(result.stdout, /PASS +Node version/);
  assert.match(result.stdout, /AgentBar version +0\.1\.0/);
  assert.match(result.stdout, /~\/\.claude\/settings\.json/);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(home.replaceAll('/', '\\/')));
  assert.match(result.stderr, /1 check failed: Claude hooks/);
});

test('activation smoke: apply hooks, run one generated handler like Claude would, doctor passes', async (t) => {
  const home = await temporaryHome(t);
  const applied = await run(home, [cli, 'install-hooks', '--apply']);
  assert.equal(applied.code, 0, applied.stderr);
  const settings = JSON.parse(await readFile(join(home, '.claude', 'settings.json'), 'utf8'));
  const handler = settings.hooks.PermissionRequest[0].hooks[0].command;
  const payload = JSON.stringify({ session_id: 'smoke-1', cwd: join(home, 'secret-project'), tool_name: 'Bash', tool_input: { command: 'rm -rf /' } });
  const captured = await run(home, ['-c', handler], { input: payload, command: '/bin/sh' });
  assert.deepEqual(captured, { code: 0, stdout: '', stderr: '' });
  const state = JSON.parse(await readFile(join(home, '.local', 'state', 'agentbar', 'state.json'), 'utf8'));
  assert.equal(state.sessions[0].status, 'permission_required');

  const before = await tree(home);
  const doctor = await run(home, [cli, 'doctor']);
  assert.equal(doctor.code, 0, doctor.stdout + doctor.stderr);
  assert.deepEqual(await tree(home), before);
  assert.match(doctor.stdout, /PASS +Claude hooks +AgentBar handlers present for all 9 events/);
  assert.match(doctor.stdout, /PASS +State snapshot +~\/\.local\/state\/agentbar\/state\.json: schema version 1, 1 session/);
  assert.match(doctor.stdout, /PASS +Claude settings +~\/\.claude\/settings\.json/);
  assert.match(doctor.stderr, /All required checks passed/);
  assert.doesNotMatch(doctor.stdout + doctor.stderr, /smoke-1|secret-project|rm -rf|tool_input|permission_required/);
});

test('doctor fails on malformed or future snapshots and partial hooks, and warns rather than crashes on missing tools', async (t) => {
  const home = await temporaryHome(t);
  const stateDir = join(home, '.local', 'state', 'agentbar');
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await mkdir(join(home, '.claude'), { recursive: true });
  await writeFile(join(stateDir, 'state.json'), '{broken');
  await writeFile(join(home, '.claude', 'settings.json'), JSON.stringify({
    hooks: { Stop: [{ hooks: [{ type: 'command', command: "'/usr/bin/node' '/opt/agentbar/dist/hooks/claude-hook.js' --event stop", timeout: 30 }] }] },
  }));
  const broken = await run(home, [cli, 'doctor'], { extraEnv: { PATH: '/nonexistent' } });
  assert.equal(broken.code, 1);
  assert.match(broken.stdout, /FAIL +State snapshot +.*not valid JSON/);
  assert.match(broken.stdout, /FAIL +Claude hooks +Missing AgentBar handlers for SessionStart, PreToolUse/);
  assert.match(broken.stdout, /WARN +GNOME Shell +gnome-shell is not installed/);
  assert.match(broken.stdout, /WARN +GNOME extensions tool +gnome-extensions is not installed/);
  assert.match(broken.stderr, /2 checks failed: State snapshot, Claude hooks/);

  await writeFile(join(stateDir, 'state.json'), JSON.stringify({ schemaVersion: 2, updatedAt: '2027-01-01T00:00:00.000Z', sessions: [] }));
  const future = await run(home, [cli, 'doctor']);
  assert.match(future.stdout, /FAIL +State snapshot +.*schema version 2.*supports version 1/);

  const noDesktop = await run(home, [cli, 'doctor'], { extraEnv: { XDG_SESSION_TYPE: '', XDG_CURRENT_DESKTOP: '' } });
  assert.match(noDesktop.stdout, /WARN +Display session/);
});
