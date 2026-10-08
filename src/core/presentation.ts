import type { Status } from './vocabulary.js';
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
  relative: string;
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
  // The complete top-bar text, see topBarTitle.
  title: string;
  // The session the title describes. Stable while the time text in the title
  // changes, so a renderer can key an animation on it without restarting every
  // minute. null when there are no sessions.
  leaderId: string | null;
  // One neutral line for the menu, see healthLine.
  health: string;
}

export interface PresentOptions {
  now?: number;
  staleAfterMs?: number;
}

// Short, safe-to-render relative time. Degrades the same way staleness does:
// a future timestamp (clock skew) never claims a specific age, and an
// unreadable one is honestly "unknown" rather than a guessed number.
export function relativeTime(iso: string, now: number): string {
  const age = now - Date.parse(iso);
  if (Number.isNaN(age)) return 'unknown';
  if (age <= 0) return 'just now';
  const minutes = Math.floor(age / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(now - age).toISOString().slice(0, 10);
}

// ADR 0004 permits a short hint - the parent directory name, never the full
// path - and only where two sessions share a project name.
function parentName(projectPath: string): string {
  const parts = projectPath.split('/').filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 2] ?? '' : '';
}

// Top-bar names are cut here, in the pure model, so the bar never grows with
// a long project name and every renderer shows the same text.
export const titleNameLimit = 18;

function shortName(name: string): string {
  const points = Array.from(name);
  return points.length > titleNameLimit ? `${points.slice(0, titleNameLimit - 1).join('')}…` : name;
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
    relative: relativeTime(session.lastSeenAt, now),
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

// "<project> - <State> - <time ago>", plus " +N" for the other fresh sessions
// that are `running`. Waiting and permission sessions are not counted: they
// are blocked on you, not running, and the menu shows them. When only stale
// sessions remain the title says "No updates" instead of guessing a state
// (ADR 0004: a missing event is not evidence of anything).
function topBarTitle(leader: SessionView | undefined, otherRunning: number): string {
  if (!leader) return 'AgentBar - No sessions';
  const name = shortName(leader.projectName);
  if (leader.stale) {
    // An unreadable timestamp cannot name an age; say only what is known.
    return leader.relative === 'unknown' ? `${name} - No updates` : `${name} - No updates - ${leader.relative}`;
  }
  return `${name} - ${leader.label} - ${leader.relative}${otherRunning > 0 ? ` +${otherRunning}` : ''}`;
}

// What the state file proves about the event flow, nothing more: it never says
// whether hooks are installed (that is `agentbar doctor`) and carries no
// session data. "Receiving" uses the stale window, so a quiet few minutes
// during a long tool call still reads as receiving.
function healthLine(sessions: SessionView[], now: number, staleAfterMs: number): string {
  if (sessions.length === 0) return 'No events yet · run "agentbar install-hooks"';
  const newest = sessions
    .map((session) => Date.parse(session.lastSeenAt))
    .reduce((latest, time) => (time > latest ? time : latest), Number.NEGATIVE_INFINITY);
  if (!Number.isFinite(newest)) return 'No recent events';
  const relative = relativeTime(new Date(newest).toISOString(), now);
  const age = relative === 'just now' ? relative : `last ${relative}`;
  return now - newest < staleAfterMs ? `Receiving events · ${age}` : `No recent events · ${age}`;
}

export function presentSnapshot(state: AgentBarState, options: PresentOptions = {}): IndicatorView {
  const now = options.now ?? Date.now();
  const staleAfterMs = options.staleAfterMs ?? defaultStaleAfterMs;
  const names = new Map<string, number>();
  for (const session of state.sessions) names.set(session.projectName, (names.get(session.projectName) ?? 0) + 1);
  const sessions = state.sessions
    .map((session) => toView(session, now, staleAfterMs, (names.get(session.projectName) ?? 0) > 1))
    .sort(compare);
  // A stale session only leads when nothing fresh exists: an old unanswered
  // permission request must not hide the session you are using right now.
  // `sessions` is already attention-first, most recent first, and the sort
  // below is stable, so ties keep that order.
  const fresh = sessions.filter((session) => !session.stale);
  const pool = fresh.length > 0 ? fresh : sessions;
  const leader = [...pool].sort((left, right) => statusPriority(right.status) - statusPriority(left.status))[0];
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
    title: topBarTitle(leader, fresh.filter((session) => session !== leader && session.status === 'running').length),
    leaderId: leader?.sessionId ?? null,
    health: healthLine(sessions, now, staleAfterMs),
  };
}

// ADR 0004: notify once per meaningful transition per session, and never on
// startup replay of state that predates the reader. A transition is a session's
// status differing between two consecutive views, so an identical re-read is
// silent and a second permission request after work in between notifies again.
// Urgency lives here, not in the extension: permission blocks Claude and
// gets the strongest tier without repeatedly stealing focus; failed is a
// real problem; waiting only asks for input; completed is informational.
export const urgencies = ['critical', 'high', 'normal', 'low'] as const;
export type Urgency = typeof urgencies[number];
const urgencyByStatus: Partial<Record<Status, Urgency>> = {
  permission_required: 'critical',
  failed: 'high',
  waiting: 'normal',
  completed: 'low',
};
const notifyStatuses = Object.keys(urgencyByStatus) as readonly Status[];

// Title and body are fixed text: the status label and the project name. Never
// `message`, which Claude writes for permission, notification, and failure
// events and which may hold a command, a path, or an error dump.
export interface NotificationView {
  sessionId: string;
  title: string;
  body: string;
  intent: Intent;
  urgency: Urgency;
}

export function notificationsFor(previous: IndicatorView | undefined, next: IndicatorView): NotificationView[] {
  if (!previous) return [];
  const before = new Map(previous.sessions.map((session) => [session.sessionId, session.status]));
  return next.sessions
    .filter((session) => notifyStatuses.includes(session.status) && before.get(session.sessionId) !== session.status)
    .map((session) => ({
      sessionId: session.sessionId,
      title: statusLabel(session.status),
      body: session.projectName,
      intent: statusIntent(session.status),
      // notifyStatuses is exactly urgencyByStatus's keys, so this is total.
      urgency: urgencyByStatus[session.status] as Urgency,
    }));
}
