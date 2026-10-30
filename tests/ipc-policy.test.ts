import test from 'node:test';
import assert from 'node:assert/strict';
import { invocationPolicy } from '../electron/ipc/policy';
import { defaultSettings } from '../electron/store';

test('quit tracks stop and approval replies even when storage is read-only or a dialog is open', () => {
  for (const method of ['stop', 'stopAll', 'forceStop', 'respond', 'abortRetry', 'clearQueue'] as const) {
    const policy = invocationPolicy(method, [], defaultSettings);
    assert.equal(policy.access, 'read', method);
    assert.equal(policy.tracked, true, method);
    assert.equal(policy.duringDialog, true, method);
    assert.equal(policy.configuration, false, method);
  }
  assert.equal(invocationPolicy('send', [], defaultSettings).duringDialog, undefined);
  assert.equal(invocationPolicy('respondAppDialog', [], defaultSettings).duringUpdate, true);
  assert.equal(invocationPolicy('send', [], defaultSettings).duringUpdate, undefined);
});

test('appearance saves do not queue behind engine configuration changes', () => {
  for (const patch of [{ theme: 'dark' }, { piPath: defaultSettings.piPath }, {}])
    assert.equal(invocationPolicy('saveSettings', [patch], defaultSettings).configuration, false);
  assert.equal(
    invocationPolicy('saveSettings', [{ piPath: 'another-pi' }], defaultSettings).configuration,
    true,
  );
  assert.equal(invocationPolicy('configSave', [], defaultSettings).configuration, true);
});

test('workspace reservations distinguish navigation from independent forks and keep undo exclusive', () => {
  assert.equal(invocationPolicy('branchSession', ['id', 'navigate'], defaultSettings).workspace, 'session');
  assert.equal(invocationPolicy('branchSession', ['id', 'fork'], defaultSettings).workspace, undefined);
  assert.equal(invocationPolicy('messageAction', ['id', 'regenerate'], defaultSettings).workspace, 'session');
  assert.equal(invocationPolicy('messageAction', ['id', 'fork'], defaultSettings).workspace, undefined);
  assert.equal(invocationPolicy('revertChanges', [], defaultSettings).workspace, 'project');
  assert.equal(invocationPolicy('revertCheckpoint', [], defaultSettings).workspace, 'checkpoint');
});
