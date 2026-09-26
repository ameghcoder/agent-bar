#!/usr/bin/env node
// Copies the portable, node:-free core modules built by tsc into extension/lib
// so the GNOME Shell extension can import the same reader and presentation
// logic Node's tests run, with no dist/ or node_modules dependency. See
// docs/architecture.md and test/extension.test.mjs.
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const portableModules = ['vocabulary.js', 'snapshot.js', 'presentation.js'];

const target = join(root, 'extension', 'lib');
await mkdir(target, { recursive: true });
await Promise.all(
  portableModules.map((name) => copyFile(join(root, 'dist', 'core', name), join(target, name))),
);
