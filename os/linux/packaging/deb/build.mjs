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
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const out = process.argv[2];
if (!out) throw new Error('usage: build.mjs <output directory>');

const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const epoch = Number(process.env.SOURCE_DATE_EPOCH ?? git('log', '-1', '--format=%ct'));
const maintainer = process.env.DEB_MAINTAINER ?? `${git('config', 'user.name')} <${git('config', 'user.email')}>`;
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const { version } = manifest;
const minimumNode = manifest.engines.node.replace(/^>=\s*/, '').split('.').slice(0, 2).join('.');
const shellVersion = JSON.parse(await readFile(join(root, 'os/linux/gnome-shell/metadata.json'), 'utf8'))['shell-version'][0];

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
  for (const name of (await readdir(modules)).sort()) {
    const meta = JSON.parse(await readFile(join(modules, name, 'package.json'), 'utf8'));
    dependencies.push(`Files: usr/lib/agentbar/node_modules/${name}/*\nCopyright: see usr/lib/agentbar/node_modules/${name}/\nLicense: ${meta.license}\n Full text in the LICENSE file of that directory.`);
  }
  const ownLicense = manifest.license
    ? `License: ${manifest.license}\n Full text in /usr/lib/agentbar/LICENSE.`
    : 'License: LicenseRef-not-yet-chosen\n AgentBar has not chosen a license yet. This package is a release\n candidate and must not be redistributed until it has.';
  await writeFile(join(doc, 'copyright'), [
    `Format: https://www.debian.org/doc/packaging-manuals/copyright-format/1.0/\nUpstream-Name: agentbar\nSource: https://github.com/ameghcoder/agent-bar`,
    `Files: *\nCopyright: AgentBar contributors\n${ownLicense}`,
    ...dependencies,
  ].join('\n\n') + '\n');
  const date = new Date(epoch * 1000).toUTCString().replace('GMT', '+0000');
  await writeFile(join(doc, 'changelog.gz'), gzipSync(
    `agentbar (${version}) unstable; urgency=medium\n\n  * Beta release candidate.\n\n -- ${maintainer}  ${date}\n`, { level: 9 },
  ));
  for (const file of ['copyright', 'changelog.gz']) {
    await chmod(join(doc, file), 0o644);
    await utimes(join(doc, file), epoch, epoch);
  }
  for (const directory of ['usr/share/doc/agentbar', 'usr/share/doc', 'usr/share']) {
    await chmod(join(tree, directory), 0o755);
    await utimes(join(tree, directory), epoch, epoch);
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
  console.log(deb);
} finally {
  await rm(work, { recursive: true, force: true });
}
