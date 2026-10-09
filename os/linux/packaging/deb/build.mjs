#!/usr/bin/env node
// T502: build the .deb from the staged tree (ADR 0006).
//
//   node os/linux/packaging/deb/build.mjs <output directory>
//
// The package owns system files only and has no maintainer scripts: nothing
// runs as root at install or removal, nothing touches $HOME, Claude settings,
// or user state, and enabling the extension stays a user step. Maintainer is
// $DEB_MAINTAINER, else the builder's git identity; it is never committed.
// Timestamps come from SOURCE_DATE_EPOCH (else the last commit), so two
// builds of one commit are byte-identical.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, lstat, lutimes, mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const out = process.argv[2];
if (!out) throw new Error('usage: build.mjs <output directory>');

const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const epoch = Number(process.env.SOURCE_DATE_EPOCH ?? git('log', '-1', '--format=%ct'));
if (!Number.isInteger(epoch) || epoch <= 0) throw new Error('SOURCE_DATE_EPOCH must be a positive integer.');
const maintainer = process.env.DEB_MAINTAINER ?? `${git('config', 'user.name')} <${git('config', 'user.email')}>`;
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const { version } = manifest;
// Only a plain floor maps onto a Debian dependency; anything else must be
// translated by hand rather than guessed.
const floor = /^>=\s*(\d+)\.(\d+)\.\d+$/.exec(manifest.engines.node);
if (!floor) throw new Error(`engines.node must be ">=X.Y.Z", not ${JSON.stringify(manifest.engines.node)}.`);
const minimumNode = `${floor[1]}.${floor[2]}`;
const shellVersion = JSON.parse(await readFile(join(root, 'os/linux/gnome-shell/metadata.json'), 'utf8'))['shell-version'][0];

// DEP-5 continuation lines: indented by one space, blank lines as " .".
const indent = (text) => text.split('\n').map((line) => (line.trim() ? ` ${line}` : ' .')).join('\n');

// The standard ISC text, as published by the bundled packages that use it.
const licenseTexts = {
  MIT: null,
  ISC: `Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.`,
};

