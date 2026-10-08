import { isRecord } from './vocabulary.js';

// One line of `agentbar doctor`. Agents and OS folders contribute their own
// checks (ADR 0007); the runner in src/doctor only orders and formats them.
export type CheckLevel = 'pass' | 'warn' | 'fail';

export interface Check {
  name: string;
  level: CheckLevel;
  detail: string;
}

export function errorCode(error: unknown): string {
  return isRecord(error) && typeof error.code === 'string' ? error.code : 'error';
}
