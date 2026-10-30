import { _electron as electron } from 'playwright';
import { expect } from 'playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../electron/store.ts';
import { emptyRuntime } from '../shared/types.ts';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-update-ui-'));
const store = new Store(dir);
await store.load();
const session = store.createSession();
Object.assign(store.state.settings, {
  piPath: path.resolve('tests/support/fixture-pi.mjs'),
  nodePath: process.execPath,
  agentDir: dir,
  provider: 'fixture',
  modelId: 'test',
  onboardingDone: true,
  autoDownloadUpdates: true,
});
await store.save();
let app, page;
const errors = [];
const launch = async () => {
  app = await electron.launch({
    executablePath: process.env.PI_DESKTOP_EXE,
    args: process.env.PI_DESKTOP_EXE ? [] : [path.resolve('.')],
    env: { ...process.env, PI_DESKTOP_DATA_DIR: dir, PI_OFFLINE: '1' },
  });
  page = await app.firstWindow();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  page.setDefaultTimeout(30000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.getByRole('textbox', { name: '任务输入' }).waitFor();
};
const about = async () => {
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '关于与更新', exact: true }).click();
  return page.getByRole('region', { name: '关于与更新' });
};
const update = async (patch, runtime) => {
  await app.evaluate(
    ({ BrowserWindow }, { patch, runtime }) => {
      globalThis.updateUiFixture.update = { ...globalThis.updateUiFixture.update, ...patch };
      const contents = BrowserWindow.getAllWindows()[0].webContents;
      contents.send('desktop:event', { type: 'update', update: globalThis.updateUiFixture.update });
      if (runtime)
        contents.send('desktop:event', {
          type: 'runtimePatch',
          patch: { ...runtime, messagesFrom: 0, messageCount: 0, toolsFrom: 0, toolCount: 0 },
        });
    },
    { patch, runtime },
  );
};
try {
  await launch();
  assert.equal((await page.evaluate(() => window.desktop.invoke('bootstrap'))).update.enabled, false);
  await app.evaluate(({ session }) => {
    globalThis.updateUiNetwork = [];
    session.defaultSession.webRequest.onBeforeRequest(
      { urls: ['http://*/*', 'https://*/*'] },
      (request, callback) => {
        globalThis.updateUiNetwork.push(request.url);
        callback({ cancel: true });
      },
    );
  });
  await page.evaluate(() => window.desktop.invoke('checkUpdate'));
  const disabled = await about();
  assert.equal(await disabled.getByRole('button', { name: '检查更新', exact: true }).isDisabled(), true);
  assert.match(await disabled.innerText(), /开发和测试环境不检查更新/);
  await page.getByRole('button', { name: '关闭', exact: true }).last().click();
  console.log('PASS development/test environment disables update checks in both UI and IPC');

  // Only update state and external-link actions are mocked. Settings and draft saves use real IPC.
  await app.evaluate(({ ipcMain }) => {
    const handler = ipcMain._invokeHandlers.get('desktop:invoke');
    globalThis.updateUiFixture = {
      update: {
        state: 'available',
        currentVersion: '0.9.0',
        installation: 'portable',
        mode: 'notify',
        enabled: true,
        installing: false,
        version: '0.9.1',
        notes: '# 更新验证\n\n**保留草稿**与会话。',
      },
      links: [],
      installs: 0,
    };
    ipcMain.removeHandler('desktop:invoke');
    ipcMain.handle('desktop:invoke', async (event, method, args) => {
      if (method === 'openLink') {
        globalThis.updateUiFixture.links.push(args[0]);
        return;
      }
      if (method === 'installUpdate') {
        globalThis.updateUiFixture.installs++;
        return;
      }
      const result = await handler(event, method, args);
      return method === 'bootstrap' ? { ...result, update: globalThis.updateUiFixture.update } : result;
    });
  });
  await page.reload();
  for (const installation of ['portable', 'deb']) {
    await update({ installation });
    await page.getByRole('button', { name: 'v0.9.1 可用', exact: true }).click();
    await page.getByRole('heading', { name: '更新验证', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '立即重启', exact: true }).count(), 0);
    if (installation === 'portable')
      assert.match(await page.locator('.modal').innerText(), /安装版可在应用内自动更新/);
    await page.getByRole('button', { name: '前往下载', exact: true }).click();
    await page.getByRole('button', { name: '稍后', exact: true }).click();
  }
  assert.deepEqual(
    await app.evaluate(() => globalThis.updateUiFixture.links),
    Array(2).fill('https://github.com/yeyuProject/pi-desktop-gui/releases/tag/v0.9.1'),
  );
  console.log('PASS portable/deb notification-only actions and correct release links');

  const size = 122183449;
  const baseDownload = { transferred: 0, total: 0, differential: false, stalled: false, phase: 'connecting' };
  await fs.mkdir('test-results', { recursive: true });
  await update({ installation: 'nsis', mode: 'auto', state: 'available', size });
  const progressPanel = await about();
  await expect(progressPanel.getByText('安装包 116.5 MB', { exact: true })).toBeVisible();
  await expect(progressPanel.getByRole('button', { name: '下载更新', exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/update-progress-available.png' });
  await page
    .getByRole('dialog', { name: '设置', exact: true })
    .locator(':scope > footer')
    .getByRole('button', { name: '关闭', exact: true })
    .click();
  await page.getByRole('button', { name: 'v0.9.1 可用', exact: true }).click();
  const progressDialog = page.getByRole('dialog', { name: 'Pi Desktop v0.9.1', exact: true });
  await expect(progressDialog.getByText('安装包 116.5 MB', { exact: true })).toBeVisible();
  await update({ size: undefined });
  await expect(progressDialog.locator('.update-package-size')).toHaveCount(0);
  await update({ state: 'downloading', size, progress: 0, download: baseDownload });
  const progress = progressDialog.getByRole('progressbar', { name: '更新下载进度' });
  await expect(progressDialog.getByText('正在连接…', { exact: true })).toBeVisible();
  assert.equal(await progress.getAttribute('value'), null);
  assert.equal(await progress.evaluate((node) => getComputedStyle(node).appearance), 'none');
  await expect(page.locator('.update-announcement[role=status]')).toHaveCount(1);
  await page.evaluate(() => {
    window.progressAnnouncements = [];
    const status = document.querySelector('.update-announcement');
    window.progressObserver = new MutationObserver(() =>
      window.progressAnnouncements.push(status.textContent),
    );
    window.progressObserver.observe(status, { childList: true, characterData: true, subtree: true });
  });
  await update({
    progress: 1,
    download: { ...baseDownload, phase: 'transferring', total: size, transferred: 1024 },
  });
  await expect(progressDialog).toContainText('正在估算…');
  const download = {
    ...baseDownload,
    phase: 'transferring',
    transferred: Math.round(38.2 * 1024 ** 2),
    total: size,
    bytesPerSecond: 4.3 * 1024 ** 2,
    remainingMs: 18000,
  };
  await update({ progress: (download.transferred / size) * 100, download });
  await expect(progressDialog).toContainText('38.2 MB / 116.5 MB · 4.3 MB/s · 剩余约 20 秒');
  await expect(progress).toHaveAttribute('aria-valuetext', '已下载 38.2 MB，共 116.5 MB，剩余约 20 秒');
  await expect(page.locator('.update-badge')).toContainText('剩余约 20 秒');
  assert.equal(await progressDialog.locator('.update-download-detail').getAttribute('aria-live'), null);
  for (let tick = 1; tick <= 3; tick++)
    await update({
      progress: 33 + tick,
      download: { ...download, transferred: download.transferred + tick * 1024 },
    });
  assert.deepEqual(
    await page.evaluate(() => window.progressAnnouncements),
    [],
    'byte/ETA changes are not live announcements',
  );
  await update({ progress: (download.transferred / size) * 100, download });
  await page.screenshot({ path: 'test-results/update-progress-downloading.png' });
  const differential = {
    ...download,
    transferred: 0.4 * 1024 ** 2,
    total: 1.1 * 1024 ** 2,
    differential: true,
    bytesPerSecond: 1.2 * 1024 ** 2,
    remainingMs: 1000,
  };
  await update({ progress: (differential.transferred / differential.total) * 100, download: differential });
  await expect(progressDialog).toContainText('0.4 MB / 1.1 MB');
  await expect(progressDialog).toContainText('增量更新：安装包 116.5 MB，只需下载变化部分');
  await page.screenshot({ path: 'test-results/update-progress-differential.png' });
  // Falling back to a full package may reset the percentage, but keeps no old speed or differential label.
  await update({ progress: 0, download: { ...baseDownload, phase: 'transferring', total: size } });
  await expect(progressDialog).toContainText('0.0 MB / 116.5 MB · 正在估算…');
  await expect(progressDialog).not.toContainText('增量更新');
  await update({
    progress: (download.transferred / size) * 100,
    download: { ...download, stalled: true, bytesPerSecond: undefined, remainingMs: undefined },
  });
  await expect(progressDialog).toContainText('等待网络响应…');
  await expect(progressDialog).not.toContainText('剩余约');
  await expect.poll(() => page.evaluate(() => window.progressAnnouncements)).toEqual(['等待网络响应…']);
  await page.screenshot({ path: 'test-results/update-progress-stalled.png' });
  await update({
    progress: ((download.transferred + 2048) / size) * 100,
    download: { ...download, transferred: download.transferred + 2048 },
  });
  await expect(progressDialog).toContainText('4.3 MB/s');
  await update({
    progress: 100,
    download: { ...baseDownload, total: size, transferred: size, phase: 'verifying' },
  });
  await expect(progressDialog.getByText('正在校验更新…', { exact: true })).toBeVisible();
  assert.equal(await progress.getAttribute('value'), null);
  await expect(progressDialog).not.toContainText('MB/s');
  await expect(progressDialog).not.toContainText('剩余');
  await page.screenshot({ path: 'test-results/update-progress-verifying.png' });
  await update({ installation: 'mac' });
  await expect(progressDialog).toContainText('正在校验并准备更新…');
  await expect(page.locator('.update-badge')).toHaveText('正在校验更新…');
  await update({ state: 'ready', download: undefined });
  await expect(progressDialog.getByRole('button', { name: '立即重启', exact: true })).toBeVisible();
  await update({ state: 'error', error: '下载文件校验失败，已取消安装。请重试下载。' });
  await expect(progressDialog.getByRole('button', { name: '重试下载', exact: true })).toBeVisible();
  await expect(progressDialog.locator('.update-progress')).toHaveCount(0);
  await expect(page.locator('.update-announcement')).toHaveText('下载文件校验失败，已取消安装。请重试下载。');
  await expect(progressDialog.getByRole('alert')).toHaveCount(0);
  assert.deepEqual(await page.evaluate(() => window.progressAnnouncements), [
    '等待网络响应…',
    '开始下载更新。',
    '正在校验更新…',
    '正在校验并准备更新…',
    '更新已下载，可以重启安装。',
    '下载文件校验失败，已取消安装。请重试下载。',
  ]);
  await page.evaluate(() => window.progressObserver.disconnect());
  await progressDialog.getByRole('button', { name: '稍后', exact: true }).click();
  await update({ installation: 'nsis', state: 'downloading', progress: 42, error: undefined, download });
  await page.evaluate(() => window.desktop.invoke('saveSettings', { sidebarWidth: 180 }));
  await expect
    .poll(() => page.locator('.sidebar').evaluate((node) => node.getBoundingClientRect().width))
    .toBe(180);
  for (const [uiStyle, theme] of [
    ['classic', 'light'],
    ['classic', 'dark'],
    ['codex', 'light'],
    ['codex', 'dark'],
    ['claude', 'light'],
    ['claude', 'dark'],
  ]) {
    await page.evaluate((appearance) => window.desktop.invoke('saveSettings', appearance), {
      uiStyle,
      theme,
    });
    await expect
      .poll(() =>
        page.evaluate(() => ({
          style: document.documentElement.dataset.style,
          theme: document.documentElement.dataset.theme,
        })),
      )
      .toEqual({ style: uiStyle, theme });
    await expect(page.locator('.update-badge')).toContainText('剩余约 20 秒');
    const bounds = await page.locator('.update-badge').evaluate((node) => ({
      scroll: node.scrollWidth,
      width: node.clientWidth,
      sidebar: document.querySelector('.sidebar').getBoundingClientRect().width,
    }));
    assert.equal(bounds.sidebar, 180);
    assert.ok(bounds.scroll <= bounds.width, `${uiStyle}/${theme}: narrow update badge overflows`);
    const panel = await about();
    await expect(panel).toContainText('38.2 MB / 116.5 MB · 4.3 MB/s · 剩余约 20 秒');
    await expect(panel.getByRole('progressbar')).toHaveAttribute(
      'aria-valuetext',
      '已下载 38.2 MB，共 116.5 MB，剩余约 20 秒',
    );
    await page
      .getByRole('dialog', { name: '设置', exact: true })
      .locator(':scope > footer')
      .getByRole('button', { name: '关闭', exact: true })
      .click();
  }
  await page.evaluate(() =>
    window.desktop.invoke('saveSettings', { sidebarWidth: 240, uiStyle: 'classic', theme: 'light' }),
  );
  await update({ state: 'available', download: undefined, size: undefined });
  console.log(
    'PASS U2 package size, shared progress, estimates, differential fallback, waiting/verification, live announcements and narrow sidebar in all three styles',
  );

  await update({
    installation: 'nsis',
    mode: 'auto',
    state: 'error',
    version: undefined,
    error: '无法完成更新，请检查网络后重试，也可前往版本页面手动下载。',
  });
  await page.locator('.update-badge').waitFor({ state: 'hidden' });
  await page.locator('.modal').waitFor({ state: 'hidden' });
  const panel = await about();
  await expect(panel.locator('.inline-error')).toHaveText(
    '无法完成更新，请检查网络后重试，也可前往版本页面手动下载。',
  );
  await panel.getByRole('button', { name: '前往下载', exact: true }).click();
  assert.equal(
    (await app.evaluate(() => globalThis.updateUiFixture.links)).at(-1),
    'https://github.com/yeyuProject/pi-desktop-gui/releases',
  );
  const auto = panel.getByRole('checkbox', { name: /自动下载更新/ });
  await auto.click();
  await expect
    .poll(
      () =>
        page.evaluate(
          async () => (await window.desktop.invoke('bootstrap')).state.settings.autoDownloadUpdates,
        ),
      { timeout: 30000 },
    )
    .toBe(false);
  await page.waitForFunction(() => !document.querySelector('.about-updates input[type=checkbox]').checked);
  await auto.click();
  await expect
    .poll(
      () =>
        page.evaluate(
          async () => (await window.desktop.invoke('bootstrap')).state.settings.autoDownloadUpdates,
        ),
      { timeout: 30000 },
    )
    .toBe(true);
  await update({
    state: 'downloading',
    version: '0.9.1',
    progress: 42,
    error: undefined,
    download: {
      transferred: 42 * 1024 ** 2,
      total: 100 * 1024 ** 2,
      differential: false,
      stalled: false,
      phase: 'transferring',
    },
  });
  await panel.getByText('42%', { exact: true }).waitFor();
  assert.equal(await panel.getByRole('progressbar').getAttribute('value'), '42');
  await page.getByRole('button', { name: '关闭', exact: true }).last().click();
  console.log('PASS quiet offline failure, manual fallback link, persisted download preference and progress');

  await update({
    state: 'idle',
    download: undefined,
    version: undefined,
    error: undefined,
    lastInstall: {
      currentVersion: '0.9.0',
      targetVersion: '0.9.1',
      startedAt: Date.now(),
      outcome: 'unconfirmed',
    },
  });
  await page.getByRole('button', { name: '上次更新结果待确认', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '尚未确认更新完成' }).waitFor();
  assert.equal(await page.getByRole('button', { name: '重新检查', exact: true }).isEnabled(), true);
  await page.getByRole('button', { name: '前往下载', exact: true }).click();
  assert.equal(
    (await app.evaluate(() => globalThis.updateUiFixture.links)).at(-1),
    'https://github.com/yeyuProject/pi-desktop-gui/releases/tag/v0.9.1',
  );
  await page.getByRole('button', { name: '稍后', exact: true }).click();
  console.log('PASS an unchanged version shows an unconfirmed update and the target installer download');

  const runtime = { ...emptyRuntime(), sessionId: session.id, connected: true, status: 'running' };
  await update(
    { installation: 'mac', state: 'ready', version: '0.9.1', progress: 100, lastInstall: undefined },
    runtime,
  );
  await page.getByRole('button', { name: '重启以更新到 v0.9.1', exact: true }).click();
  const restart = page.getByRole('button', { name: '立即重启', exact: true });
  assert.equal(await restart.isDisabled(), true);
  await update(
    {},
    { ...runtime, status: 'idle', dialogs: [{ id: 'pending', method: 'confirm', title: '确认工具执行' }] },
  );
  assert.equal(await restart.isDisabled(), true);
  await update({}, { ...runtime, status: 'idle' });
  await page.waitForFunction(() =>
    [...document.querySelectorAll('button')].some(
      (button) => button.textContent === '立即重启' && !button.disabled,
    ),
  );
  await page.getByRole('button', { name: '稍后', exact: true }).click();
  await page.getByRole('textbox', { name: '任务输入' }).fill('重启前最后编辑的草稿');
  await page.getByRole('button', { name: '重启以更新到 v0.9.1', exact: true }).click();
  await restart.click();
  await expect
    .poll(() => app.evaluate(() => globalThis.updateUiFixture.installs), { timeout: 30000 })
    .toBe(1);
  const savedBeforeRestart = JSON.parse(await fs.readFile(path.join(dir, 'state.json'), 'utf8'));
  assert.equal(
    savedBeforeRestart.sessions.find((item) => item.id === session.id)?.draft,
    '重启前最后编辑的草稿',
  );
  assert.deepEqual(await app.evaluate(() => globalThis.updateUiNetwork), []);
  console.log('PASS task/approval block restart, and the restart action saves the latest draft');
  await fs.mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/update-ready.png' });
  await app.close();
  app = undefined;

  const newer = JSON.stringify({ version: 3, appVersion: '0.10.0', futureData: 'must stay intact' });
  await fs.writeFile(path.join(dir, 'state.json'), newer);
  await launch();
  await page.getByLabel('本地数据状态').waitFor();
  assert.match(await page.getByLabel('本地数据状态').innerText(), /v0.10.0.*只读/s);
  assert.equal(await page.getByRole('button', { name: '发送任务', exact: true }).isDisabled(), true);
  await page.locator('.thread').hover();
  await about();
  await app.close();
  app = undefined;
  assert.equal(await fs.readFile(path.join(dir, 'state.json'), 'utf8'), newer);
  assert.deepEqual(errors, []);
  console.log('PASS newer unknown schema stays read-only across startup, settings and shutdown');
} catch (error) {
  if (page && !page.isClosed()) {
    await fs.mkdir('test-results', { recursive: true });
    await page.screenshot({ path: 'test-results/update-ui-failure.png' });
  }
  throw error;
} finally {
  if (app) await app.close();
  await fs.rm(dir, { recursive: true, force: true });
}
