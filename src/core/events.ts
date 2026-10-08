import { createHash, randomUUID } from 'node:crypto';
import { basename, isAbsolute, resolve } from 'node:path';
import { isRecord, type EventType, type JsonObject, type Status } from './vocabulary.js';

export { eventTypes, isEventType, isRecord, statuses, type EventType, type JsonObject, type JsonValue, type Status } from './vocabulary.js';

export interface ClaudeEvent {
  id: string;
  timestamp: string;
  source: 'claude-code';
  projectPath: string;
  projectName: string;
  sessionId: string;
  eventType: EventType;
  status: Status;
  message: string;
  raw: JsonObject;
}

export function parseInput(input: string): JsonObject {
  if (!input.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new Error('Invalid JSON on stdin. Expected one JSON object; no event was saved.');
  }
  if (!isRecord(parsed)) {
    throw new Error('Hook input must be a JSON object; no event was saved.');
  }
  return parsed as JsonObject;
}

function stringField(raw: JsonObject, key: string): string | undefined {
  const value = raw[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export const messageLimit = 120;

// Presentation string: first non-blank line, collapsed whitespace, hard cap.
export function presentable(text: string | undefined): string | undefined {
  const line = text?.split('\n').map((part) => part.replace(/\s+/g, ' ').trim()).find(Boolean);
  if (!line) return undefined;
  const points = Array.from(line);
  return points.length > messageLimit ? `${points.slice(0, messageLimit - 1).join('')}…` : line;
}

// Only Claude-authored attention events carry a user-facing message field.
const messageEvents: readonly EventType[] = ['notification', 'permission_request'];

function activity(type: EventType, raw: JsonObject): { status: Status; message: string } {
  const tool = stringField(raw, 'tool_name') ?? 'tool';
  switch (type) {
    case 'session_start': return { status: 'idle', message: 'Session started' };
    case 'pre_tool_use': return { status: 'running', message: `Preparing tool: ${tool}` };
    case 'post_tool_use': return { status: 'running', message: `Tool finished: ${tool}` };
    case 'permission_request': return { status: 'permission_required', message: `Permission requested for ${tool}` };
    case 'stop': return { status: 'completed', message: 'Claude finished responding' };
    case 'session_end': return { status: 'idle', message: `Session ended: ${stringField(raw, 'reason') ?? 'unspecified'}` };
    case 'error': return {
      status: 'failed',
      message: presentable(stringField(raw, 'error') ?? stringField(raw, 'error_details')) ?? 'Claude reported an error',
    };
    case 'notification': {
      const kind = stringField(raw, 'notification_type');
      if (kind === 'permission_prompt') return { status: 'permission_required', message: 'Claude needs permission' };
      if (kind === 'idle_prompt' || kind === 'elicitation_dialog' || kind === 'elicitation_url_dialog' || kind === 'agent_needs_input') {
        return { status: 'waiting', message: 'Claude is waiting for input' };
      }
      return { status: 'unknown', message: 'Claude notification' };
    }
  }
}

export const activeStatuses: readonly Status[] = ['running', 'waiting', 'permission_required'];

// Auto-compaction fires SessionStart mid-turn; startup, clear, and resume all
// begin at an empty prompt, so only compact may keep an active status.
export function carryActiveStatus(event: ClaudeEvent, previous: { status: Status; lastMessage: string } | undefined): ClaudeEvent {
  if (event.eventType !== 'session_start' || stringField(event.raw, 'source') !== 'compact') return event;
  if (!previous || !activeStatuses.includes(previous.status)) return event;
  return { ...event, status: previous.status, message: previous.lastMessage };
}

// Claude Code sets CLAUDE_PROJECT_DIR for hook commands to the directory the
// session was started in. The payload's `cwd` follows the shell into
// subdirectories, so it is only the fallback for naming the project.
export function projectRootFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env.CLAUDE_PROJECT_DIR;
  return value && isAbsolute(value) ? resolve(value) : undefined;
}

export function normalizeEvent(eventType: EventType, raw: JsonObject): ClaudeEvent {
  const projectPath = projectRootFromEnv() ?? resolve(stringField(raw, 'cwd') ?? process.cwd());
  const fallbackId = `unknown:${createHash('sha256').update(projectPath).digest('hex').slice(0, 16)}`;
  const result = activity(eventType, raw);
  return {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    source: 'claude-code',
    projectPath,
    projectName: basename(projectPath) || projectPath,
    sessionId: stringField(raw, 'session_id') ?? fallbackId,
    eventType,
    status: result.status,
    message: (messageEvents.includes(eventType) ? presentable(stringField(raw, 'message')) : undefined) ?? result.message,
    raw,
  };
}
