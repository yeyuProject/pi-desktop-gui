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
import { nativeUpdateDriver, release } from '../electron/update-driver';
import { UpdateProgress } from '../electron/update-progress';
import { EventEmitter } from 'node:events';
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

test('release metadata selects the signed platform package, including the exact Mac architecture', () => {
  const info = {
    version: '0.14.59',
    files: [
      { url: 'Pi-Desktop-mac-arm64.dmg', size: 111 },
      { url: 'Pi-Desktop-mac-x64.zip', size: 222 },
      { url: 'Pi-Desktop-linux.deb', size: 333 },
      { url: 'Pi-Desktop-win-setup.exe', size: 444 },
      { url: 'Pi-Desktop-mac-arm64.zip', size: 555 },
      { url: 'Pi-Desktop-linux.AppImage', size: 666 },
    ],
  };
  assert.equal(release(info, 'win32').size, 444);
  assert.equal(release(info, 'linux').size, 666);
  assert.equal(release(info, 'darwin', 'x64').size, 222);
  assert.equal(release(info, 'darwin', 'arm64').size, 555);
  assert.equal(release(info, 'darwin', 'ia32').size, undefined);
  assert.equal(release({ version: info.version }, 'win32').size, undefined);
  assert.equal(release({ ...info, files: [{ url: 'unknown.zip', size: 10 }] }, 'win32').size, undefined);
  for (const size of [0, -1, NaN, Infinity, 1.5])
    assert.equal(release({ ...info, files: [{ url: 'app.exe', size }] }, 'win32').size, undefined);
});

test('native progress forwards byte counts and discards the library lifetime average', () => {
  const updater = new EventEmitter();
  const driver = nativeUpdateDriver(updater as Parameters<typeof nativeUpdateDriver>[0]);
  const events: UpdateDriverEvent[] = [];
  const unsubscribe = driver.subscribe((event) => events.push(event));
  updater.emit('download-progress', { percent: 25, transferred: 256, total: 1024, bytesPerSecond: 9999999 });
  assert.deepEqual(events, [{ type: 'progress', percent: 25, transferred: 256, total: 1024 }]);
  unsubscribe();
  updater.emit('download-progress', { percent: 50, transferred: 512, total: 1024 });
  assert.equal(events.length, 1);
});

test('progress measures the trailing five seconds, warms up and limits displayed estimates to once a second', () => {
  let now = 0;
  const mb = 1024 ** 2,
    sample = new UpdateProgress(100 * mb, () => now);
  assert.equal(sample.read().phase, 'connecting');
  for (let second = 1; second <= 8; second++) {
    now = second * 1000;
    sample.progress(second * mb, 100 * mb);
    const state = sample.read();
    if (second < 3) assert.equal(state.bytesPerSecond, undefined);
    else assert.equal(state.bytesPerSecond, mb);
  }
  now = 9000;
  sample.progress(10 * mb, 100 * mb);
  assert.equal(sample.read().bytesPerSecond, 1.2 * mb);
  const estimate = sample.read().remainingMs;
  now = 9500;
  sample.progress(11 * mb, 100 * mb);
  assert.equal(sample.read().remainingMs, estimate, 'sub-second byte events must not change the estimate');
  now = 10000;
  sample.progress(12 * mb, 100 * mb);
  assert.equal(sample.read().bytesPerSecond, 1.4 * mb);
  assert.equal(sample.read().remainingMs, (88 / 1.4) * 1000);
  const small = new UpdateProgress(1024 ** 2, () => now);
  now += 4000;
  small.progress(255 * 1024, mb);
  assert.equal(small.read().bytesPerSecond, undefined, 'less than 256 KB in the window remains an estimate');
});

