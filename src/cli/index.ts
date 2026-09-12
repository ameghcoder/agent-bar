#!/usr/bin/env node
import { Command } from 'commander';
import { printHooksConfig } from '../scripts/install-claude-hooks.js';

const program = new Command()
  .name('agentbar')
  .description('Local Claude Code activity capture for AgentBar')
  .version('0.1.0')
  .showHelpAfterError();

program
  .command('install-hooks')
  .description('Print Claude Code hooks config without modifying settings')
  .action(printHooksConfig);

// Commander does not show help for an empty root command by default.
program.action(() => program.help());

try {
  await program.parseAsync(process.argv);
} catch (error) {
  console.error(`agentbar: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
