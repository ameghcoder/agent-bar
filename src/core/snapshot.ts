import { eventTypes, isRecord, statuses, type EventType, type Status } from './vocabulary.js';

export const schemaVersion = 1;

// A session with no event for this long is gone, whatever its status: the
// writer drops it from state.json and the presenter ignores it. Longer than the
// 10-minute stale threshold on purpose, so an overnight terminal survives.
export const sessionRetentionMs = 24 * 60 * 60 * 1000;

export interface SessionState {
  sessionId: string;
  projectName: string;
  projectPath: string;
  source: 'claude-code';
  status: Status;
  lastEventType: EventType;
  lastMessage: string;
  startedAt: string;
  lastSeenAt: string;
}

export interface AgentBarState {
  schemaVersion: typeof schemaVersion;
  updatedAt: string;
  sessions: SessionState[];
}

export type SnapshotParseResult =
  | { ok: true; state: AgentBarState; legacy: boolean }
  | { ok: false; reason: 'malformed_json' | 'invalid_shape' | 'unsupported_version'; message: string };

function isDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isSession(value: unknown): value is SessionState {
  if (!isRecord(value)) return false;
  return ['sessionId', 'projectName', 'projectPath', 'lastMessage'].every((key) => typeof value[key] === 'string')
    && value.source === 'claude-code'
    && statuses.some((status) => status === value.status)
    && eventTypes.some((type) => type === value.lastEventType)
    && isDate(value.startedAt) && isDate(value.lastSeenAt);
}

export function parseSnapshot(text: string): SnapshotParseResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'malformed_json', message: 'Snapshot is not valid JSON.' };
  }
  if (isRecord(value) && 'schemaVersion' in value && value.schemaVersion !== schemaVersion) {
    return {
      ok: false,
      reason: 'unsupported_version',
      message: `Snapshot declares schema version ${JSON.stringify(value.schemaVersion)}; this reader supports version ${schemaVersion}.`,
    };
  }
  if (isRecord(value) && isDate(value.updatedAt) && Array.isArray(value.sessions) && value.sessions.every(isSession)) {
    return {
      ok: true,
      state: { schemaVersion, updatedAt: value.updatedAt, sessions: value.sessions },
      legacy: !('schemaVersion' in value),
    };
  }
  return { ok: false, reason: 'invalid_shape', message: 'Snapshot does not match the version 1 session contract.' };
}

// Unreadable or future timestamps are kept: they cannot prove the session old,
// and the presenter already shows them as stale rather than hiding them.
export function withoutExpiredSessions<T extends { lastSeenAt: string }>(sessions: readonly T[], now: number): T[] {
  return sessions.filter((session) => !(now - Date.parse(session.lastSeenAt) > sessionRetentionMs));
}
