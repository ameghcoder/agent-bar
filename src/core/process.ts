import { readFileSync } from 'node:fs';
import { linuxStartToken, type AgentProcess } from './snapshot.js';

// ADR 0008: the identity of a running process, from /proc/<pid>/stat only -
// never cmdline, environ, or open files. Linux only; elsewhere nothing is
// recorded and AgentBar behaves as it did before liveness existed.
export function processIdentity(pid: number): AgentProcess | undefined {
  if (process.platform !== 'linux' || !Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    const start = linuxStartToken(readFileSync(`/proc/${pid}/stat`, 'utf8'));
    return start ? { pid, start } : undefined;
  } catch {
    return undefined;
  }
}
