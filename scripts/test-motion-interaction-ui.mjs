import { launchApp, closeApp } from '../tests/support/desktop-app.mjs';
import { expect } from 'playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { emptyRuntime } from '../shared/types.ts';
import { createLocalProvider, prepareRealPiFixture } from '../tests/support/local-provider.ts';

// UI11: motion and interaction details, driven by local runtime events without model requests.
const provider = await createLocalProvider();
const fixture = await prepareRealPiFixture(provider.baseUrl, 'motion-ui');
const historyFile = path.join(fixture.dir, 'history.jsonl');
await fs.writeFile(historyFile, '');
fixture.store.session(fixture.sessionId).file = historyFile;
await fixture.store.save();
const runtime = {
  ...emptyRuntime(),
  sessionId: fixture.sessionId,
  connected: true,
  status: 'running',
  notifications: [],
  messages: [
    { role: 'user', content: '历史内容\n'.repeat(70), timestamp: 1700000000000 },
    { role: 'assistant', content: [{ type: 'text', text: '开始回复。\n' }] },
  ],
};
const assistant = runtime.messages.at(-1);
const output = path.resolve('output/playwright', `motion-${process.platform}`);
await fs.mkdir(output, { recursive: true });
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
let app, page;
const errors = [];
const frames = () =>
  page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const publish = async (marker) => {
  await app.evaluate(({ BrowserWindow }, runtime) => {
    globalThis.motionRuntime = runtime;
    BrowserWindow.getAllWindows()[0].webContents.send('desktop:event', { type: 'runtime', runtime });
  }, runtime);
  if (marker)
    await page.waitForFunction(
      (marker) => document.querySelector('.thread')?.textContent.includes(marker),
      marker,
    );
  await frames();
};
const appendReply = async (marker) => {
  assistant.content[0].text += `\n\n${marker}\n\n` + '新增回复内容。\n\n'.repeat(25);
  await publish(marker);
};
const distance = () =>
  page
    .locator('.thread')
    .evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight);
const calls = (method) =>
  app.evaluate((_, method) => globalThis.motionCalls.filter((call) => call.method === method), method);

