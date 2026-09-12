import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

export function getPaths() {
  const override = process.env.AGENTBAR_STATE_DIR;
  if (override && !isAbsolute(override)) {
    throw new Error('AGENTBAR_STATE_DIR must be an absolute path.');
  }
  const directory = override || join(homedir(), '.local', 'state', 'agentbar');
  return {
    directory,
    state: join(directory, 'state.json'),
    history: join(directory, 'events.jsonl'),
  };
}
