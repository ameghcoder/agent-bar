import assert from 'node:assert/strict';
import test from 'node:test';
import { installedVersion, needsRelogin } from '../os/linux/gnome-shell/lib/upgrade.js';

// T905: on Wayland, GNOME Shell loads extension code only at login, so after
// an upgrade the running AgentBar is older than the files on disk. The check
// compares the running version with the installed metadata.json, and only
// ever asks; it never guesses from a file it cannot read.
const metadata = (version) => JSON.stringify({ uuid: 'agentbar@ameghcoder.github.io', 'version-name': version });

test('the installed version is read from metadata.json, and anything unreadable is unknown', () => {
  assert.equal(installedVersion(metadata('0.3.0')), '0.3.0');
  assert.equal(installedVersion('{not json'), null);
  assert.equal(installedVersion(JSON.stringify({ uuid: 'x' })), null);
  assert.equal(installedVersion(metadata('')), null);
  assert.equal(installedVersion(metadata(42)), null);
  assert.equal(installedVersion(null), null, 'file missing, for example while dpkg replaces it');
});

test('a logout is needed only when the installed version is known and differs from the running one', () => {
  assert.equal(needsRelogin('0.2.0', metadata('0.3.0')), true, 'upgrade');
  assert.equal(needsRelogin('0.3.0', metadata('0.2.0')), true, 'downgrade also replaces the code');
  assert.equal(needsRelogin('0.3.0', metadata('0.3.0')), false, 'a same-version reinstall needs nothing');
  assert.equal(needsRelogin('0.3.0', '{not json'), false, 'never nag on a file it cannot read');
  assert.equal(needsRelogin('0.3.0', null), false, 'nor on a missing file');
  assert.equal(needsRelogin(undefined, metadata('0.3.0')), false, 'nor without a running version');
});
