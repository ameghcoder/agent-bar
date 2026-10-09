#!/usr/bin/env node
// T501: stage the installed file tree that every Linux package is built from.
//
//   node os/linux/packaging/stage.mjs <empty output directory>
//
// The tree mirrors the target filesystem (ADR 0006):
//   usr/bin/agentbar, usr/bin/agentbar-hook      symlinks into usr/lib/agentbar
//   usr/lib/agentbar/                            compiled JS, a minimal package.json,
//                                                and only the runtime dependencies
//   usr/share/gnome-shell/extensions/<uuid>/     the GNOME Shell extension
//
// It compiles into a private temporary directory, never the checkout's dist/,
// which a developer's live Claude hooks may be running from. Dependencies are
// copied from the lockfile-installed node_modules, so staging needs no network
// and no bundler. Every entry gets fixed modes and SOURCE_DATE_EPOCH (else the
// last commit's time), so two stages of one commit are byte-identical.
import { execFileSync } from 'node:child_process';
import { chmod, cp, lstat, lutimes, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const out = process.argv[2];
if (!out) throw new Error('usage: stage.mjs <empty output directory>');
if ((await readdir(out).catch(() => [])).length > 0) throw new Error(`${out} is not empty; refusing to stage over it.`);

const epoch = Number(process.env.SOURCE_DATE_EPOCH
  ?? execFileSync('git', ['log', '-1', '--format=%ct'], { cwd: root, encoding: 'utf8' }).trim());
if (!Number.isInteger(epoch) || epoch <= 0) throw new Error('SOURCE_DATE_EPOCH must be a positive integer.');

const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const extensionSource = join(root, 'os/linux/gnome-shell');
const { uuid } = JSON.parse(await readFile(join(extensionSource, 'metadata.json'), 'utf8'));
const lib = join(out, 'usr/lib/agentbar');
const extension = join(out, 'usr/share/gnome-shell/extensions', uuid);
const entries = ['dist/src/cli/index.js', 'dist/agents/claude-code/hooks/claude-hook.js'];

// 1. Compile into a private directory.
const work = await mkdtemp(join(tmpdir(), 'agentbar-build-'));
try {
  execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', join(root, 'tsconfig.json'), '--outDir', join(work, 'dist')], { stdio: 'inherit' });

  // 2. The runtime: compiled JS and a package.json that only states what Node needs.
  await mkdir(lib, { recursive: true });
  for (const part of ['src', 'agents', 'os']) await cp(join(work, 'dist', part), join(lib, 'dist', part), { recursive: true });
  // The installed commands name the packaged system Node. `#!/usr/bin/env
  // node` would run whatever node is first on PATH (nvm, volta), and the hook
  // installer writes that Node's path into the user's Claude settings, where
  // it breaks once that Node is removed.
  for (const entry of entries) {
    const path = join(lib, entry);
    const text = await readFile(path, 'utf8');
    if (!text.startsWith('#!/usr/bin/env node\n')) throw new Error(`${entry} does not start with the expected shebang.`);
    await writeFile(path, `#!/usr/bin/node\n${text.slice('#!/usr/bin/env node\n'.length)}`);
  }
  await writeFile(join(lib, 'package.json'), `${JSON.stringify({
    name: manifest.name, version: manifest.version, private: true, type: 'module', dependencies: manifest.dependencies,
  }, null, 2)}\n`);

  // 3. Runtime dependencies only, flattened. Two versions of one name would
  //    need nesting; fail loudly instead of shipping the wrong one.
  // `<name>/package.json` is often not exported, so search Node's own lookup
  // directories for the package folder instead of resolving through exports.
  async function packageDirectory(require, name) {
    for (const base of require.resolve.paths(name) ?? []) {
      const candidate = join(base, name);
      if (await lstat(join(candidate, 'package.json')).then(() => true, () => false)) return realpath(candidate);
    }
    throw new Error(`Cannot find runtime dependency ${name}; run pnpm install.`);
  }

  const copied = new Map();
  async function copyDependencies(fromDirectory, dependencies) {
    const require = createRequire(join(fromDirectory, 'package.json'));
    for (const name of Object.keys(dependencies ?? {})) {
      const directory = await packageDirectory(require, name);
      const meta = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
      if (copied.has(name)) {
        if (copied.get(name) !== meta.version) throw new Error(`Two versions of ${name} (${copied.get(name)}, ${meta.version}); flat staging cannot ship both.`);
        continue;
      }
      copied.set(name, meta.version);
      await cp(directory, join(lib, 'node_modules', name), {
        recursive: true,
        dereference: true,
        // Nested node_modules are handled by the recursion. Typings, source
        // maps, dotfiles (.npmignore, ...), Markdown docs and images are not
        // needed at runtime; license files stay with the code they cover.
        filter: (path) => {
          const parts = relative(directory, path).split('/');
          return !parts.includes('node_modules') && !parts.some((part) => part.startsWith('.'))
            && !/\.(d\.ts|map|md|gif|png|jpe?g|svg)$/i.test(path) && parts[0] !== 'typings';
        },
      });
      await copyDependencies(directory, meta.dependencies);
    }
  }
  await copyDependencies(root, manifest.dependencies);

  // 4. Commands on PATH, as relative symlinks so the tree can be relocated.
  await mkdir(join(out, 'usr/bin'), { recursive: true });
  await symlink(`../lib/agentbar/${entries[0]}`, join(out, 'usr/bin/agentbar'));
  await symlink(`../lib/agentbar/${entries[1]}`, join(out, 'usr/bin/agentbar-hook'));

  // 5. The extension: hand-written files from the checkout, the portable core
  //    modules from this build (not from the checkout's generated lib/).
  await mkdir(join(extension, 'lib'), { recursive: true });
  for (const file of ['extension.js', 'metadata.json', 'stylesheet.css', 'lib/focus.js', 'lib/state-reader.js']) {
    await cp(join(extensionSource, file), join(extension, file));
  }
  for (const file of ['vocabulary.js', 'snapshot.js', 'presentation.js']) {
    await cp(join(work, 'dist/src/core', file), join(extension, 'lib', file));
  }
} finally {
  await rm(work, { recursive: true, force: true });
}

// 6. Fixed modes and timestamps, deepest entries first so a directory's own
//    time is set after its children.
const names = (await readdir(out, { recursive: true })).sort().reverse();
for (const name of names) {
  const path = join(out, name);
  const info = await lstat(path);
  if (info.isSymbolicLink()) {
    await lutimes(path, epoch, epoch);
    continue;
  }
  await chmod(path, info.isDirectory() || entries.some((entry) => name === `usr/lib/agentbar/${entry}`) ? 0o755 : 0o644);
  await utimes(path, epoch, epoch);
}
await chmod(out, 0o755);
await utimes(out, epoch, epoch);
