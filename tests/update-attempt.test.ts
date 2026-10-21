import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import electronUpdater from 'electron-updater';
import { UpdateAttemptFile } from '../electron/update-attempt';
import { nativeUpdateDriver } from '../electron/update-driver';
import { UpdateService } from '../electron/updater';
import { updateInstallNotice, type UpdateInstallAttempt } from '../shared/app-update';

const attempt = (now = Date.now()): UpdateInstallAttempt => ({
  currentVersion: '0.14.18',
  targetVersion: '0.14.19',
  startedAt: now,
  outcome: 'pending',
});
async function receipt(t: test.TestContext) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-update-attempt-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return { dir, file: new UpdateAttemptFile(dir) };
}

test('installation receipts reconcile against the running version, not installer launch', async (t) => {
  const { file } = await receipt(t);
  await file.record(attempt());
  assert.equal((await file.read('0.14.18'))?.outcome, 'unconfirmed');
  assert.equal(await fs.readFile(file.file, 'utf8').then((value) => JSON.parse(value).outcome), 'pending');
  assert.equal((await file.read('0.14.19'))?.outcome, 'completed');
  await assert.rejects(fs.access(file.file), { code: 'ENOENT' });
  await file.record(attempt());
  assert.equal((await file.read('0.14.20'))?.outcome, 'completed');
  await assert.rejects(fs.access(file.file), { code: 'ENOENT' });
  await file.record({ ...attempt(), outcome: 'failed' });
  assert.equal((await file.read('0.14.18'))?.outcome, 'failed');
  assert.equal((await file.read('0.14.19'))?.outcome, 'completed');
  await assert.rejects(fs.access(file.file), { code: 'ENOENT' });
});

test('only the latest minimal receipt is saved, writes are ordered and retention is seven days', async (t) => {
  const { dir, file } = await receipt(t),
    now = Date.now();
  await Promise.all([
    file.record({ ...attempt(now), privatePath: '/must-not-be-saved' } as UpdateInstallAttempt),
    file.record({ ...attempt(now), outcome: 'failed' }),
  ]);
  const saved = JSON.parse(await fs.readFile(file.file, 'utf8'));
  assert.deepEqual(saved, { ...attempt(now), outcome: 'failed' });
  assert.deepEqual(await fs.readdir(dir), ['update-install.json']);
  assert.equal((await file.read('0.14.18', now + 7 * 86400000))?.outcome, 'failed');
  assert.equal(await file.read('0.14.18', now + 7 * 86400000 + 1), undefined);
  assert.deepEqual(await fs.readdir(dir), []);
});

test('missing, malformed, oversized and invalid receipts never prevent startup', async (t) => {
  const { file } = await receipt(t);
  assert.equal(await file.read('0.14.18'), undefined);
  for (const value of [
    '{broken',
    ' '.repeat(4097),
    'null',
    JSON.stringify({ ...attempt(), targetVersion: 'not-a-version' }),
    JSON.stringify({ ...attempt(), targetVersion: '0.14.18' }),
    JSON.stringify({ ...attempt(), startedAt: Date.now() + 120000 }),
    JSON.stringify({ ...attempt(), outcome: 'unknown' }),
  ]) {
    await fs.writeFile(file.file, value);
    assert.equal(await file.read('0.14.18'), undefined);
  }
});

test('a still-running, cancelled or exited installer is described as unconfirmed, never as proven failure', async (t) => {
  const { file } = await receipt(t);
  await file.record(attempt());
  const previousAttempt = await file.read('0.14.18');
  const service = new UpdateService({
    currentVersion: '0.14.18',
    installation: 'portable',
    enabled: true,
    autoDownload: false,
    previousAttempt,
    busy: () => false,
    beforeInstall: async () => {},
    installFailed: () => {},
  });
  t.after(() => service.dispose());
  const notice = updateInstallNotice(service.state)!;
  assert.match(notice, /尚未确认更新完成/);
  assert.match(notice, /如果安装程序仍在运行，请等待完成/);
  assert.doesNotMatch(notice, /报告了错误|安装失败/);
  assert.equal(updateInstallNotice({ ...service.state, currentVersion: '0.14.19' }), undefined);
});

test(
  'real NSIS driver shows explicit installation and retains an unconfirmed result after launch then exit',
  {
    skip:
      process.platform === 'win32'
        ? 'POSIX executable stand-ins; real Windows success is covered by test:update'
        : false,
  },
  async (t) => {
    const { dir, file } = await receipt(t);
    const require = createRequire(import.meta.url),
      key = require.resolve('electron');
    const previous = require.cache[key];
    require.cache[key] = {
      id: key,
      filename: key,
      loaded: true,
      exports: { autoUpdater: new EventEmitter() },
    } as never;
    t.after(() => {
      if (previous) require.cache[key] = previous;
      else delete require.cache[key];
    });
    for (const code of [2, 23]) {
      const installer = path.join(dir, `installer-${code}.sh`),
        marker = path.join(dir, `exit-${code}.txt`);
      await fs.writeFile(
        installer,
        `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(marker)}\nexit ${code}\n`,
        { mode: 0o755 },
      );
      let quits = 0,
        errors = 0;
      const native = new electronUpdater.NsisUpdater(null, {
        version: '0.14.18',
        name: 'pi-update-exit-test',
        isPackaged: true,
        appUpdateConfigPath: path.join(dir, 'app-update.yml'),
        userDataPath: dir,
        baseCachePath: dir,
        whenReady: async () => {},
        relaunch: () => {},
        quit: () => {
          quits++;
        },
        onQuit: () => {},
      });
      native.logger = null;
      Object.assign(native, { downloadedUpdateHelper: { file: installer, downloadedFileInfo: {} } });
      const driver = nativeUpdateDriver(native);
      driver.subscribe((event) => {
        if (event.type === 'error') errors++;
      });
      const service = new UpdateService({
        currentVersion: '0.14.18',
        installation: 'nsis',
        enabled: true,
        autoDownload: false,
        driver,
        recordAttempt: (value) => file.record(value),
        busy: () => false,
        beforeInstall: async () => {},
        installFailed: () => {},
      });
      t.after(() => service.dispose());
      native.emit('update-downloaded', {
        version: '0.14.19',
        downloadedFile: installer,
        files: [],
        path: installer,
        sha512: 'fixture',
        releaseDate: new Date().toISOString(),
      });
      await service.install();
      // macOS can take over a second to start a newly written executable. This
      // checks launch/result semantics, not scheduler or platform scan latency.
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        if (quits && (await fs.stat(marker).catch(() => undefined))) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.equal(quits, 1);
      assert.deepEqual((await fs.readFile(marker, 'utf8')).trim().split('\n'), ['--updated', '--force-run']);
      assert.equal(errors, 0, 'native updater cannot confirm a child installer exit result');
      assert.equal(service.state.lastInstall?.outcome, 'pending');
      assert.equal((await file.read('0.14.18'))?.outcome, 'unconfirmed');
    }
  },
);
