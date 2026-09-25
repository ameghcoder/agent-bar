import type { Status } from './events.js';
import type { AgentBarState, SessionState } from './snapshot.js';

// Type-only imports keep this module free of Node built-ins so the GNOME
// extension can import the compiled file directly. See test/presentation.test.mjs.

export const intents = ['quiet', 'active', 'attention', 'complete', 'error', 'unknown'] as const;
export type Intent = typeof intents[number];

// `priority` decides the one status the top bar shows when sessions disagree,
// most urgent first: permission_required, failed, waiting, running, completed,
// unknown, idle. Keyed by Status so a new status cannot be added without one.
const presentation: Record<Status, { label: string; intent: Intent; priority: number }> = {
  permission_required: { label: 'Permission needed', intent: 'attention', priority: 7 },
  failed: { label: 'Failed', intent: 'error', priority: 6 },
  waiting: { label: 'Waiting for you', intent: 'attention', priority: 5 },
  running: { label: 'Working', intent: 'active', priority: 4 },
  // ADR 0004: a turn ended, not the project.
  completed: { label: 'Turn complete', intent: 'complete', priority: 3 },
  unknown: { label: 'Status unknown', intent: 'unknown', priority: 2 },
  idle: { label: 'Idle', intent: 'quiet', priority: 1 },
};

export function statusPriority(status: Status): number {
  return presentation[status].priority;
}

export function statusLabel(status: Status): string {
  return presentation[status].label;
}

export function statusIntent(status: Status): Intent {
  return presentation[status].intent;
}

// Named threshold (ADR 0004). A single long Bash call emits nothing between
// pre_tool_use and post_tool_use, so a few quiet minutes are normal.
export const defaultStaleAfterMs = 10 * 60 * 1000;

// CONTEXT.md: an attention state is permission required, waiting, or failed;
// an active state is one AgentBar expects further events for. Only active
// states go stale - a completed turn or an observed failure is settled fact.
const attentionStatuses: readonly Status[] = ['permission_required', 'waiting', 'failed'];
const activeStatuses: readonly Status[] = ['running', 'waiting', 'permission_required'];

export interface SessionView {
  sessionId: string;
  projectName: string;
  status: Status;
  label: string;
  intent: Intent;
  message: string;
  hint: string;
  attention: boolean;
  stale: boolean;
  staleForMs: number;
  lastSeenAt: string;
}

export interface IndicatorView {
  status: Status;
  label: string;
  intent: Intent;
  stale: boolean;
  attentionCount: number;
  sessions: SessionView[];
}

export interface PresentOptions {
  now?: number;
  staleAfterMs?: number;
}

// ADR 0004 permits a short hint - the parent directory name, never the full
// path - and only where two sessions share a project name.
function parentName(projectPath: string): string {
  const parts = projectPath.split('/').filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 2] ?? '' : '';
}

function toView(session: SessionState, now: number, staleAfterMs: number, ambiguous: boolean): SessionView {
  // An unreadable timestamp cannot prove freshness, so it counts as stale
  // rather than silently passing the >= test as NaN would.
  const age = now - Date.parse(session.lastSeenAt);
  const overdue = Number.isNaN(age) ? 0 : Math.max(age - staleAfterMs, 0);
  const stale = activeStatuses.includes(session.status) && (Number.isNaN(age) || age >= staleAfterMs);
  return {
    sessionId: session.sessionId,
    projectName: session.projectName,
    status: session.status,
    label: statusLabel(session.status),
    // ADR 0004: staleness is shown as unknown, never as failure or completion.
    intent: stale ? statusIntent('unknown') : statusIntent(session.status),
    message: session.lastMessage,
    hint: ambiguous ? parentName(session.projectPath) : '',
    attention: attentionStatuses.includes(session.status),
    stale,
    staleForMs: stale ? overdue : 0,
    lastSeenAt: session.lastSeenAt,
  };
}

// Spec: attention first, then most recently seen; session id only breaks ties.
function compare(left: SessionView, right: SessionView): number {
  if (left.attention !== right.attention) return left.attention ? -1 : 1;
  const seen = Date.parse(right.lastSeenAt) - Date.parse(left.lastSeenAt);
  return seen !== 0 ? seen : left.sessionId.localeCompare(right.sessionId);
}

export function presentSnapshot(state: AgentBarState, options: PresentOptions = {}): IndicatorView {
  const now = options.now ?? Date.now();
  const staleAfterMs = options.staleAfterMs ?? defaultStaleAfterMs;
  const names = new Map<string, number>();
  for (const session of state.sessions) names.set(session.projectName, (names.get(session.projectName) ?? 0) + 1);
  const sessions = state.sessions
    .map((session) => toView(session, now, staleAfterMs, (names.get(session.projectName) ?? 0) > 1))
    .sort(compare);
  const leader = [...sessions].sort((left, right) => statusPriority(right.status) - statusPriority(left.status))[0];
  // The top bar has room for one honest word: a stale leader reads "unknown"
  // there, while its menu row still names the last status actually observed.
  const summary = leader?.stale ? 'unknown' : leader?.status ?? 'idle';
  return {
    status: leader?.status ?? 'idle',
    label: statusLabel(summary),
    intent: statusIntent(summary),
    stale: leader?.stale ?? false,
    attentionCount: sessions.filter((session) => session.attention).length,
    sessions,
  };
}

// ADR 0004: notify once per meaningful transition per session, deduped by a
// stable key, and never on startup replay of state that predates the reader.
const notifyStatuses: readonly Status[] = ['permission_required', 'waiting', 'failed', 'completed'];

export interface NotificationView {
  key: string;
  sessionId: string;
  title: string;
  body: string;
  intent: Intent;
}

export function notificationsFor(previous: IndicatorView | undefined, next: IndicatorView): NotificationView[] {
  if (!previous) return [];
  const before = new Map(previous.sessions.map((session) => [session.sessionId, session.status]));
  return next.sessions
    .filter((session) => notifyStatuses.includes(session.status) && before.get(session.sessionId) !== session.status)
    .map((session) => ({
      key: `${session.sessionId}:${session.status}:${session.lastSeenAt}`,
      sessionId: session.sessionId,
      title: statusLabel(session.status),
      body: `${session.projectName}: ${session.message}`,
      intent: statusIntent(session.status),
    }));
}