const work = await mkdtemp(join(tmpdir(), 'agentbar-deb-'));
try {
  const tree = join(work, 'root');
  execFileSync(process.execPath, [join(root, 'os/linux/packaging/stage.mjs'), tree], {
    stdio: 'inherit', env: { ...process.env, SOURCE_DATE_EPOCH: String(epoch) },
  });

  // usr/share/doc/agentbar: machine-readable copyright and a changelog.
  const doc = join(tree, 'usr/share/doc/agentbar');
  await mkdir(doc, { recursive: true });
  const modules = join(tree, 'usr/lib/agentbar/node_modules');
  const dependencies = [];
  const licenses = new Set(['MIT']);
  for (const name of (await readdir(modules)).sort()) {
    const meta = JSON.parse(await readFile(join(modules, name, 'package.json'), 'utf8'));
    // Only licenses whose text is below may ship; a new one is a decision.
    if (!(meta.license in licenseTexts)) throw new Error(`${name} is licensed ${JSON.stringify(meta.license)}; add its text before shipping it.`);
    licenses.add(meta.license);
    dependencies.push(`Files: usr/lib/agentbar/node_modules/${name}/*\nCopyright: see usr/lib/agentbar/node_modules/${name}/\nLicense: ${meta.license}`);
  }
  // AgentBar's own license, with its full text: MIT is not one of the licenses
  // in /usr/share/common-licenses, so the copyright file must carry it.
  const licenseText = await readFile(join(root, 'LICENSE'), 'utf8');
  const holder = licenseText.match(/^Copyright \(c\) (.+)$/m)?.[1];
  if (manifest.license !== 'MIT' || !holder) throw new Error('package.json must say "license": "MIT" and LICENSE must carry a copyright line.');
  const mitBody = licenseText.slice(licenseText.indexOf('Permission is hereby granted')).trimEnd();
  // DEP-5: every license named by a Files paragraph gets one standalone
  // paragraph with its text, since neither MIT nor ISC is in common-licenses.
  const standalone = [...licenses].sort().map((license) => `License: ${license}\n${indent(license === 'MIT' ? mitBody : licenseTexts[license])}`);
  await writeFile(join(doc, 'copyright'), [
    `Format: https://www.debian.org/doc/packaging-manuals/copyright-format/1.0/\nUpstream-Name: agentbar\nSource: https://github.com/ameghcoder/agent-bar`,
    `Files: *\nCopyright: ${holder}\nLicense: MIT`,
    ...dependencies,
    ...standalone,
  ].join('\n\n') + '\n');
  const date = new Date(epoch * 1000).toUTCString().replace('GMT', '+0000');
  await writeFile(join(doc, 'changelog.gz'), gzipSync(
    `agentbar (${version}) unstable; urgency=medium\n\n  * See https://github.com/ameghcoder/agent-bar/blob/main/CHANGELOG.md\n\n -- ${maintainer}  ${date}\n`, { level: 9 },
  ));

  // Manual pages, gzipped without a name or timestamp in the header.
  const man = join(tree, 'usr/share/man/man1');
  await mkdir(man, { recursive: true });
  for (const page of ['agentbar.1', 'agentbar-hook.1']) {
    await writeFile(join(man, `${page}.gz`), gzipSync(await readFile(join(root, 'os/linux/packaging/deb/man', page)), { level: 9 }));
  }

  // Lintian overrides, each with its reason in the file.
  const overrides = join(tree, 'usr/share/lintian/overrides');
  await mkdir(overrides, { recursive: true });
  await copyFile(join(root, 'os/linux/packaging/deb/lintian-overrides'), join(overrides, 'agentbar'));

  // One pass over everything added here: directories and executables 0755
  // (stage set those), other files 0644, every entry at SOURCE_DATE_EPOCH.
  for (const name of (await readdir(tree, { recursive: true })).sort().reverse()) {
    const path = join(tree, name);
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      await lutimes(path, epoch, epoch);
      continue;
    }
    await chmod(path, info.isDirectory() || (info.mode & 0o111) ? 0o755 : 0o644);
    await utimes(path, epoch, epoch);
  }

  // DEBIAN/: md5sums of regular files, and the control file.
  let kilobytes = 0;
  const sums = [];
  for (const name of (await readdir(tree, { recursive: true })).sort()) {
    const info = await lstat(join(tree, name));
    kilobytes += Math.ceil(info.size / 1024) || 1;
    if (info.isFile()) sums.push(`${createHash('md5').update(await readFile(join(tree, name))).digest('hex')}  ${name}`);
  }
  const control = join(tree, 'DEBIAN');
  await mkdir(control);
  await writeFile(join(control, 'md5sums'), `${sums.join('\n')}\n`);
  await writeFile(join(control, 'control'), [
    'Package: agentbar',
    `Version: ${version}`,
    'Architecture: all',
    `Maintainer: ${maintainer}`,
    `Installed-Size: ${kilobytes}`,
    `Depends: nodejs (>= ${minimumNode})`,
    `Recommends: gnome-shell (>= ${shellVersion}~)`,
    'Section: utils',
    'Priority: optional',
    'Homepage: https://github.com/ameghcoder/agent-bar',
    'Description: GNOME top-bar companion for Claude Code',
    ' AgentBar shows what each Claude Code session is doing - working, waiting',
    ' for you, needing permission, finished - in the GNOME Shell top bar, with',
    ' desktop notifications. All data stays on this machine.',
    ' .',
    ' After installing, each user runs "agentbar install-hooks --apply" and',
    ' enables the extension; the package changes no user settings itself.',
  ].join('\n') + '\n');
  for (const file of ['control', 'md5sums']) {
    await chmod(join(control, file), 0o644);
    await utimes(join(control, file), epoch, epoch);
  }
  await chmod(control, 0o755);
  await utimes(control, epoch, epoch);

  await mkdir(out, { recursive: true });
  const deb = join(out, `agentbar_${version}_all.deb`);
  execFileSync('dpkg-deb', ['--root-owner-group', '-Zxz', '--build', tree, deb], {
    stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, SOURCE_DATE_EPOCH: String(epoch) },
  });
  // The checksum users verify before installing (the beta is unsigned).
  const digest = createHash('sha256').update(await readFile(deb)).digest('hex');
  await writeFile(`${deb}.sha256`, `${digest}  agentbar_${version}_all.deb\n`);
  console.log(deb);
} finally {
  await rm(work, { recursive: true, force: true });
}
