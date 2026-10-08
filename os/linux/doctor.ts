import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { errorCode, type Check } from '../../src/core/checks.js';

// GNOME on Linux doctor checks (ADR 0007): the Shell, the session, and the
// extensions tool the extension depends on.

export type Exec = (file: string, args: string[]) => Promise<string>;

const execFileAsync = promisify(execFile);

async function defaultExec(file: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(file, args, { timeout: 5000, env: process.env });
  return stdout;
}

async function checkCommand(name: string, exec: Exec | undefined, file: string, args: string[], describe: (stdout: string) => string): Promise<Check> {
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

export async function linuxChecks(exec?: Exec): Promise<Check[]> {
  return [
    await checkCommand('GNOME Shell', exec, 'gnome-shell', ['--version'], (out) => out),
    checkDisplaySession(),
    await checkCommand('GNOME extensions tool', exec, 'gnome-extensions', ['version'], (out) => `gnome-extensions ${out}; AgentBar extension check is added with the extension build.`),
  ];
}
