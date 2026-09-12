import assert from 'node:assert/strict';
import test from 'node:test';
import { installHooks, uninstallHooks } from '../dist/install/merge.js';

const command = "'/usr/bin/node' '/opt/agentbar/dist/hooks/claude-hook.js'";
const officialEvents = [
  'SessionStart', 'PreToolUse', 'PostToolUse', 'Notification', 'PermissionRequest',
  'Stop', 'SessionEnd', 'PostToolUseFailure', 'StopFailure',
];

test('empty settings receive exactly one AgentBar handler per supported Claude event', () => {
  const result = installHooks({}, command);
  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.deepEqual(Object.keys(result.settings), ['hooks']);
  assert.deepEqual(Object.keys(result.settings.hooks).sort(), [...officialEvents].sort());
  for (const event of officialEvents) {
    const groups = result.settings.hooks[event];
    assert.equal(groups.length, 1, event);
    assert.equal(groups[0].hooks.length, 1, event);
    assert.equal(groups[0].hooks[0].type, 'command');
    assert.match(groups[0].hooks[0].command, new RegExp(`^${command.replaceAll('/', '\\/').replaceAll('.', '\\.')} --event [a-z_]+$`));
    assert.equal(groups[0].hooks[0].timeout, 30);
  }
  assert.equal(result.settings.hooks.StopFailure[0].hooks[0].command.endsWith('--event error'), true);
  assert.equal(result.settings.hooks.PostToolUseFailure[0].hooks[0].command.endsWith('--event error'), true);
});

const populated = () => ({
  permissions: { allow: ['Bash(pnpm test)'], deny: [] },
  enabledPlugins: { 'mattpocock-skills@claude-plugins-official': true },
  model: 'opus',
  hooks: {
    PreToolUse: [
      { matcher: 'Bash', hooks: [{ type: 'command', command: '/home/me/bin/audit-bash.sh', timeout: 5 }] },
      { hooks: [{ type: 'command', command: 'echo pre' }, { type: 'prompt', prompt: 'Check the diff' }] },
    ],
    Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'notify-send done' }] }],
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo prompt' }] }],
  },
});

test('populated settings keep every unrelated root key, event, matcher group, and handler', () => {
  const before = populated();
  const result = installHooks(before, command);
  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.deepEqual(before, populated(), 'input must not be mutated');
  const { hooks, ...rest } = result.settings;
  assert.deepEqual(rest, { permissions: populated().permissions, enabledPlugins: populated().enabledPlugins, model: 'opus' });
  assert.deepEqual(hooks.UserPromptSubmit, populated().hooks.UserPromptSubmit);
  assert.deepEqual(hooks.PreToolUse.slice(0, 2), populated().hooks.PreToolUse);
  assert.equal(hooks.PreToolUse.length, 3);
  assert.deepEqual(hooks.PreToolUse[2], { hooks: [{ type: 'command', command: `${command} --event pre_tool_use`, timeout: 30 }] });
  assert.deepEqual(hooks.Stop[0], populated().hooks.Stop[0]);
  assert.equal(hooks.Stop.length, 2);
  assert.equal(hooks.Notification.length, 1);
});

test('repeated install is a no-op and existing AgentBar handlers are never duplicated', () => {
  const once = installHooks(populated(), command);
  const twice = installHooks(once.settings, command);
  assert.equal(twice.ok, true);
  assert.equal(twice.changed, false);
  assert.deepEqual(twice.settings, once.settings);
  assert.equal(twice.summary.every((line) => /already present/.test(line)), true);

  const moved = "'/usr/local/bin/node' '/home/me/src/agentbar/dist/hooks/claude-hook.js'";
  const settings = {
    hooks: {
      Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'notify-send done' }, { type: 'command', command: `${moved} --event stop`, timeout: 30 }] }],
    },
  };
  const result = installHooks(settings, command);
  assert.equal(result.ok, true);
  assert.equal(result.settings.hooks.Stop.length, 1, 'handler from a moved install still counts as AgentBar');
  assert.equal(result.settings.hooks.Stop[0].hooks.length, 2);
  assert.equal(result.settings.hooks.PreToolUse.length, 1);
});

