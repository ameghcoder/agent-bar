import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import lockfile from 'proper-lockfile';
import { eventTypes, isRecord, normalizeEvent, statuses, type ClaudeEvent, type EventType, type JsonObject, type Status } from './events.js';
import { getPaths } from './paths.js';

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
  updatedAt: string;
  sessions: SessionState[];
}

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

async function readState(path: string): Promise<AgentBarState> {
  let contents: string;
  try {
    contents = await readFile(path, 'utf8');
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return { updatedAt: new Date().toISOString(), sessions: [] };
    throw error;
  }
  try {
    const value: unknown = JSON.parse(contents);
    if (isRecord(value) && isDate(value.updatedAt) && Array.isArray(value.sessions) && value.sessions.every(isSession)) {
      return { updatedAt: value.updatedAt, sessions: value.sessions };
    }
  } catch { /* Report malformed JSON and invalid schemas the same way. */ }
  throw new Error(`Invalid state file at ${path}. Back it up and move it aside before retrying; existing data was not overwritten.`);
}

export async function captureEvent(type: EventType, raw: JsonObject): Promise<ClaudeEvent> {
  const paths = getPaths();
  await mkdir(paths.directory, { recursive: true, mode: 0o700 });
  // Separate hook processes share this lock. Heartbeats allow recovery after a crash.
  const release = await lockfile.lock(paths.directory, {
    realpath: false,
    lockfilePath: `${paths.directory}/.write.lock`,
    stale: 10_000,
    retries: { retries: 60, factor: 1, minTimeout: 200, maxTimeout: 200, randomize: true },
  });
  const temporaryPath = `${paths.state}.${randomUUID()}.tmp`;
  try {
    const state = await readState(paths.state);
    // Timestamp in commit order, after acquiring the lock.
    const event = normalizeEvent(type, raw);
    const index = state.sessions.findIndex((session) => session.sessionId === event.sessionId);
    const previous = state.sessions[index];
    const session: SessionState = {
      sessionId: event.sessionId,
      projectName: event.projectName,
      projectPath: event.projectPath,
      source: event.source,
      status: event.status,
      lastEventType: event.eventType,
      lastMessage: event.message,
      startedAt: previous?.startedAt ?? event.timestamp,
      lastSeenAt: event.timestamp,
    };
    if (index === -1) state.sessions.push(session);
    else state.sessions[index] = session;
    state.updatedAt = event.timestamp;
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await appendFile(paths.history, `${JSON.stringify(event)}\n`, { mode: 0o600 });
    await rename(temporaryPath, paths.state);
    return event;
  } finally {
    try {
      await rm(temporaryPath, { force: true });
    } finally {
      await release();
    }
  }
}