test('differential progress resets cleanly when falling back to the full package or restarting its byte count', () => {
  let now = 0;
  const mb = 1024 ** 2,
    sample = new UpdateProgress(100 * mb, () => now);
  now = 4000;
  sample.progress(0.4 * mb, mb);
  assert.equal(sample.read().differential, true);
  now = 5000;
  sample.progress(0, 100 * mb);
  assert.deepEqual(sample.read(), {
    transferred: 0,
    total: 100 * mb,
    differential: false,
    phase: 'transferring',
    stalled: false,
    bytesPerSecond: undefined,
    remainingMs: undefined,
  });
  now = 8000;
  sample.progress(3 * mb, 100 * mb);
  assert.equal(sample.read().bytesPerSecond, mb);
  now = 9000;
  sample.progress(0, 100 * mb);
  assert.equal(sample.read().bytesPerSecond, undefined);
  assert.equal(new UpdateProgress(100 * mb, () => now).progress(NaN, 100 * mb), false);
  sample.progress(120 * mb, 100 * mb);
  assert.equal(sample.read().phase, 'verifying');
  assert.equal(sample.read().transferred, 100 * mb);
  assert.equal(sample.read().remainingMs, undefined);
  const threshold = new UpdateProgress(100 * mb, () => now);
  threshold.progress(0, 99 * mb);
  assert.equal(threshold.read().differential, false, 'a one-percent difference is not differential');
});

test('timer ticks between slightly delayed byte events do not understate a steady transfer rate', () => {
  let now = 0;
  const mb = 1024 ** 2,
    sample = new UpdateProgress(100 * mb, () => now);
  const events: { time: number; bytes?: number }[] = [];
  for (let tick = 1; tick <= 100; tick++) {
    events.push({ time: tick * 1000 });
    events.push({ time: tick * 1090, bytes: tick * 1.09 * mb });
  }
  events.sort((left, right) => left.time - right.time);
  for (const event of events) {
    now = event.time;
    if (event.bytes !== undefined) sample.progress(event.bytes, 100 * mb);
    const progress = sample.read();
    if (now < 10000 || now >= 95000) continue;
    assert.ok(
      progress.bytesPerSecond! >= 0.95 * mb && progress.bytesPerSecond! <= 1.05 * mb,
      `steady byte events measured as ${progress.bytesPerSecond! / mb} MB/s at ${now} ms`,
    );
    const actualRemaining = 100000 - now;
    assert.ok(
      Math.abs(progress.remainingMs! - actualRemaining) / actualRemaining <= 0.2,
      `ETA ${progress.remainingMs} vs actual remaining ${actualRemaining} at ${now} ms`,
    );
  }
});

test('the main-process timer detects a silent network, recovers within two seconds and stops after completion or disposal', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let now = 0,
    publications = 0;
  const mb = 1024 ** 2,
    driver = new Driver();
  driver.check = async () => {
    driver.listener?.({ type: 'available', release: { version: '0.10.0', notes: '', size: 30 * mb } });
  };
  driver.download = async () => {};
  const service = new UpdateService({ ...options(driver), now: () => now });
  t.after(() => service.dispose());
  service.on('update', () => publications++);
  await service.check();
  await service.download();
  assert.equal(service.state.download?.phase, 'connecting');
  for (let second = 1; second <= 5; second++) {
    now += 1000;
    driver.listener?.({ type: 'progress', transferred: second * mb, total: 30 * mb, percent: -500 });
    t.mock.timers.tick(1000);
  }
  assert.equal(service.state.progress, (5 / 30) * 100);
  assert.equal(service.state.download?.bytesPerSecond, mb);
  now += 9999;
  t.mock.timers.tick(9999);
  assert.equal(service.state.download?.stalled, false);
  now += 1;
  t.mock.timers.tick(1);
  assert.equal(service.state.download?.stalled, true);
  assert.equal(service.state.download?.remainingMs, undefined);
  now += 2000;
  t.mock.timers.tick(2000);
  driver.listener?.({ type: 'progress', transferred: 6 * mb, total: 30 * mb, percent: 20 });
  assert.equal(service.state.download?.stalled, false);
  now += 1000;
  driver.listener?.({ type: 'progress', transferred: 7 * mb, total: 30 * mb, percent: 23 });
  t.mock.timers.tick(1000);
  assert.equal(service.state.download?.bytesPerSecond, mb);
  driver.listener?.({ type: 'progress', transferred: 30 * mb, total: 30 * mb, percent: 100 });
  assert.equal(service.state.download?.phase, 'verifying');
  now += 12000;
  t.mock.timers.tick(12000);
  assert.equal(service.state.download?.stalled, false);
  driver.listener?.({ type: 'downloaded', release: { version: '0.10.0', notes: '', size: 30 * mb } });
  assert.equal(service.state.download, undefined);
  const completed = publications;
  now += 12000;
  t.mock.timers.tick(12000);
  assert.equal(publications, completed);
  driver.listener?.({ type: 'error', error: new Error('retry fixture') });
  await service.download();
  assert.equal(structuredClone(service.state).download?.phase, 'connecting');
  assert.equal(structuredClone(service.state).download?.bytesPerSecond, undefined);
  service.dispose();
  const disposed = publications;
  now += 12000;
  t.mock.timers.tick(12000);
  assert.equal(publications, disposed);
});

