import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { installHooks } from '../install/merge.js';

export { hookEvents } from '../install/merge.js';

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function createHooksConfig(command: string) {
  const result = installHooks({}, command);
  if (!result.ok) throw new Error(result.message);
  return result.settings;
}

export async function printHooksConfig(): Promise<void> {
  const receiver = fileURLToPath(new URL('../hooks/claude-hook.js', import.meta.url));
  await access(receiver);
  const command = `${shellQuote(process.execPath)} ${shellQuote(receiver)}`;
  console.error('AgentBar config only: no Claude settings have been changed.');
  console.error('Merge these entries into the hooks object in ~/.claude/settings.json (all projects) or .claude/settings.local.json (one project).');
  console.error('Append to existing event arrays; preserve other hooks and settings. Restart Claude Code after merging.');
  console.log(JSON.stringify(createHooksConfig(command), null, 2));
}
