import { eventTypes, isRecord, type EventType, type JsonObject } from '../core/events.js';

// Official Claude Code hook names → AgentBar normalized event arguments.
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

export type ClaudeHookName = keyof typeof hookEvents;

function handlerFor(command: string, event: EventType) {
  return { type: 'command', command: `${command} --event ${event}`, timeout: 30 };
}

// Exact shape of a generated command: '<node>' '<...>/hooks/claude-hook.js' --event <event>.
// Any install path matches; a user's own script that merely mentions agentbar does not.
const quotedChars = "(?:[^']|'\\\\'')*";
const ownedCommand = new RegExp(
  `^'(${quotedChars})' '(${quotedChars}/hooks/claude-hook\\.js)' --event (?:${eventTypes.join('|')})$`,
);

export function isAgentBarHandler(value: unknown): boolean {
  return isRecord(value) && value.type === 'command' && typeof value.command === 'string' && ownedCommand.test(value.command);
}

// The node executable and receiver script an AgentBar handler will run.
export function ownedPaths(command: string): { node: string; receiver: string } | undefined {
  const match = ownedCommand.exec(command);
  if (!match) return undefined;
  const unquote = (value: string) => value.replaceAll("'\\''", "'");
  return { node: unquote(match[1] ?? ''), receiver: unquote(match[2] ?? '') };
}

function agentBarHandlers(groups: unknown[]): JsonObject[] {
  return groups.flatMap((group) => (isRecord(group) && Array.isArray(group.hooks) ? group.hooks.filter(isAgentBarHandler) : [])) as JsonObject[];
}

export type MergeResult =
  | { ok: true; settings: JsonObject; changed: boolean; summary: string[] }
  | { ok: false; message: string };

function validationError(settings: unknown): string | undefined {
  if (!isRecord(settings)) return 'Settings must be a JSON object.';
  if (!('hooks' in settings)) return undefined;
  if (!isRecord(settings.hooks)) return 'Settings "hooks" must be an object keyed by Claude hook event name.';
  for (const [name, groups] of Object.entries(settings.hooks)) {
    if (!Array.isArray(groups)) return `Settings "hooks.${name}" must be an array of matcher groups.`;
    for (const group of groups) {
      if (!isRecord(group)) return `Settings "hooks.${name}" contains a non-object matcher group.`;
      if ('hooks' in group && !Array.isArray(group.hooks)) return `Settings "hooks.${name}" has a matcher group whose "hooks" is not an array.`;
    }
  }
  return undefined;
}

export function installHooks(settings: unknown, command: string): MergeResult {
  const problem = validationError(settings);
  if (problem) return { ok: false, message: problem };
  const next = structuredClone(settings) as JsonObject;
  const hooks = (next.hooks ?? {}) as JsonObject;
  const summary: string[] = [];
  let changed = false;
  for (const [name, event] of Object.entries(hookEvents) as [ClaudeHookName, EventType][]) {
    const groups = (hooks[name] ?? []) as JsonObject[];
    const wanted = handlerFor(command, event);
    const existing = agentBarHandlers(groups);
    if (existing.length) {
      const stale = existing.filter((handler) => handler.command !== wanted.command);
      if (!stale.length) {
        summary.push(`${name}: AgentBar handler already present`);
        continue;
      }
      // A moved checkout or upgraded Node leaves handlers pointing at a dead receiver.
      for (const handler of stale) handler.command = wanted.command;
      summary.push(`${name}: replace stale AgentBar handler`);
      changed = true;
      continue;
    }
    groups.push({ hooks: [wanted] });
    hooks[name] = groups;
    summary.push(`${name}: add AgentBar handler`);
    changed = true;
  }
  if (changed) next.hooks = hooks;
  return { ok: true, settings: next, changed, summary };
}

export function uninstallHooks(settings: unknown): MergeResult {
  const problem = validationError(settings);
  if (problem) return { ok: false, message: problem };
  const next = structuredClone(settings) as JsonObject;
  const hooks = next.hooks as JsonObject | undefined;
  const summary: string[] = [];
  let changed = false;
  if (!hooks) return { ok: true, settings: next, changed, summary: ['hooks: none configured, nothing to remove'] };
  for (const name of Object.keys(hooks)) {
    const groups = hooks[name] as JsonObject[];
    let removed = 0;
    const kept = groups.filter((group) => {
      const handlers = (group.hooks ?? []) as unknown[];
      const remaining = handlers.filter((handler) => !isAgentBarHandler(handler));
      removed += handlers.length - remaining.length;
      if (remaining.length === handlers.length) return true;
      if (remaining.length === 0) return false;
      group.hooks = remaining as JsonObject[];
      return true;
    });
    if (removed === 0) continue;
    changed = true;
    summary.push(`${name}: remove ${removed} AgentBar handler${removed === 1 ? '' : 's'}`);
    if (kept.length === 0) delete hooks[name];
    else hooks[name] = kept;
  }
  if (changed && Object.keys(hooks).length === 0) delete next.hooks;
  return { ok: true, settings: next, changed, summary };
}
