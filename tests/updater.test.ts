import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import electronUpdater from 'electron-updater';
import {
  UpdateService,
  updateInstallation,
  updateError,
  fetchLatestRelease,
  type UpdateDriver,
  type UpdateDriverEvent,
  type UpdateOptions,
} from '../electron/updater';
import { nativeUpdateDriver } from '../electron/update-driver';
import { compareAppVersions, stableVersion, releaseUrl, updateInstallNotice } from '../shared/app-update';
import { AgentService } from '../electron/agent';

class Driver implements UpdateDriver {
  listener?: (event: UpdateDriverEvent) => void;
  checks = 0;
  downloads = 0;
  installs = 0;
  autoDownload = true;
  installOnQuit = true;
  subscribe(listener: (event: UpdateDriverEvent) => void) {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }
  configure(auto: boolean, install: boolean) {
    this.autoDownload = auto;
    this.installOnQuit = install;
  }
  async check() {
    this.checks++;
    this.listener?.({ type: 'available', release: { version: '0.10.0', notes: '测试说明' } });
  }
  async download() {
    this.downloads++;
    this.listener?.({ type: 'downloaded', release: { version: '0.10.0', notes: '测试说明' } });
  }
  install() {
    this.installs++;
  }
}
const options = (driver?: Driver): UpdateOptions => ({
  currentVersion: '0.9.0',
  installation: driver ? 'nsis' : 'portable',
  enabled: true,
  autoDownload: false,
  driver,
  busy: () => false,
  beforeInstall: async () => {},
  installFailed: () => {},
});
test('installation policy distinguishes automatic and notification-only targets', () => {
  assert.equal(updateInstallation('win32', true, {}), 'nsis');
  assert.equal(updateInstallation('win32', true, { PORTABLE_EXECUTABLE_DIR: 'C:/Temp' }), 'portable');
  assert.equal(updateInstallation('linux', true, { APPIMAGE: '/tmp/app.AppImage' }), 'appimage');
  assert.equal(updateInstallation('linux', true, {}), 'deb');
  assert.equal(updateInstallation('darwin', true, {}), 'mac');
  assert.equal(updateInstallation('win32', false, {}), 'development');
  assert.equal(compareAppVersions('0.10.0', '0.9.1'), 1);
  assert.equal(compareAppVersions('0.9.10', '0.9.9'), 1);
  assert.equal(compareAppVersions('1.0.0', '1.0.0'), 0);
  for (const value of ['0.9.1-beta.1', '09.0.0', 'next', '../other'])
    assert.equal(stableVersion(value), undefined);
  assert.match(releaseUrl('0.10.0'), /\/tag\/v0\.10\.0$/);
});
test('disabled environments make no network requests even when called manually', async (t) => {
  let calls = 0;
  const service = new UpdateService({
    ...options(),
    enabled: false,
    fetchRelease: async () => {
      calls++;
      return undefined;
    },
  });
  t.after(() => service.dispose());
  service.start();
  await service.check();
  await service.download();
  await assert.rejects(service.install(), /尚未下载完成/);
  assert.equal(calls, 0);
});
test('Mac updates download and wait for an acknowledged installer before completing restart', async (t) => {
  const driver = new Driver();
  let release!: () => void;
  driver.install = () =>
    new Promise<void>((resolve) => {
      release = resolve;
    });
  const service = new UpdateService({ ...options(driver), installation: 'mac' });
  t.after(() => service.dispose());
  assert.equal(service.state.mode, 'auto');
  await service.check();
  await service.download();
  let completed = false;
  const installing = service.install().then(() => {
    completed = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(completed, false);
  release();
  await installing;
  assert.equal(completed, true);
});
test('normal quit never installs a downloaded update or starts an installer', async (t) => {
  const driver = new Driver();
  let busy = true,
    prepared = 0;
  const records: string[] = [];
  const service = new UpdateService({
    ...options(driver),
    installation: 'mac',
    busy: () => busy,
    recordAttempt: async (attempt) => {
      records.push(attempt.outcome);
    },
    driver: {
      ...driver,
      subscribe: driver.subscribe.bind(driver),
      check: driver.check.bind(driver),
      download: driver.download.bind(driver),
      configure: driver.configure.bind(driver),
      install: () => {},
      prepareForQuit: async () => {
        prepared++;
        throw new Error('installer unavailable');
      },
    },
  });
  t.after(() => service.dispose());
  await service.check();
  await service.download();
  await service.prepareForQuit(true);
  assert.equal(prepared, 0);
  busy = false;
  await service.prepareForQuit(false);
  assert.equal(prepared, 0);
  await service.prepareForQuit(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(prepared, 0);
  assert.deepEqual(records, []);
});

test('startup waits ten seconds, periodic checks wait six hours, and manual checks are immediate', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let calls = 0;
  const service = new UpdateService({
    ...options(),
    fetchRelease: async () => {
      calls++;
      return undefined;
    },
  });
  t.after(() => service.dispose());
  service.start();
  t.mock.timers.tick(9999);
  assert.equal(calls, 0);
  t.mock.timers.tick(1);
  await service.check();
  assert.equal(calls, 1);
  t.mock.timers.tick(6 * 60 * 60 * 1000 - 1);
  assert.equal(calls, 1);
  t.mock.timers.tick(1);
  await service.check();
  assert.equal(calls, 2);
  await service.check();
  assert.equal(calls, 3);
  service.dispose();
  t.mock.timers.tick(6 * 60 * 60 * 1000);
  assert.equal(calls, 3);
});
test('checking is quiet on failure, deduplicates requests and can be retried', async (t) => {
  let resolve!: (value: { version: string; notes: string }) => void;
  let calls = 0;
  const service = new UpdateService({
    ...options(),
    fetchRelease: () => {
      calls++;
      return new Promise((done) => {
        resolve = done;
      });
    },
  });
  t.after(() => service.dispose());
  const first = service.check(),
    second = service.check();
  assert.equal(first, second);
  assert.equal(calls, 1);
  resolve({ version: '0.10.0', notes: '新功能' });
  await first;
  assert.equal(service.state.state, 'available');
  assert.equal(service.state.notes, '新功能');
  const offline = new UpdateService({
    ...options(),
    fetchRelease: async () => {
      throw new Error('offline');
    },
  });
  t.after(() => offline.dispose());
  await offline.check();
  assert.equal(offline.state.state, 'error');
  assert.match(offline.state.error!, /检查网络/);
});
test('missing native update configuration reports an incomplete package before networking', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-update-config-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const native = new electronUpdater.NsisUpdater(null, {
    version: '0.9.0',
    name: 'pi-update-config-test',
    isPackaged: true,
    appUpdateConfigPath: path.join(dir, 'app-update.yml'),
    userDataPath: dir,
    baseCachePath: dir,
    whenReady: async () => {},
    relaunch: () => assert.fail('must not relaunch'),
    quit: () => assert.fail('must not quit'),
    onQuit: () => assert.fail('must not register installation'),
  });
  native.logger = null;
  const driver = nativeUpdateDriver(native);
  let originalError: Error | undefined;
  driver.subscribe((event) => {
    if (event.type === 'error') originalError = event.error;
  });
  const service = new UpdateService({ ...options(), installation: 'nsis', driver });
  t.after(() => service.dispose());
  await service.check();
  assert.match(originalError!.message, /ENOENT.*app-update\.yml/);
  assert.equal(service.state.state, 'error');
  assert.equal(service.state.error, '当前程序缺少自动更新配置，请前往版本页面下载完整安装包。');
  assert.doesNotMatch(service.state.error!, /检查网络/);
  assert.match(updateError(new Error('ENOENT: missing another file')), /检查网络/);
});

test('manual download, preference changes and progress reach independent update state', async (t) => {
  const driver = new Driver(),
    service = new UpdateService(options(driver));
  t.after(() => service.dispose());
  await service.check();
  assert.equal(service.state.state, 'available');
  service.configure(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(driver.autoDownload, true);
  assert.equal(driver.downloads, 1);
  assert.equal(service.state.state, 'ready');
  await service.check();
  assert.equal(driver.checks, 1, 'a ready update is retained during subsequent checks');
  service.prepareForQuit(true);
  assert.equal(driver.installOnQuit, false);
});
test('install waits for preparation, rejects busy work and prevents concurrent installs', async (t) => {
  const driver = new Driver();
  let busy = true,
    prepared = false,
    unblock!: () => void;
  const service = new UpdateService({
    ...options(driver),
    busy: () => busy,
    beforeInstall: async () => {
      await new Promise<void>((resolve) => {
        unblock = resolve;
      });
      prepared = true;
    },
  });
  t.after(() => service.dispose());
  await service.check();
  await service.download();
  await assert.rejects(service.install(), /当前任务或审批/);
  service.prepareForQuit(true);
  assert.equal(driver.installOnQuit, false);
  busy = false;
  const installing = service.install();
  assert.equal(service.state.installing, true);
  assert.equal(driver.installs, 0);
  await service.install();
  unblock();
  await installing;
  assert.equal(prepared, true);
  assert.equal(driver.installs, 1);
});
test('failed preparation never starts the installer, and checksum errors forbid on-quit install', async (t) => {
  const driver = new Driver();
  let cancelled = false;
  const service = new UpdateService({
    ...options(driver),
    beforeInstall: async () => {
      throw new Error('草稿保存失败');
    },
    installFailed: () => {
      cancelled = true;
    },
  });
  t.after(() => service.dispose());
  await service.check();
  await service.download();
  await assert.rejects(service.install(), /草稿保存失败/);
  assert.equal(driver.installs, 0);
  assert.equal(service.state.installing, false);
  assert.equal(cancelled, true);
  driver.listener?.({ type: 'error', error: new Error('sha512 checksum mismatch') });
  service.prepareForQuit(true);
  assert.equal(driver.installOnQuit, false);
  assert.match(service.state.error!, /校验失败/);
});

test('accepted service operations block updates even before their runtime status changes', async (t) => {
  const agent = new AgentService({} as never, {} as never);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = (
    agent as unknown as { exclusive: (action: () => Promise<void>) => Promise<void> }
  ).exclusive(() => held);
  const driver = new Driver();
  const service = new UpdateService({ ...options(driver), busy: () => agent.hasPendingWork });
  t.after(() => {
    release();
    service.dispose();
  });
  assert.equal(agent.runtime.status, 'idle');
  assert.equal(agent.hasPendingWork, true);
  await service.check();
  await service.download();
  await assert.rejects(service.install(), /当前任务或审批/);
  assert.equal(driver.installs, 0);
  release();
  await pending;
  assert.equal(agent.hasPendingWork, false);
});
test('installer errors are recorded without incorrectly blaming the network', async (t) => {
  const driver = new Driver(),
    records: import('../shared/app-update').UpdateInstallAttempt[] = [];
  const service = new UpdateService({
    ...options(driver),
    recordAttempt: async (attempt) => {
      records.push(attempt);
    },
  });
  t.after(() => service.dispose());
  await service.check();
  await service.download();
  await service.install();
  driver.listener?.({ type: 'error', error: new Error('spawn installer EPERM') });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(service.state.installing, false);
  assert.equal(service.state.lastInstall?.outcome, 'failed');
  assert.deepEqual(
    records.map((attempt) => attempt.outcome),
    ['pending', 'failed'],
  );
  assert.match(service.state.error!, /安装程序/);
  assert.doesNotMatch(service.state.error!, /检查网络/);
  assert.match(updateInstallNotice(service.state)!, /无法启动更新安装程序/);
});
test('a receipt persistence failure prevents launching an unrecorded installer and permits retry', async (t) => {
  const driver = new Driver();
  let fail = true;
  const service = new UpdateService({
    ...options(driver),
    recordAttempt: async () => {
      if (fail) throw new Error('无法保存更新记录');
    },
  });
  t.after(() => service.dispose());
  await service.check();
  await service.download();
  await assert.rejects(service.install(), /无法保存更新记录/);
  assert.equal(driver.installs, 0);
  assert.equal(service.state.installing, false);
  fail = false;
  await service.install();
  assert.equal(driver.installs, 1);
});
test('an update error during the receipt write cancels the pending installation', async (t) => {
  const driver = new Driver();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const service = new UpdateService({ ...options(driver), recordAttempt: () => held });
  t.after(() => {
    release();
    service.dispose();
  });
  await service.check();
  await service.download();
  const installing = service.install();
  await new Promise((resolve) => setImmediate(resolve));
  driver.listener?.({ type: 'error', error: new Error('installer vanished') });
  release();
  await assert.rejects(installing, /更新状态已变化/);
  assert.equal(driver.installs, 0);
  assert.equal(service.state.installing, false);
});
test('the GitHub notifier reads stable release Markdown and rejects prereleases', async () => {
  const release = await fetchLatestRelease(async (url) => {
    assert.match(url, /^https:\/\/api.github.com\/repos\/yeyuProject\/pi-desktop-gui\/releases\/latest$/);
    return new Response(
      JSON.stringify({ tag_name: 'v0.10.0', body: '# 新功能', prerelease: false, draft: false }),
    );
  });
  assert.deepEqual(release, { version: '0.10.0', notes: '# 新功能' });
  assert.equal(
    await fetchLatestRelease(async () => new Response(JSON.stringify({ prerelease: true }))),
    undefined,
  );
});
