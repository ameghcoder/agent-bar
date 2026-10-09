import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

// T315: package.json owns AgentBar's version. The TypeScript side reads one
// constant (src/core/version.ts); the extension's metadata.json cannot import, so
// it keeps a copy that this test holds equal. A release bump that misses a
// copy fails here instead of shipping two different version strings.
const root = new URL('../', import.meta.url);
const run = promisify(execFile);
const { version } = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));

test('the extension metadata names the package version', async () => {
  const metadata = JSON.parse(await readFile(new URL('os/linux/gnome-shell/metadata.json', root), 'utf8'));
  assert.equal(metadata['version-name'], version);
});

test('both commands report the package version', async () => {
  for (const entry of ['dist/src/cli/index.js', 'dist/agents/claude-code/hooks/claude-hook.js']) {
    const { stdout } = await run(process.execPath, [fileURLToPath(new URL(entry, root)), '--version']);
    assert.equal(stdout.trim(), version, entry);
  }
});

test('src/core/version.ts is the only TypeScript file that spells the version', async () => {
  const spelling = [];
  for (const top of ['src', 'agents', 'os']) {
    const directory = fileURLToPath(new URL(`${top}/`, root));
    for (const file of (await readdir(directory, { recursive: true })).filter((name) => name.endsWith('.ts'))) {
      if ((await readFile(join(directory, file), 'utf8')).includes(`'${version}'`)) spelling.push(`${top}/${file}`);
    }
  }
  assert.deepEqual(spelling, ['src/core/version.ts']);
});

// T602: the changelog's newest entry and the release notes name this version.
test('the changelog and release notes describe the package version', async () => {
  const changelog = await readFile(new URL('CHANGELOG.md', root), 'utf8');
  assert.equal(changelog.match(/^## (\S+)/m)?.[1], version);
  const notes = await readFile(new URL(`docs/release-notes/v${version}.md`, root), 'utf8');
  assert.match(notes, new RegExp(`agentbar_${version.replaceAll('.', '\\.')}_all\\.deb`));
});
