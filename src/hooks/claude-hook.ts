#!/usr/bin/env node
import { Command, InvalidArgumentError, Option } from 'commander';
import { eventTypes, isEventType, parseInput } from '../core/events.js';
import { captureEvent } from '../core/state.js';
import { version } from '../version.js';

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > 10 * 1024 * 1024) throw new Error('Hook input exceeds the 10 MiB limit; no event was saved.');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseEvent(value: string) {
  if (!isEventType(value)) {
    throw new InvalidArgumentError(`must be one of: ${eventTypes.join(', ')}`);
  }
  return value;
}

const program = new Command()
  .name('agentbar-hook')
  .description('Capture a Claude Code hook event from JSON on stdin')
  .version(version)
  .addOption(new Option('-e, --event <type>', 'normalized AgentBar event type').argParser(parseEvent).makeOptionMandatory())
  .addHelpText('after', `\nSupported events:\n  ${eventTypes.join('\n  ')}\n\nInput:\n  A JSON object on stdin. Empty input is allowed.`)
  .showHelpAfterError()
  .action(async (options: { event: string }) => {
    // The option parser validates this before the action executes.
    if (!isEventType(options.event)) throw new Error(`Unsupported event: ${options.event}`);
    await captureEvent(options.event, parseInput(await readStdin()));
    // No stdout: Claude treats hook output as context or permission decisions.
  });

try {
  await program.parseAsync(process.argv);
} catch (error) {
  console.error(`agentbar-hook: ${error instanceof Error ? error.message : String(error)}`);
  // Exit 1 reports a capture failure without using Claude's blocking exit code 2.
  process.exitCode = 1;
}
