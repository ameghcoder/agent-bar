import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

// T502: the .deb built from the staged tree (ADR 0006). Inspected with the
// same dpkg-deb a user's apt would use.
const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const builder = join(root, 'os/linux/packaging/deb/build.mjs');
const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const hasDpkg = await run('dpkg-deb', ['--version']).then(() => true, () => false);
const skip = process.platform !== 'linux' || !hasDpkg;

async function build(t) {
  const directory = await mkdtemp(join(tmpdir(), 'agentbar-deb-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await run(process.execPath, [builder, directory], {
    cwd: root, env: { ...process.env, SOURCE_DATE_EPOCH: '1760000000', DEB_MAINTAINER: 'Test Maintainer <test@example.invalid>' },
  });
  const [name] = (await readdir(directory)).filter((file) => file.endsWith('.deb'));
  return join(directory, name);
}

test('the package is named, versioned, and declares the runtime it needs', { skip }, async (t) => {
  const deb = await build(t);
  assert.ok(deb.endsWith(`agentbar_${version}_all.deb`));
  const field = async (name) => (await run('dpkg-deb', ['--field', deb, name])).stdout.trim();
  assert.equal(await field('Package'), 'agentbar');
  assert.equal(await field('Version'), version);
  assert.equal(await field('Architecture'), 'all');
  assert.equal(await field('Depends'), 'nodejs (>= 22.12)');
  assert.equal(await field('Recommends'), 'gnome-shell (>= 50~)');
  assert.equal(await field('Maintainer'), 'Test Maintainer <test@example.invalid>');
  assert.match(await field('Homepage'), /^https:\/\/github\.com\/ameghcoder\/agent-bar$/);
});

test('the package holds only system paths, owned by root, and no maintainer scripts', { skip }, async (t) => {
  const deb = await build(t);
  const contents = (await run('dpkg-deb', ['--contents', deb])).stdout.trim().split('\n');
  const paths = contents.map((line) => line.split(/\s+/).slice(5).join(' '));
  assert.ok(contents.every((line) => line.split(/\s+/)[1] === 'root/root'), 'every entry is root/root');
  assert.ok(paths.every((path) => /^\.\/(usr\/(bin|lib\/agentbar|share\/gnome-shell\/extensions\/agentbar@ameghcoder\.github\.io|share\/doc\/agentbar)(\/|$| ->)|usr\/?$|usr\/(lib|share|share\/gnome-shell|share\/gnome-shell\/extensions|share\/doc)\/$|\.\/$)/.test(path) || path === './'), paths.join('\n'));
  assert.ok(!paths.some((path) => /home|root\//.test(path)));
  assert.ok(paths.includes('./usr/share/doc/agentbar/copyright'));
  assert.ok(paths.includes('./usr/share/doc/agentbar/changelog.gz'));
  assert.ok(paths.some((path) => path.startsWith('./usr/bin/agentbar -> ../lib/agentbar/dist/src/cli/index.js')));
  const control = await mkdtemp(join(tmpdir(), 'agentbar-control-'));
  t.after(() => rm(control, { recursive: true, force: true }));
  await run('dpkg-deb', ['--control', deb, control]);
  assert.deepEqual((await readdir(control)).sort(), ['control', 'md5sums'], 'no preinst/postinst/prerm/postrm');
});

test('the copyright file names every bundled dependency and its license', { skip }, async (t) => {
  const deb = await build(t);
  const copyright = (await run('dpkg-deb', ['--fsys-tarfile', deb], { encoding: 'buffer', maxBuffer: 1 << 26 })).stdout;
  const text = copyright.toString('latin1');
  for (const [name, license] of [['commander', 'MIT'], ['proper-lockfile', 'MIT'], ['graceful-fs', 'ISC'], ['retry', 'MIT'], ['signal-exit', 'ISC']]) {
    assert.match(text, new RegExp(`Files: usr/lib/agentbar/node_modules/${name}/\\*\\nCopyright: see usr/lib/agentbar/node_modules/${name}/\\nLicense: ${license}`), name);
  }
});

test('two builds of one commit are byte-identical', { skip }, async (t) => {
  const hash = async (path) => createHash('sha256').update(await readFile(path)).digest('hex');
  assert.equal(await hash(await build(t)), await hash(await build(t)));
});

// AgentBar is MIT licensed (owner decision 2026-10-09). MIT is not in
// /usr/share/common-licenses, so the copyright file carries the full text.
test('the package states AgentBar\'s MIT license with its full text', { skip }, async (t) => {
  const deb = await build(t);
  const text = (await run('dpkg-deb', ['--fsys-tarfile', deb], { encoding: 'buffer', maxBuffer: 1 << 26 })).stdout.toString('latin1');
  // The text itself sits in the standalone MIT paragraph (DEP-5), checked below.
  assert.match(text, /Files: \*\nCopyright: 2026 Yashraj and the AgentBar contributors\nLicense: MIT\n\n/);
  assert.match(text, /\nLicense: MIT\n Permission is hereby granted, free of charge[^]* \.\n The above copyright notice/);
  assert.doesNotMatch(text, /not-yet-chosen/);
  assert.equal(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).license, 'MIT');
});

// T504 (M5 review): modes, and DEP-5 license paragraphs for the bundled code.
test('every packaged entry has the intended mode', { skip }, async (t) => {
  const deb = await build(t);
  const lines = (await run('dpkg-deb', ['--contents', deb])).stdout.trim().split('\n');
  for (const line of lines) {
    const [mode] = line.split(/\s+/);
    const path = line.split(/\s+/).slice(5).join(' ');
    const expected = mode.startsWith('d') ? 'drwxr-xr-x'
      : mode.startsWith('l') ? 'lrwxrwxrwx'
      : /dist\/(src\/cli\/index|agents\/claude-code\/hooks\/claude-hook)\.js$/.test(path) ? '-rwxr-xr-x' : '-rw-r--r--';
    assert.equal(mode, expected, path);
  }
});

test('the copyright file has a standalone paragraph for every license it names', { skip }, async (t) => {
  const deb = await build(t);
  const text = (await run('dpkg-deb', ['--fsys-tarfile', deb], { encoding: 'buffer', maxBuffer: 1 << 26 })).stdout.toString('latin1');
  assert.match(text, /\n\nLicense: ISC\n Permission to use, copy, modify, and\/or distribute this software/);
  assert.match(text, /\nLicense: MIT\n Permission is hereby granted, free of charge/);
  assert.doesNotMatch(text, /Full text in the LICENSE file/);
});