test('uninstall removes AgentBar handlers only and prunes only containers it emptied', () => {
  const installed = installHooks(populated(), command).settings;
  installed.hooks.SessionEnd.unshift({ matcher: 'x', hooks: [] });
  installed.hooks.Stop[0].hooks.push({ type: 'command', command: 'echo agentbar-hook --event stop' });
  installed.hooks.Notification[0].hooks.push({ type: 'command', command: 'notify-send hi' });
  const result = uninstallHooks(installed);
  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.deepEqual(result.settings.hooks.PreToolUse, populated().hooks.PreToolUse);
  assert.deepEqual(result.settings.hooks.UserPromptSubmit, populated().hooks.UserPromptSubmit);
  assert.deepEqual(result.settings.hooks.Stop, [{ matcher: '', hooks: [{ type: 'command', command: 'notify-send done' }, { type: 'command', command: 'echo agentbar-hook --event stop' }] }]);
  assert.deepEqual(result.settings.hooks.Notification, [{ hooks: [{ type: 'command', command: 'notify-send hi' }] }]);
  assert.deepEqual(result.settings.hooks.SessionEnd, [{ matcher: 'x', hooks: [] }], 'pre-existing empty group is not ours to prune');
  for (const event of ['SessionStart', 'PostToolUse', 'PermissionRequest', 'PostToolUseFailure', 'StopFailure']) {
    assert.equal(event in result.settings.hooks, false, `${event} array emptied by us is removed`);
  }
  const { hooks, ...rest } = result.settings;
  assert.deepEqual(rest, { permissions: populated().permissions, enabledPlugins: populated().enabledPlugins, model: 'opus' });

  const onlyOurs = uninstallHooks(installHooks({ model: "opus" }, command).settings);
  assert.deepEqual(onlyOurs.settings, { model: 'opus' }, 'hooks object emptied by us is removed');
});

test('repeated uninstall is a no-op and never touches settings without AgentBar handlers', () => {
  const clean = populated();
  const first = uninstallHooks(clean);
  assert.equal(first.ok, true);
  assert.equal(first.changed, false);
  assert.deepEqual(first.settings, populated());
  const cycle = uninstallHooks(uninstallHooks(installHooks(populated(), command).settings).settings);
  assert.equal(cycle.changed, false);
  assert.deepEqual(cycle.settings, populated());
});

test('malformed or non-object settings are rejected without a proposed write', () => {
  const bad = [
    null, [], 'text', 42, true,
    { hooks: [] }, { hooks: 'x' }, { hooks: null },
    { hooks: { Stop: {} } }, { hooks: { Stop: 'cmd' } },
    { hooks: { Stop: [null] } }, { hooks: { Stop: ['cmd'] } },
    { hooks: { Stop: [{ hooks: {} }] } }, { hooks: { Stop: [{ hooks: 'cmd' }] } },
  ];
  for (const settings of bad) {
    for (const [name, fn] of [['install', () => installHooks(settings, command)], ['uninstall', () => uninstallHooks(settings)]]) {
      const result = fn();
      assert.equal(result.ok, false, `${name} should reject ${JSON.stringify(settings)}`);
      assert.equal('settings' in result, false);
      assert.equal(typeof result.message, 'string');
    }
  }
  const ok = installHooks({ hooks: { Stop: [{ matcher: 'x' }] } }, command);
  assert.equal(ok.ok, true, 'a group without a hooks array is valid Claude config');
});

test('summary lines name events and AgentBar actions only, never unrelated settings content', () => {
  const secretish = populated();
  secretish.env = { ANTHROPIC_API_KEY: 'sk-ant-secret' };
  for (const result of [installHooks(secretish, command), uninstallHooks(installHooks(secretish, command).settings)]) {
    assert.equal(result.ok, true);
    assert.equal(result.summary.length > 0, true);
    for (const line of result.summary) {
      assert.match(line, /^[A-Za-z]+: /);
      assert.doesNotMatch(line, /sk-ant|audit-bash|pnpm test|notify-send|mattpocock/);
    }
  }
});
