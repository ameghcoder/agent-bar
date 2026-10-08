import { eventTypes, isRecord, statuses, type EventType, type Status } from './vocabulary.js';

export const schemaVersion = 1;

// A session with no event for this long is gone, whatever its status: the
// writer drops it from state.json and the extension's reader drops it before
// presenting (presentSnapshot stays pure and shows what it is given). Longer than the
// 10-minute stale threshold on purpose, so an overnight terminal survives.
export const sessionRetentionMs = 24 * 60 * 60 * 1000;

// Readers refuse a state file larger than this before loading it. Sessions
// expire after a day, so a real snapshot stays far below it; anything bigger
// is corrupt or hostile, and the extension must not pull it into GNOME Shell.
export const maxSnapshotBytes = 1024 * 1024;

// ADR 0008: the agent's process, so a reader can tell whether it still runs.
// `start` is an opaque per-OS identity token (Linux: /proc/<pid>/stat field 22),
// because the kernel reuses PIDs and the pair is what identifies one process.
export interface AgentProcess {
  pid: number;
  start: string;
}

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
  agentProcess?: AgentProcess;
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
      state: { schemaVersion, updatedAt: value.updatedAt, sessions: value.sessions.map(withValidProcess) },
      legacy: !('schemaVersion' in value),
    };
  }
  return { ok: false, reason: 'invalid_shape', message: 'Snapshot does not match the version 1 session contract.' };
}

function isAgentProcess(value: unknown): value is AgentProcess {
  return isRecord(value) && Number.isInteger(value.pid) && (value.pid as number) > 0
    && typeof value.start === 'string' && value.start !== '';
}

// A malformed agentProcess is dropped, not fatal: liveness is an aid, and its
// absence must never hide a session (ADR 0008).
function withValidProcess(session: SessionState): SessionState {
  if (!('agentProcess' in session) || isAgentProcess(session.agentProcess)) return session;
  const { agentProcess: _dropped, ...rest } = session;
  return rest;
}

// The `starttime` field of a Linux /proc/<pid>/stat line. The process name in
// field 2 may hold spaces and parentheses, so fields are counted from the last ')'.
export function linuxStartToken(stat: string): string | undefined {
  const close = stat.lastIndexOf(')');
  if (close === -1) return undefined;
  const token = stat.slice(close + 2).split(' ')[19];
  return token && /^\d+$/.test(token) ? token : undefined;
}

// Unreadable or future timestamps are kept: they cannot prove the session old,
// and the presentation model shows an unreadable one as stale rather than hiding it.
export function withoutExpiredSessions<T extends { lastSeenAt: string }>(sessions: readonly T[], now: number): T[] {
  return sessions.filter((session) => !(now - Date.parse(session.lastSeenAt) > sessionRetentionMs));
}
