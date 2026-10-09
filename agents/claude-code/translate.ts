import { createHash, randomUUID } from 'node:crypto';
import { basename, isAbsolute, resolve } from 'node:path';
import { activeStatuses, presentable, type ClaudeEvent, type EventType, type JsonObject, type Status } from '../../src/core/events.js';
import { processIdentity } from '../../src/core/process.js';
import type { AgentProcess } from '../../src/core/snapshot.js';
import type { CaptureAdapter } from '../../src/core/state.js';

// Claude Code adapter, translate step (ADR 0007): one native hook payload in,
// one normalized event out. Everything after the normalized event is
// agent-neutral and lives in src/core.

function stringField(raw: JsonObject, key: string): string | undefined {
  const value = raw[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

// Only Claude-authored attention events carry a user-facing message field.
const messageEvents: readonly EventType[] = ['notification', 'permission_request'];

function activity(type: EventType, raw: JsonObject): { status: Status; message: string } {
  const tool = stringField(raw, 'tool_name') ?? 'tool';
  switch (type) {
    case 'session_start': return { status: 'idle', message: 'Session started' };
    case 'pre_tool_use': return { status: 'running', message: `Preparing tool: ${tool}` };
    case 'post_tool_use': return { status: 'running', message: `Tool finished: ${tool}` };
    // AskUserQuestion arrives as a permission request, but Claude is waiting
    // for an answer, not for permission (decided after the T401 live run).
    case 'permission_request': return tool === 'AskUserQuestion'
      ? { status: 'waiting', message: 'Claude is asking you a question' }
      : { status: 'permission_required', message: `Permission requested for ${tool}` };
    case 'stop': return { status: 'completed', message: 'Claude finished responding' };
    case 'session_end': return { status: 'idle', message: `Session ended: ${stringField(raw, 'reason') ?? 'unspecified'}` };
    // A failed tool call is routine: Claude reads the error and carries on, so
    // the session stays running and no "Failed" banner fires. Only a failed
    // turn (StopFailure) is failed. Decided after the T401 live run.
    case 'error': {
      const detail = presentable(stringField(raw, 'error') ?? stringField(raw, 'error_details'));
      if (stringField(raw, 'hook_event_name') === 'PostToolUseFailure') return { status: 'running', message: detail ?? `Tool failed: ${tool}` };
      return { status: 'failed', message: detail ?? 'Claude reported an error' };
    }
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

// Claude Code passes its own PID to hook commands as CLAUDE_PID (verified on
// 2.1.294: the hook's parent process). ADR 0008.
export function agentProcessFromEnv(env: NodeJS.ProcessEnv = process.env): AgentProcess | undefined {
  const value = env.CLAUDE_PID ?? '';
  return /^[1-9]\d*$/.test(value) ? processIdentity(Number(value)) : undefined;
}

export function normalizeEvent(eventType: EventType, raw: JsonObject, env: NodeJS.ProcessEnv = process.env): ClaudeEvent {
  const projectPath = projectRootFromEnv(env) ?? resolve(stringField(raw, 'cwd') ?? process.cwd());
  const fallbackId = `unknown:${createHash('sha256').update(projectPath).digest('hex').slice(0, 16)}`;
  const result = activity(eventType, raw);
  const agentProcess = agentProcessFromEnv(env);
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
    ...(agentProcess ? { agentProcess } : {}),
    raw,
  };
}

// What capture calls while it holds the write lock. Without
// CLAUDE_PROJECT_DIR the event's path is only `cwd`, which drifts into
// subdirectories, so an existing session keeps the project it was first seen with.
export function claudeCodeCapture(eventType: EventType, raw: JsonObject): CaptureAdapter {
  return {
    normalize: () => normalizeEvent(eventType, raw),
    reconcile: (event, previous) => {
      const carried = carryActiveStatus(event, previous);
      if (!previous || projectRootFromEnv() !== undefined) return carried;
      return { ...carried, projectPath: previous.projectPath, projectName: previous.projectName };
    },
  };
}
