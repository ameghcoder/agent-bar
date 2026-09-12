import { createHash, randomUUID } from 'node:crypto';
import { basename, resolve } from 'node:path';

export const eventTypes = [
  'session_start', 'pre_tool_use', 'post_tool_use', 'notification',
  'permission_request', 'stop', 'session_end', 'error',
] as const;
export type EventType = typeof eventTypes[number];

export const statuses = [
  'idle', 'running', 'waiting', 'permission_required', 'completed', 'failed', 'unknown',
] as const;
export type Status = typeof statuses[number];
export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
export interface JsonObject { [key: string]: JsonValue }

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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isEventType(value: string): value is EventType {
  return eventTypes.some((type) => type === value);
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
  return line.length > messageLimit ? `${line.slice(0, messageLimit - 1)}…` : line;
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

// Claude fires SessionStart for compaction and resume while a turn may still be
// in flight; only startup/clear mean a genuinely fresh, idle session.
export function carryActiveStatus(event: ClaudeEvent, previous: { status: Status; lastMessage: string } | undefined): ClaudeEvent {
  const source = stringField(event.raw, 'source');
  if (event.eventType !== 'session_start' || (source !== 'compact' && source !== 'resume')) return event;
  if (!previous || !activeStatuses.includes(previous.status)) return event;
  return { ...event, status: previous.status, message: previous.lastMessage };
}

export function normalizeEvent(eventType: EventType, raw: JsonObject): ClaudeEvent {
  const projectPath = resolve(stringField(raw, 'cwd') ?? process.cwd());
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
