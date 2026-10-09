import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import lockfile from 'proper-lockfile';
import { isRecord, type ClaudeEvent } from './events.js';
import { getPaths } from './paths.js';
import { parseSnapshot, schemaVersion, withoutExpiredSessions, type AgentBarState, type SessionState } from './snapshot.js';

export type { AgentBarState, SessionState } from './snapshot.js';

async function readState(path: string): Promise<AgentBarState> {
  let contents: string;
  try {
    contents = await readFile(path, 'utf8');
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return { schemaVersion, updatedAt: new Date().toISOString(), sessions: [] };
    throw error;
  }
  const result = parseSnapshot(contents);
  if (result.ok) return result.state;
  throw new Error(`Invalid state file at ${path}: ${result.message} Back it up and move it aside before retrying; existing data was not overwritten.`);
}

// History holds full hook payloads and would otherwise grow forever. When the
// next line would take it past this size it becomes `events.jsonl.1`,
// replacing the previous one, and a new file starts: at most about twice this
// on disk. Runs under the write lock, so concurrent hooks cannot race it.
export const historyRotateBytes = 10 * 1024 * 1024;

async function rotateHistory(path: string, incoming: number): Promise<void> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return;
    throw error;
  }
  if (size > 0 && size + incoming > historyRotateBytes) await rename(path, `${path}.1`);
}

// What an agent adapter hands capture (ADR 0007): core never imports an
// adapter. Both run while the write lock is held, so `normalize` stamps the
// event in commit order, and `reconcile` sees the session's previous state
// and returns the event to record (status carry-over, a stable project).
export interface CaptureAdapter {
  normalize(): ClaudeEvent;
  reconcile(event: ClaudeEvent, previous: SessionState | undefined): ClaudeEvent;
}

export async function captureEvent(adapter: CaptureAdapter): Promise<ClaudeEvent> {
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
    const normalized = adapter.normalize();
    const index = state.sessions.findIndex((session) => session.sessionId === normalized.sessionId);
    const previous = state.sessions[index];
    // Identity and the commit-order timestamp belong to core: a reconcile that
    // changed the session ID would overwrite another session's slot.
    const event = {
      ...adapter.reconcile(normalized, previous),
      id: normalized.id,
      sessionId: normalized.sessionId,
      timestamp: normalized.timestamp,
    };
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
      // Overwritten on every event, so a resumed session points at its current process.
      ...(event.agentProcess ? { agentProcess: event.agentProcess } : {}),
    };
    if (index === -1) state.sessions.push(session);
    else state.sessions[index] = session;
    state.sessions = withoutExpiredSessions(state.sessions, Date.parse(event.timestamp));
    state.updatedAt = event.timestamp;
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    const line = `${JSON.stringify(event)}\n`;
    await rotateHistory(paths.history, Buffer.byteLength(line));
    await appendFile(paths.history, line, { mode: 0o600 });
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
