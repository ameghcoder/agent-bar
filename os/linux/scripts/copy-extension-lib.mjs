#!/usr/bin/env node
// Copies the portable, node:-free core modules built by tsc (dist/src/core) into
// os/linux/gnome-shell/lib
// so the GNOME Shell extension can import the same reader and presentation
// logic Node's tests run, with no dist/ or node_modules dependency. See
// docs/architecture.md and test/extension.test.mjs.
import { copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// This file is os/linux/scripts/, three levels below the repository root.
const root = fileURLToPath(new URL('../../../', import.meta.url));
const portableModules = ['vocabulary.js', 'snapshot.js', 'presentation.js'];

const target = join(root, 'os', 'linux', 'gnome-shell', 'lib');
await mkdir(target, { recursive: true });
await Promise.all(
  portableModules.map((name) => copyFile(join(root, 'dist', 'src', 'core', name), join(target, name))),
);
