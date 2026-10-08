import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// ADR 0007's dependency direction, checked on real import statements:
// src/core imports nothing outside itself; an agent imports only src/core and
// itself; an OS folder imports only src/core and itself; the doctor runner
// imports only src/core. src/cli is the one composition root and may import
// anything.
const root = fileURLToPath(new URL('../', import.meta.url));

async function sourceFiles(top) {
  const names = await readdir(join(root, top), { recursive: true });
  return names.filter((name) => /\.(ts|js|mjs)$/.test(name) && !name.endsWith('.d.ts')).map((name) => join(top, name));
}

// The zone a repository-relative path belongs to: 'src/core', 'src/cli',
// 'agents/<name>', 'os/<name>', or 'contract'.
function zone(path) {
  const [top, second] = path.split('/');
  return top === 'contract' ? 'contract' : `${top}/${second}`;
}

const allowed = (from, to) => {
  if (from === 'src/cli') return true;
  if (from === 'src/core') return to === 'src/core';
  if (from === 'src/doctor') return to === 'src/doctor' || to === 'src/core';
  if (from.startsWith('agents/') || from.startsWith('os/')) return to === from || to === 'src/core' || to === 'contract';
  return true;
};

async function violations(files) {
  const found = [];
  for (const file of files) {
    const source = await readFile(join(root, file), 'utf8');
    for (const [, specifier] of source.matchAll(/(?:from|import)\s*\(?\s*'(\.{1,2}\/[^']+)'/g)) {
      const target = relative(root, resolve(root, dirname(file), specifier));
      if (!allowed(zone(file), zone(target))) found.push(`${file} -> ${target}`);
    }
  }
  return found;
}

test('imports follow the dependency direction in ADR 0007', async () => {
  const files = [...await sourceFiles('src'), ...await sourceFiles('agents'), ...await sourceFiles('os')];
  assert.ok(files.length > 10);
  assert.deepEqual(await violations(files), []);
});

test('the dependency check catches an agent importing an OS folder and core importing an agent', async (t) => {
  const { rm, writeFile } = await import('node:fs/promises');
  const probes = { 'agents/claude-code/.probe.ts': '../../os/linux/doctor.js', 'src/core/.probe.ts': '../../agents/claude-code/translate.js' };
  t.after(() => Promise.all(Object.keys(probes).map((file) => rm(join(root, file), { force: true }))));
  for (const [file, specifier] of Object.entries(probes)) await writeFile(join(root, file), `import { x } from '${specifier}';\n`);
  assert.deepEqual(await violations(Object.keys(probes)), [
    'agents/claude-code/.probe.ts -> os/linux/doctor.js',
    'src/core/.probe.ts -> agents/claude-code/translate.js',
  ]);
});
