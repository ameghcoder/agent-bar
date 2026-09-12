import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { EventType } from '../core/events.js';

export const hookEvents = {
  SessionStart: 'session_start',
  PreToolUse: 'pre_tool_use',
  PostToolUse: 'post_tool_use',
  Notification: 'notification',
  PermissionRequest: 'permission_request',
  Stop: 'stop',
  SessionEnd: 'session_end',
  PostToolUseFailure: 'error',
  StopFailure: 'error',
} satisfies Record<string, EventType>;

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function createHooksConfig(command: string) {
  return {
    hooks: Object.fromEntries(Object.entries(hookEvents).map(([name, event]) => [name, [{
      hooks: [{ type: 'command', command: `${command} --event ${event}`, timeout: 30 }],
    }]])),
  };
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
