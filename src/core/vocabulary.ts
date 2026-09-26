// GJS-portable vocabulary: no node: imports, so this file and anything that
// imports only from here can be loaded unmodified by the GNOME extension.
// See test/snapshot.test.mjs and test/presentation.test.mjs.

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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isEventType(value: string): value is EventType {
  return eventTypes.some((type) => type === value);
}
