import { _electron as electron } from 'playwright';
import { expect } from 'playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../electron/store.ts';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-review-ui-'));
const store = new Store(dir);
await store.load();
store.createSession();
Object.assign(store.state.settings, {
  onboardingDone: true,
  piPath: path.resolve('tests/support/fixture-pi.mjs'),
  nodePath: process.execPath,
  agentDir: dir,
});
await store.save();
let app, page;
const errors = [],
  contrast = {};
async function launch() {
  app = await electron.launch({
    args: [path.resolve('.')],
    env: { ...process.env, PI_DESKTOP_DATA_DIR: dir, PI_OFFLINE: '1' },
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  page.on('pageerror', (e) => errors.push(e.message));
  await page.getByRole('textbox', { name: '任务输入' }).waitFor();
}
try {
  await launch();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
  await page.getByRole('tab', { name: '操作', exact: true }).click();
  await page.getByRole('textbox', { name: '搜索项目和会话' }).fill('设置');
  await page.getByRole('textbox', { name: '搜索项目和会话' }).press('Enter');
  await page.getByRole('dialog', { name: '设置', exact: true }).waitFor();
  await page.getByRole('button', { name: '外观与编辑器', exact: true }).click();
  await page.getByRole('textbox', { name: '更新代理', exact: true }).fill('http://127.0.0.1:7890');
  await page.getByRole('textbox', { name: '更新镜像目录', exact: true }).fill('https://mirror.example/pi/');
  await page.getByRole('checkbox', { name: '任务失败时发送系统通知', exact: true }).uncheck();
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  const settings = (await page.evaluate(() => window.desktop.invoke('bootstrap'))).state.settings;
  assert.equal(settings.updateProxy, 'http://127.0.0.1:7890');
  assert.equal(settings.updateMirror, 'https://mirror.example/pi/');
  assert.equal(settings.notifyOnError, false);
  assert.equal(settings.notifyOnApproval, true);
  await page.getByRole('button', { name: '诊断与数据', exact: true }).click();
  await page.getByRole('button', { name: '清除桌面本地数据…', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: '清除桌面本地数据并重启？', exact: true });
  await confirmation.waitFor();
  await expect(confirmation).toContainText('外部项目源码、Pi 外部历史和供应商登录凭据');
  await confirmation.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal((await page.evaluate(() => window.desktop.invoke('bootstrap'))).state.sessions.length, 1);
  await page.getByRole('button', { name: '关闭', exact: true }).last().click();
  for (const [uiStyle, theme] of [
    ...['light', 'sepia', 'green', 'dark', 'navy'].map((theme) => ['classic', theme]),
    ['codex', 'light'],
    ['codex', 'dark'],
  ]) {
    await page.evaluate((appearance) => window.desktop.invoke('saveSettings', appearance), {
      theme,
      uiStyle,
    });
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.style)).toBe(uiStyle);
    const key = `${uiStyle}-${theme}`;
    contrast[key] = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      const luminance = (hex) => {
        const c = hex
          .trim()
          .replace('#', '')
          .match(/../g)
          .map((x) => parseInt(x, 16) / 255)
          .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
        return c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;
      };
      const a = luminance(root.getPropertyValue('--warning')),
        b = luminance(root.getPropertyValue('--rail'));
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    });
    assert.ok(contrast[key] >= 4.5, `${key}: ${contrast[key]}`);
  }
  await app.evaluate(({ Menu }) =>
    Menu.getApplicationMenu()
      .getMenuItemById('view')
      .submenu.items.find((item) => item.label === '放大')
      .click(),
  );
  const zoom = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.getZoomFactor(),
  );
  assert.ok(zoom > 1);
  await app.close();
  app = undefined;
  await launch();
  await expect
    .poll(() =>
      app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomFactor()),
    )
    .toBe(zoom);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: 'test-results/review-ui.png' });
  await fs.writeFile(
    'test-results/review-ui.json',
    JSON.stringify({ passed: true, zoom, contrast }, null, 2),
  );
  console.log(
    'PASS command search, update network settings, separate notifications, clear-data cancellation, contrast and zoom persistence',
  );
} finally {
  await app?.close();
  await fs.rm(dir, { recursive: true, force: true });
}
