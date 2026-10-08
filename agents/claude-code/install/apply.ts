import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { isRecord, type JsonObject } from '../../../src/core/events.js';
import { installHooks, uninstallHooks, type MergeResult } from './merge.js';

export function defaultSettingsPath(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  if (configDir && !isAbsolute(configDir)) throw new Error('CLAUDE_CONFIG_DIR must be an absolute path.');
  return join(configDir || join(homedir(), '.claude'), 'settings.json');
}

export interface ApplyOptions {
  settingsPath: string;
  backupDir?: string | undefined;
  apply: boolean;
}

export interface ApplyReport {
  settingsPath: string;
  existed: boolean;
  changed: boolean;
  applied: boolean;
  backupPath?: string;
  summary: string[];
}

async function readSettings(path: string): Promise<{ existed: boolean; text: string; value: unknown; mode: number }> {
  let text: string;
  let mode = 0o600;
  try {
    text = await readFile(path, 'utf8');
    mode = (await stat(path)).mode & 0o777;
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return { existed: false, text: '', value: {}, mode };
    throw error;
  }
  try {
    return { existed: true, text, value: JSON.parse(text) as unknown, mode };
  } catch {
    throw new Error(`Claude settings at ${path} are not valid JSON. Fix or move the file; nothing was changed.`);
  }
}

// Dotfile managers symlink settings.json; rename() over the link would replace
// the link itself, so operate on the real file.
async function resolveSettingsPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return path;
    throw error;
  }
}

async function run(options: ApplyOptions, merge: (value: unknown) => MergeResult): Promise<ApplyReport> {
  const { apply } = options;
  const settingsPath = await resolveSettingsPath(options.settingsPath);
  const current = await readSettings(settingsPath);
  const result = merge(current.value);
  if (!result.ok) throw new Error(`Claude settings at ${settingsPath}: ${result.message} Nothing was changed.`);
  const report: ApplyReport = { settingsPath, existed: current.existed, changed: result.changed, applied: false, summary: result.summary };
  if (!apply || !result.changed) return report;

  if (current.existed) report.backupPath = await writeBackup(settingsPath, current.text, options.backupDir);
  await writeAtomic(settingsPath, `${JSON.stringify(result.settings, null, 2)}\n`, current.existed ? current.mode & ~0o022 : 0o600);
  report.applied = true;
  return report;
}

async function writeBackup(settingsPath: string, text: string, backupDir: string | undefined): Promise<string> {
  const directory = backupDir ?? dirname(settingsPath);
  const stamp = new Date().toISOString().replaceAll(/[-:.]/g, '');
  const path = join(directory, `${basename(settingsPath)}.agentbar-backup-${stamp}-${randomUUID().slice(0, 8)}`);
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(path, text, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not write backup ${path}: ${reason}. Settings were not changed.`);
  }
  return path;
}

async function writeAtomic(path: string, content: string, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { flag: 'wx', mode });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export function applyInstall(options: ApplyOptions, command: string): Promise<ApplyReport> {
  return run(options, (value) => installHooks(value, command));
}

export function applyUninstall(options: ApplyOptions): Promise<ApplyReport> {
  return run(options, (value) => uninstallHooks(value));
}

export function generatedConfig(command: string): JsonObject {
  const result = installHooks({}, command);
  if (!result.ok) throw new Error(result.message);
  return result.settings;
}
