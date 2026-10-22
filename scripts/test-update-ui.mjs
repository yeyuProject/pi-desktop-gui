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
  await panel.getByRole('alert').waitFor();
  await panel.getByRole('button', { name: '前往下载', exact: true }).click();
  assert.equal(
    (await app.evaluate(() => globalThis.updateUiFixture.links)).at(-1),
    'https://github.com/yeyuProject/pi-desktop-gui/releases',
  );
  const auto = panel.getByRole('checkbox', { name: /自动下载更新/ });
  await auto.click();
  await expect
    .poll(() =>
      page.evaluate(
        async () => (await window.desktop.invoke('bootstrap')).state.settings.autoDownloadUpdates,
      ),
    )
    .toBe(false);
  await page.waitForFunction(() => !document.querySelector('.about-updates input[type=checkbox]').checked);
  await auto.click();
  await expect
    .poll(() =>
      page.evaluate(
        async () => (await window.desktop.invoke('bootstrap')).state.settings.autoDownloadUpdates,
      ),
    )
    .toBe(true);
  await update({ state: 'downloading', version: '0.9.1', progress: 42, error: undefined });
  await panel.getByText('正在下载 42%', { exact: true }).waitFor();
  assert.equal(await panel.getByRole('progressbar').getAttribute('value'), '42');
  await page.getByRole('button', { name: '关闭', exact: true }).last().click();
  console.log('PASS quiet offline failure, manual fallback link, persisted download preference and progress');

  await update({
    state: 'idle',
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
  await expect.poll(() => app.evaluate(() => globalThis.updateUiFixture.installs)).toBe(1);
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
