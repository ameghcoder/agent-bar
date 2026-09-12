#!/usr/bin/env node
import { Command } from 'commander';
import { applyInstall, applyUninstall, defaultSettingsPath, type ApplyOptions, type ApplyReport } from '../install/apply.js';
import { formatReport, runDoctor } from '../doctor/doctor.js';
import { createHooksConfig, receiverCommand } from '../scripts/install-claude-hooks.js';

const version = '0.1.0';
const minimumNode = '22.12.0';

interface HookCommandOptions { apply: boolean; settings?: string; backupDir?: string }

function applyOptions(options: HookCommandOptions): ApplyOptions {
  return { settingsPath: options.settings ?? defaultSettingsPath(), backupDir: options.backupDir, apply: options.apply };
}

function printReport(verb: string, report: ApplyReport): void {
  console.error(`Claude settings: ${report.settingsPath}${report.existed ? '' : ' (does not exist yet)'}`);
  for (const line of report.summary) console.error(`  ${line}`);
  if (report.applied) {
    console.error(report.backupPath ? `Backup written: ${report.backupPath}` : 'No backup: settings file did not exist.');
    console.error(`Settings updated. Restart Claude Code to ${verb} the hooks.`);
  } else if (!report.changed) {
    console.error('Nothing to change.');
  } else {
    console.error(`Preview only: no Claude settings have been changed. Re-run with --apply to ${verb}.`);
  }
}

function withHookOptions(command: Command): Command {
  return command
    .option('--apply', 'write the change to the settings file (a timestamped backup is made first)', false)
    .option('--settings <path>', 'Claude settings file (default: $CLAUDE_CONFIG_DIR/settings.json, else ~/.claude/settings.json)')
    .option('--backup-dir <dir>', 'where to write the backup (default: next to the settings file)');
}

const program = new Command()
  .name('agentbar')
  .description('Local Claude Code activity capture for AgentBar')
  .version(version)
  .showHelpAfterError();

withHookOptions(program.command('install-hooks'))
  .description('Preview AgentBar hooks for Claude Code; --apply merges them into your settings')
  .addHelpText('after', `
Without --apply this prints the generated hooks JSON to stdout and a summary of
what would change to stderr; nothing is written. With --apply the current
settings file is validated, backed up as <name>.agentbar-backup-<timestamp>
(mode 0600), then replaced atomically. Unrelated settings and hooks are kept.
Re-running is a no-op once the hooks are present.`)
  .action(async (options: HookCommandOptions) => {
    const command = await receiverCommand();
    const report = await applyInstall(applyOptions(options), command);
    if (!options.apply) console.log(JSON.stringify(createHooksConfig(command), null, 2));
    printReport('install', report);
  });

withHookOptions(program.command('uninstall-hooks'))
  .description('Preview removal of AgentBar hooks from Claude Code; --apply removes them')
  .addHelpText('after', `
Removes only handlers AgentBar generated; other hooks, matcher groups, and
settings are untouched. Same backup and atomic-write behavior as install-hooks.`)
  .action(async (options: HookCommandOptions) => {
    printReport('remove', await applyUninstall(applyOptions(options)));
  });

program.command('doctor')
  .description('Check the local AgentBar integration without changing anything')
  .option('--settings <path>', 'Claude settings file (default: $CLAUDE_CONFIG_DIR/settings.json, else ~/.claude/settings.json)')
  .addHelpText('after', `
Read-only. Reports PASS, WARN, or FAIL per check and exits 1 if any required
check fails. Output shows paths relative to ~ and never prints hook payloads,
session names, or settings content.`)
  .action(async (options: { settings?: string }) => {
    const checks = await runDoctor({ version, minimumNode, settingsPath: options.settings ?? defaultSettingsPath() });
    const report = formatReport(checks);
    console.log(report.stdout);
    console.error(report.stderr);
    if (report.failed.length) process.exitCode = 1;
  });

// Commander does not show help for an empty root command by default.
program.action(() => program.help());

try {
  await program.parseAsync(process.argv);
} catch (error) {
  console.error(`agentbar: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
