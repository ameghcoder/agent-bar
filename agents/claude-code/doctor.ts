import { access, readFile } from 'node:fs/promises';
import { errorCode, type Check } from '../../src/core/checks.js';
import { isRecord } from '../../src/core/vocabulary.js';
import { hookEvents, isAgentBarHandler, ownedPaths, type ClaudeHookName } from './install/merge.js';

// Claude Code's doctor checks (ADR 0007, diagnose): the settings file parses,
// and every AgentBar hook is present and points at files that exist.

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

export async function claudeCodeChecks(settingsPath: string): Promise<Check[]> {
  const settings = await checkSettings(settingsPath);
  return [settings.check, await checkHooks(settings.settings)];
}