try {
  ({ app, page } = await launchApp({ dataDir: fixture.dataDir, pageTimeout: 10000, errors }));
  await page.getByRole('textbox', { name: '任务输入' }).waitFor();
  await app.evaluate(
    ({ ipcMain }, { runtime, sessionId }) => {
      globalThis.motionRuntime = runtime;
      globalThis.motionCalls = [];
      const handler = ipcMain._invokeHandlers.get('desktop:invoke');
      ipcMain.removeHandler('desktop:invoke');
      ipcMain.handle('desktop:invoke', async (event, method, args) => {
        globalThis.motionCalls.push({ method, args });
        if (method === 'readHistory') return args[0] === sessionId ? globalThis.motionRuntime.messages : [];
        const result = await handler(event, method, args);
        return method === 'bootstrap' ? { ...result, runtime: globalThis.motionRuntime } : result;
      });
    },
    { runtime, sessionId: fixture.sessionId },
  );
  await page.reload();
  await page.bringToFront();
  const input = page.getByRole('textbox', { name: '任务输入' });
  await input.waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(100); // Let the saved-position restoration finish.
  const thread = page.locator('.thread');
  const latest = page.getByRole('button', { name: '回到最新', exact: true });

  // 1. Reduced motion keeps spinners turning but still removes decorative motion.
  const probe = () =>
    page.evaluate(() => {
      const spin = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      spin.classList.add('spin');
      const toast = document.createElement('div');
      toast.className = 'toast';
      document.body.append(spin, toast);
      const result = {
        spin: getComputedStyle(spin).animationName,
        toast: getComputedStyle(toast).animationName,
      };
      spin.remove();
      toast.remove();
      return result;
    });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.deepEqual(await probe(), { spin: 'spin', toast: 'none' });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  assert.deepEqual(await probe(), { spin: 'spin', toast: 'rise' });
  await input.press(mod + '+,');
  const settings = page.getByRole('dialog', { name: '设置', exact: true });
  await settings.waitFor();
  assert.equal(
    await page.locator('.modal-backdrop').evaluate((element) => getComputedStyle(element).animationName),
    'fade-in',
  );
  await page.keyboard.press('Escape');
  await expect(settings).toHaveCount(0);
  console.log('PASS reduced motion keeps spinners turning; the dialog backdrop fades in with the dialog');

  // 2. A small upward nudge during streaming is not pulled back by the next chunk.
  await appendReply('FIRST_REPLY');
  await thread.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await frames();
  assert.ok((await distance()) < 2);
  await thread.hover();
  await page.mouse.wheel(0, -12);
  await page.waitForFunction(() => {
    const element = document.querySelector('.thread');
    return element.scrollHeight - element.scrollTop - element.clientHeight >= 6;
  });
  await latest.waitFor();
  const nudged = await thread.evaluate((element) => element.scrollTop);
  await appendReply('AFTER_NUDGE');
  assert.ok(Math.abs((await thread.evaluate((element) => element.scrollTop)) - nudged) < 2);
  console.log('PASS a 12 px wheel nudge releases following and keeps the reading position');

  // 3. 「回到最新」 stays above the composer as the composer grows.
  const clearance = () =>
    page.evaluate(() => {
      const button = document.querySelector('.new-content').getBoundingClientRect();
      const composer = document.querySelector('.composer-wrap').getBoundingClientRect();
      return composer.top - button.bottom;
    });
  await page.waitForTimeout(200); // Let the entrance animation settle before measuring.
  assert.ok((await clearance()) >= 8, `button clearance ${await clearance()}`);
  const before = await page.locator('.composer-wrap').evaluate((element) => element.offsetHeight);
  await input.fill('多行内容\n'.repeat(14));
  await page.waitForFunction(
    (before) => document.querySelector('.composer-wrap').offsetHeight > before + 60,
    before,
  );
  await frames();
  assert.ok((await clearance()) >= 8, `button clearance with a tall composer ${await clearance()}`);
  await input.fill('');
  console.log('PASS the jump-to-latest button follows the composer height');

  // Scrolling back down restores the usual follow slack.
  await thread.hover();
  for (let attempt = 0; attempt < 20 && (await distance()) >= 2; attempt++) {
    await page.mouse.wheel(0, 600);
    await frames();
  }
  await page.waitForFunction(() => {
    const element = document.querySelector('.thread');
    return element.scrollHeight - element.scrollTop - element.clientHeight < 2;
  });
  await frames();
  await appendReply('RESUMED_BY_WHEEL');
  await page.waitForFunction(() => {
    const element = document.querySelector('.thread');
    return element.scrollHeight - element.scrollTop - element.clientHeight < 2;
  });
  await expect(latest).toHaveCount(0);
  console.log('PASS scrolling back to the bottom resumes following');

  // 4. A resting pointer does not take the keyboard selection when the list scrolls under it.
  await input.click();
  await input.fill('/');
  const options = page.locator('.command-picker [role="option"]');
  await options.first().waitFor();
  const count = await options.count();
  assert.ok(count >= 8, `command list has ${count} options`);
  const listScrolls = await page
    .locator('.command-picker')
    .evaluate((element) => element.scrollHeight > element.clientHeight + 4);
  assert.ok(listScrolls, 'command list must overflow to exercise scrolling');
  await options.nth(1).hover();
  await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
  const steps = Math.min(count - 2, 14);
  for (let step = 1; step <= steps; step++) {
    await input.press('ArrowDown');
    await frames();
    await page.waitForTimeout(30); // Give a synthetic hover after scrolling time to arrive.
    await expect(options.nth(1 + step)).toHaveAttribute('aria-selected', 'true');
  }
  await page.mouse.move(5, 5);
  await options.nth(2).hover();
  await expect(options.nth(2)).toHaveAttribute('aria-selected', 'true');
  await input.press('Escape');
  await input.fill('');
  console.log('PASS arrow keys keep the selection while the list scrolls under a resting pointer');

  // 5. Hovering a toast holds its auto-dismiss; leaving restarts it.
  runtime.notifications = [{ id: 1, level: 'info', text: 'PAUSE_TOAST' }];
  await publish();
  const toast = page.locator('.toast').filter({ hasText: 'PAUSE_TOAST' });
  await toast.waitFor();
  await toast.hover();
  await page.waitForTimeout(6000);
  await expect(toast).toBeVisible();
  await page.mouse.move(5, 5);
  await toast.waitFor({ state: 'detached', timeout: 6500 });
  runtime.notifications = [
    { id: 1, level: 'info', text: 'PAUSE_TOAST' },
    { id: 2, level: 'info', text: 'UNTOUCHED_TOAST' },
  ];
  await publish();
  await page
    .locator('.toast')
    .filter({ hasText: 'UNTOUCHED_TOAST' })
    .waitFor({ state: 'detached', timeout: 6500 });
  console.log('PASS hovering a toast pauses its timer; untouched toasts still close on time');

  // 6. Switching sessions from the keyboard saves the reading position.
  await thread.evaluate((element) => {
    element.scrollTop = Math.round(element.scrollHeight / 3);
  });
  await frames();
  const saved = await thread.evaluate((element) => element.scrollTop);
  await thread.hover();
  await app.evaluate(() => {
    globalThis.motionCalls = [];
  });
  await page.keyboard.press(mod + '+n');
  await page.waitForFunction(() => !document.querySelector('.thread')?.textContent.includes('FIRST_REPLY'));
  await expect
    .poll(async () => (await calls('saveView')).filter((call) => call.args[0] === fixture.sessionId).length)
    .toBeGreaterThan(0);
  const view = (await calls('saveView')).findLast((call) => call.args[0] === fixture.sessionId);
  assert.ok(Math.abs(view.args[1] - saved) < 2, `saved ${view.args[1]}, expected ${saved}`);
  console.log('PASS a keyboard session switch saves the previous reading position');

  assert.deepEqual(errors, []);
  await page.screenshot({ path: path.join(output, 'motion-interaction.png'), animations: 'disabled' });
} catch (error) {
  await page?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await closeApp(app).catch(() => {});
  await provider.close();
}
