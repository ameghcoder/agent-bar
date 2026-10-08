import type { AgentProcess } from './snapshot.js';
import { isRecord, type EventType, type JsonObject, type Status } from './vocabulary.js';

export { eventTypes, isEventType, isRecord, statuses, type EventType, type JsonObject, type JsonValue, type Status } from './vocabulary.js';

// The normalized event: what an agent adapter produces from one native
// payload, and one line of events.jsonl (contract/event.schema.json). The name
// and the `source` literal are still Claude-shaped; see agents/README.md.
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
  agentProcess?: AgentProcess;
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

export const messageLimit = 120;

// Presentation string: first non-blank line, collapsed whitespace, hard cap.
export function presentable(text: string | undefined): string | undefined {
  const line = text?.split('\n').map((part) => part.replace(/\s+/g, ' ').trim()).find(Boolean);
  if (!line) return undefined;
  const points = Array.from(line);
  return points.length > messageLimit ? `${points.slice(0, messageLimit - 1).join('')}…` : line;
}

export const activeStatuses: readonly Status[] = ['running', 'waiting', 'permission_required'];