test('a timer just before the second recovery report cannot postpone the first speed estimate', () => {
  let now = 0;
  const mb = 1024 ** 2,
    sample = new UpdateProgress(100 * mb, () => now);
  now = 4000;
  sample.progress(4 * mb, 100 * mb);
  assert.equal(sample.read().bytesPerSecond, mb);
  now = 15000;
  assert.equal(sample.read().stalled, true);
  now = 15005;
  sample.progress(5 * mb, 100 * mb);
  assert.equal(sample.read().bytesPerSecond, undefined);
  now = 16006;
  assert.equal(sample.read().bytesPerSecond, undefined);
  now = 16080;
  sample.progress(6.075 * mb, 100 * mb);
  assert.ok(sample.read().bytesPerSecond, 'speed must return on the second report within two seconds');
});

test('auto-download starts sampling before progress and errors clear all download estimates before retry', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let now = 0,
    publications = 0;
  const driver = new Driver();
  driver.download = async () => {};
  const service = new UpdateService({ ...options(driver), autoDownload: true, now: () => now });
  service.on('update', () => publications++);
  t.after(() => service.dispose());
  await service.check();
  assert.equal(service.state.download?.phase, 'connecting');
  now = 4000;
  driver.listener?.({ type: 'progress', total: 1024 ** 2, transferred: 512 * 1024, percent: 50 });
  assert.ok(service.state.download?.bytesPerSecond);
  driver.listener?.({ type: 'error', error: new Error('network error') });
  assert.equal(service.state.state, 'error');
  assert.equal(service.state.download, undefined);
  const failed = publications;
  now += 12000;
  t.mock.timers.tick(12000);
  assert.equal(publications, failed, 'failed downloads stop the progress timer');
  driver.listener?.({ type: 'progress', total: 1024 ** 2, transferred: 900 * 1024, percent: 90 });
  assert.equal(service.state.state, 'error', 'late byte events cannot resurrect a failed download');
  await service.download();
  assert.equal(service.state.progress, 0);
  assert.equal(structuredClone(service.state).download?.bytesPerSecond, undefined);
  driver.listener?.({ type: 'not-available' });
  assert.equal(service.state.download, undefined);
  assert.equal(service.state.size, undefined);
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
  let resolve!: (value: { version: string; notes: string; size: number }) => void;
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
  resolve({ version: '0.10.0', notes: '新功能', size: 122183449 });
  await first;
  assert.equal(service.state.state, 'available');
  assert.equal(service.state.notes, '新功能');
  assert.equal(service.state.size, 122183449, 'notification-only updates retain the signed package size');
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
