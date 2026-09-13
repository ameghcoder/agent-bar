import { execFile } from 'node:child_process';
import { access, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { isRecord } from '../core/events.js';
import { getPaths } from '../core/paths.js';
import { parseSnapshot } from '../core/snapshot.js';
import { hookEvents, isAgentBarHandler, ownedPaths, type ClaudeHookName } from '../install/merge.js';

export type CheckLevel = 'pass' | 'warn' | 'fail';

export interface Check {
  name: string;
  level: CheckLevel;
  detail: string;
}

export interface DoctorOptions {
  version: string;
  settingsPath: string;
  minimumNode: string;
  exec?: (file: string, args: string[]) => Promise<string>;
}

const execFileAsync = promisify(execFile);

async function defaultExec(file: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(file, args, { timeout: 5000, env: process.env });
  return stdout;
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

function errorCode(error: unknown): string {
  return isRecord(error) && typeof error.code === 'string' ? error.code : 'error';
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

async function checkSettings(path: string): Promise<{ check: Check; settings?: Record<string, unknown> }> {
  const name = 'Claude settings';
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { check: { name, level: 'warn', detail: `${path} does not exist; install-hooks --apply will create it.` } };
    return { check: { name, level: 'fail', detail: `${path} is not readable (${errorCode(error)}).` } };
  }
  try {
    const value: unknown = JSON.parse(text);
    if (!isRecord(value)) return { check: { name, level: 'fail', detail: `${path} is not a JSON object.` } };
    return { check: { name, level: 'pass', detail: path }, settings: value };
  } catch {
    return { check: { name, level: 'fail', detail: `${path} is not valid JSON.` } };
  }
}

async function checkHooks(settings: Record<string, unknown> | undefined): Promise<Check> {
  const name = 'Claude hooks';
  const expected = Object.keys(hookEvents) as ClaudeHookName[];
  const handlers = new Map<ClaudeHookName, string[]>();
  for (const event of expected) {
    const groups = isRecord(settings?.hooks) ? settings.hooks[event] : undefined;
    if (!Array.isArray(groups)) continue;
    const commands = groups.flatMap((group) => (isRecord(group) && Array.isArray(group.hooks) ? group.hooks.filter(isAgentBarHandler) : []))
      .map((handler) => (handler as { command: string }).command);
    if (commands.length) handlers.set(event, commands);
  }
  if (handlers.size === 0) return { name, level: 'fail', detail: 'No AgentBar handlers found. Run: agentbar install-hooks --apply' };
  const missing = expected.filter((event) => !handlers.has(event));
  if (missing.length) return { name, level: 'fail', detail: `Missing AgentBar handlers for ${missing.join(', ')}. Run: agentbar install-hooks --apply` };
  const targets = new Set([...handlers.values()].flat().map(ownedPaths).flatMap((paths) => (paths ? [paths.node, paths.receiver] : [])));
  for (const target of targets) {
    try {
      await access(target);
    } catch {
      const what = target.endsWith('claude-hook.js') ? 'receiver' : 'node executable';
      return { name, level: 'fail', detail: `A hook's ${what} is missing (moved checkout or Node upgrade?). Run: agentbar install-hooks --apply` };
    }
  }
  return { name, level: 'pass', detail: `AgentBar handlers present for all ${expected.length} events; receiver found.` };
}

async function checkCommand(name: string, exec: DoctorOptions['exec'], file: string, args: string[], describe: (stdout: string) => string): Promise<Check> {
  try {
    const stdout = await (exec ?? defaultExec)(file, args);
    return { name, level: 'pass', detail: describe(stdout.trim()) };
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT') return { name, level: 'warn', detail: `${file} is not installed; the GNOME extension needs it.` };
    return { name, level: 'warn', detail: `${file} ${args.join(' ')} failed (${code}).` };
  }
}

function checkDisplaySession(): Check {
  const name = 'Display session';
  const type = process.env.XDG_SESSION_TYPE ?? '';
  const desktop = process.env.XDG_CURRENT_DESKTOP ?? '';
  if (!type && !desktop) return { name, level: 'warn', detail: 'No XDG_SESSION_TYPE or XDG_CURRENT_DESKTOP; not running inside a desktop session.' };
  const gnome = /gnome/i.test(desktop);
  return { name, level: gnome ? 'pass' : 'warn', detail: `${desktop || 'unknown desktop'} on ${type || 'unknown session type'}${gnome ? '' : '; AgentBar supports GNOME Shell only'}.` };
}

export async function runDoctor(options: DoctorOptions): Promise<Check[]> {
  const paths = getPaths();
  const nodeOk = compareVersions(process.version, options.minimumNode) >= 0;
  const settings = await checkSettings(options.settingsPath);
  return [
    { name: 'AgentBar version', level: 'pass', detail: options.version },
    { name: 'Node version', level: nodeOk ? 'pass' : 'fail', detail: `${process.version}${nodeOk ? '' : ` is below the required ${options.minimumNode}`}` },
    await checkStateDirectory(paths.directory),
    await checkSnapshot(paths.state),
    settings.check,
    await checkHooks(settings.settings),
    await checkCommand('GNOME Shell', options.exec, 'gnome-shell', ['--version'], (out) => out),
    checkDisplaySession(),
    await checkCommand('GNOME extensions tool', options.exec, 'gnome-extensions', ['version'], (out) => `gnome-extensions ${out}; AgentBar extension check is added with the extension build.`),
  ];
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
