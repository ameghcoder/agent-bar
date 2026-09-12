import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { generatedConfig } from '../install/apply.js';

export { hookEvents } from '../install/merge.js';

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function createHooksConfig(command: string) {
  return generatedConfig(command);
}

export async function receiverCommand(): Promise<string> {
  const receiver = fileURLToPath(new URL('../hooks/claude-hook.js', import.meta.url));
  await access(receiver);
  return `${shellQuote(process.execPath)} ${shellQuote(receiver)}`;
}
