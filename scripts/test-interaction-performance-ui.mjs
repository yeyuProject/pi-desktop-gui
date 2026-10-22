import { _electron as electron, expect } from 'playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createLocalProvider, prepareRealPiFixture } from '../tests/support/local-provider.ts';

const provider = await createLocalProvider();
const fixture = await prepareRealPiFixture(provider.baseUrl, 'interaction-performance-ui');
await fs.writeFile(path.join(fixture.projectDir, 'delayed.txt'), 'attachment fixture');
let app, page;
const errors = [];
try {
  app = await electron.launch({
    args: [path.resolve('.')],
    timeout: 30000,
    env: { ...process.env, PI_DESKTOP_DATA_DIR: fixture.dataDir, PI_OFFLINE: '1' },
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(10000);
  page.on('pageerror', (error) => errors.push(error.message));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900));
  const input = page.getByRole('textbox', { name: '任务输入' });
  await input.waitFor();
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  await input.press(mod + '+k');
  const quick = page.getByRole('dialog', { name: '快速切换' });
  await expect(quick.getByRole('textbox', { name: '搜索项目和会话' })).toBeFocused();
  await page.keyboard.type('fixture');
  await expect(quick.getByRole('textbox')).toHaveValue('fixture');
  await page.keyboard.press('Escape');
  await expect(quick).toHaveCount(0);
  console.log('PASS quick switch immediately accepts typing and restores focus');

  await input.press(mod + '+j');
  const inspector = page.locator('.inspector');
  await inspector.waitFor();
  await page.locator('.session-row.active .icon-button').click();
  await page.locator('.context-menu').waitFor();
  await page.keyboard.press('Escape');
  await expect(page.locator('.context-menu')).toHaveCount(0);
  await expect(inspector).toBeVisible();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1050, 800));
  await expect(page.getByRole('dialog', { name: '工作区检查' })).toBeVisible();
  await page.keyboard.press(mod + '+j');
  await expect(inspector).toHaveCount(0);
  console.log('PASS Escape closes only the menu and Ctrl+J closes the narrow panel');

  await input.press(mod + '+,');
  const settings = page.getByRole('dialog', { name: '设置', exact: true });
  await settings.waitFor();
  await page.keyboard.press(mod + '+k');
  await expect(quick).toHaveCount(0);
  const original = await settings.getByRole('textbox', { name: 'Pi 入口', exact: true }).inputValue();
  await settings.getByRole('textbox', { name: 'Pi 入口', exact: true }).fill('unsaved-path');
  await page.keyboard.press('Escape');
  const discard = page.getByRole('dialog', { name: '放弃尚未保存的修改？' });
  await discard.getByRole('button', { name: '继续编辑' }).click();
  await expect(settings.getByRole('textbox', { name: 'Pi 入口', exact: true })).toHaveValue('unsaved-path');
  await page.keyboard.press('Escape');
  await discard.getByRole('button', { name: '放弃修改', exact: true }).click();
  await input.press(mod + '+,');
  await expect(settings.getByRole('textbox', { name: 'Pi 入口', exact: true })).toHaveValue(original);
  await page.keyboard.press('Escape');
  console.log('PASS existing dialogs block global navigation and dirty settings survive cancelled close');

  await page.getByRole('button', { name: 'Pi 功能', exact: true }).click();
  const features = page.getByRole('dialog', { name: 'Pi 功能', exact: true });
  await features.getByRole('button', { name: '常用设置', exact: true }).click();
  const number = features.getByRole('spinbutton', { name: '为回复预留', exact: true });
  await number.waitFor();
  await number.fill('');
  await number.pressSequentially('8192');
  await expect(number).toHaveValue('8192');
  await page.keyboard.press('Escape');
  await discard.getByRole('button', { name: '继续编辑' }).click();
  await expect(number).toHaveValue('8192');
  await page.keyboard.press('Escape');
  await discard.getByRole('button', { name: '放弃修改', exact: true }).click();
  console.log('PASS numeric editing is not clamped per keystroke and Pi settings guard unsaved changes');

  await app.evaluate(({ ipcMain }) => {
    const original = ipcMain._invokeHandlers.get('desktop:invoke');
    globalThis.interactionCalls = [];
    ipcMain.removeHandler('desktop:invoke');
    ipcMain.handle('desktop:invoke', async (event, method, args) => {
      if (method === 'projectImage' && args[1] === 'delayed.txt')
        await new Promise((resolve) => {
          globalThis.finishAttachment = resolve;
        });
      if (method === 'send') {
        globalThis.interactionCalls.push(args);
        return;
      }
      return original(event, method, args);
    });
  });
  await input.fill('Review this @delayed');
  await page.getByRole('option').filter({ hasText: 'delayed.txt' }).click();
  const send = page.getByRole('button', { name: '发送任务', exact: true });
  await expect(send).toBeDisabled();
  await input.press('Enter');
  assert.equal(await app.evaluate(() => globalThis.interactionCalls.length), 0);
  await app.evaluate(() => globalThis.finishAttachment());
  await expect(page.locator('.attachments')).toContainText('delayed.txt');
  await expect(send).toBeEnabled();
  await send.click();
  await expect.poll(() => app.evaluate(() => globalThis.interactionCalls.length)).toBe(1);
  const sent = await app.evaluate(() => globalThis.interactionCalls[0]);
  assert.deepEqual(sent[2], ['delayed.txt']);
  console.log('PASS pending attachment reads block both Enter and the button; the completed file is sent');

  for (const [method, args, title] of [
    ['logout', [fixture.sessionId, 'fixture'], '退出供应商'],
    ['packageAction', [fixture.sessionId, 'remove', 'fixture-package', false], '移除资源包'],
  ]) {
    await page.evaluate(
      ({ method, args }) => {
        void window.desktop.invoke(method, ...args);
      },
      { method, args },
    );
    const confirmation = page.getByRole('dialog').filter({ hasText: title });
    await confirmation.getByRole('button', { name: '取消', exact: true }).click();
  }
  assert.deepEqual(errors, []);
  console.log('PASS provider logout and package removal require explicit confirmation');
} catch (error) {
  if (page && !page.isClosed())
    await page.screenshot({ path: 'test-results/interaction-performance-failed.png' });
  throw error;
} finally {
  await app?.close();
  await provider.close();
}
