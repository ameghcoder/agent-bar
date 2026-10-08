import { access, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { errorCode, type Check } from '../core/checks.js';
import { getPaths } from '../core/paths.js';
import { parseSnapshot } from '../core/snapshot.js';

export type { Check, CheckLevel } from '../core/checks.js';

export interface DoctorOptions {
  version: string;
  minimumNode: string;
  // Each agent's and OS folder's checks, in report order. src/cli supplies
  // them, so this runner never imports an agent or an OS folder.
  groups: (() => Promise<Check[]>)[];
}

export function redactHome(text: string): string {
  const home = homedir();
  return home ? text.replaceAll(home, '~') : text;
}

function compareVersions(actual: string, minimum: string): number {
  const a = actual.replace(/^v/, '').split('.').map(Number);
  const b = minimum.split('.').map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

async function checkStateDirectory(directory: string): Promise<Check> {
  const name = 'State directory';
  try {
    const info = await stat(directory);
    if (!info.isDirectory()) return { name, level: 'fail', detail: `${directory} exists but is not a directory.` };
    await access(directory);
    const mode = info.mode & 0o777;
    if (mode & 0o077) return { name, level: 'warn', detail: `${directory} mode is ${mode.toString(8)}; expected 700.` };
    return { name, level: 'pass', detail: directory };
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { name, level: 'warn', detail: `${directory} does not exist yet; it is created by the first captured hook event.` };
    return { name, level: 'fail', detail: `${directory} is not accessible (${errorCode(error)}).` };
  }
}

async function checkSnapshot(path: string): Promise<Check> {
  const name = 'State snapshot';
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { name, level: 'warn', detail: `${path} does not exist yet; no Claude session has been captured.` };
    return { name, level: 'fail', detail: `${path} is not readable (${errorCode(error)}).` };
  }
  const result = parseSnapshot(text);
  if (!result.ok) return { name, level: 'fail', detail: `${path}: ${result.message} Move the file aside to recover.` };
  const count = result.state.sessions.length;
  const detail = `${path}: schema version ${result.state.schemaVersion}${result.legacy ? ' (legacy file, upgraded on next write)' : ''}, ${count} session${count === 1 ? '' : 's'}, updated ${result.state.updatedAt}.`;
  return { name, level: 'pass', detail };
}

export async function runDoctor(options: DoctorOptions): Promise<Check[]> {
  const paths = getPaths();
  const nodeOk = compareVersions(process.version, options.minimumNode) >= 0;
  const checks: Check[] = [
    { name: 'AgentBar version', level: 'pass', detail: options.version },
    { name: 'Node version', level: nodeOk ? 'pass' : 'fail', detail: `${process.version}${nodeOk ? '' : ` is below the required ${options.minimumNode}`}` },
    await checkStateDirectory(paths.directory),
    await checkSnapshot(paths.state),
  ];
  for (const group of options.groups) checks.push(...await group());
  return checks;
}

export function formatReport(checks: Check[]): { stdout: string; stderr: string; failed: Check[] } {
  const width = Math.max(...checks.map((check) => check.name.length));
  const stdout = checks.map((check) => `${check.level.toUpperCase().padEnd(4)} ${check.name.padEnd(width)}  ${redactHome(check.detail)}`).join('\n');
  const failed = checks.filter((check) => check.level === 'fail');
  const warned = checks.filter((check) => check.level === 'warn').length;
  const stderr = failed.length
    ? `${failed.length} check${failed.length === 1 ? '' : 's'} failed: ${failed.map((check) => check.name).join(', ')}.`
    : `All required checks passed${warned ? ` (${warned} warning${warned === 1 ? '' : 's'})` : ''}.`;
  return { stdout, stderr, failed };
}
