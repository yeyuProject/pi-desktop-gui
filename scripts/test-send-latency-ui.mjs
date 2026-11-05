// UI12: the composer clears on Enter, the sent message shows as "发送中" until Pi accepts it,
// and a failed send gives the text back. Real Electron, real Pi CLI and a local model endpoint.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { expect } from 'playwright/test';
import { launchApp, closeApp } from '../tests/support/desktop-app.mjs';
import { createLocalProvider, prepareRealPiFixture } from '../tests/support/local-provider.ts';

const provider = await createLocalProvider();
const fixture = await prepareRealPiFixture(provider.baseUrl, 'send-latency-ui');
fixture.store.session(fixture.sessionId).title = '发送延迟验收';
await fixture.store.save();
const errors = [];
const result = { checks: [] };
let app, page;
const input = () => page.getByRole('textbox', { name: '任务输入' });
const snapshot = () => page.evaluate(() => window.desktop.invoke('bootstrap'));
const idle = () =>
  expect
    .poll(async () => (await snapshot()).runtime.status, { timeout: 60000 })
    .toMatch(/^(idle|completed|stopped)$/);
/** Record every frame from now on: composer text, placeholder and real messages containing `marker`. */
const startFrames = (marker) =>
  page.evaluate((marker) => {
    window.ui12Frames = [];
    window.ui12Recording = true;
    const sample = () => {
      if (!window.ui12Recording) return;
      const box = document.querySelector('textarea[aria-label="任务输入"]');
      const real = [...document.querySelectorAll('.message.user:not(.outgoing-message)')].some((node) =>
        node.textContent.includes(marker),
      );
      const placeholder = [...document.querySelectorAll('.outgoing-message, .outgoing-queue-item')].some(
        (node) => node.textContent.includes(marker),
      );
      window.ui12Frames.push({ t: performance.now(), value: box?.value ?? '', real, placeholder });
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }, marker);
const stopFrames = () =>
  page.evaluate(() => {
    window.ui12Recording = false;
    return window.ui12Frames;
  });
const delaySend = (ms, fail = false) =>
  app.evaluate((_, options) => Object.assign(globalThis.ui12Send, options), { ms, fail });

try {
  ({ app, page } = await launchApp({ dataDir: fixture.dataDir, errors }));
  await input().waitFor();
  // Delay (and optionally fail) the send IPC to stand in for a slow connection or checkpoint.
  await app.evaluate(({ ipcMain }) => {
    const original = ipcMain._invokeHandlers.get('desktop:invoke');
    globalThis.ui12Send = { ms: 0, fail: false };
    ipcMain.removeHandler('desktop:invoke');
    ipcMain.handle('desktop:invoke', async (event, method, args) => {
      if (method === 'send') {
        const { ms, fail } = globalThis.ui12Send;
        globalThis.ui12SendStarted = Date.now();
        if (ms) await new Promise((resolve) => setTimeout(resolve, ms));
        if (fail) throw new Error('UI12 测试：发送失败');
      }
      return original(event, method, args);
    });
  });

  // 1. Idle send: empty composer and placeholder in the next frame, never both message forms at once.
  await delaySend(1000);
  const first = 'UI12_FIRST 第一条消息';
  await input().fill(first);
  // Environment detection runs after the window opens; the send button waits for it.
  await expect(page.locator('.send-button')).toBeEnabled({ timeout: 60000 });
  await startFrames('UI12_FIRST');
  const pressed = await page.evaluate(() => performance.now());
  await input().press('Enter');
  await expect(page.locator('.outgoing-message')).toBeVisible();
  // The store keeps the text until Pi accepts it (crash safety).
  await expect
    .poll(async () => {
      const state = JSON.parse(await fs.readFile(path.join(fixture.dataDir, 'state.json'), 'utf8'));
      return state.sessions.find((session) => session.id === fixture.sessionId)?.draft;
    })
    .toBe(first);
  await expect(page.locator('.message.user:not(.outgoing-message)').filter({ hasText: first })).toBeVisible({
    timeout: 60000,
  });
  await expect(page.locator('.outgoing-message')).toHaveCount(0);
  await idle();
  await page.waitForTimeout(500);
  const frames = await stopFrames();
  const afterPress = frames.filter((frame) => frame.t > pressed);
  assert.ok(afterPress.length > 10, 'not enough frames recorded');
  const firstEmpty = afterPress.find((frame) => frame.value === '');
  assert.ok(
    firstEmpty && firstEmpty.t - pressed < 50,
    `composer cleared after ${firstEmpty?.t - pressed} ms`,
  );
  const firstPlaceholder = afterPress.find((frame) => frame.placeholder);
  assert.ok(firstPlaceholder && firstPlaceholder.t - pressed < 50, 'placeholder appeared late');
  const leaked = afterPress.filter((frame) => frame.t >= firstEmpty.t && frame.value.includes('UI12_FIRST'));
  assert.equal(leaked.length, 0, 'sent text came back into the composer');
  assert.equal(
    afterPress.filter((frame) => frame.real && frame.placeholder).length,
    0,
    'message shown twice',
  );
  const realAt = afterPress.find((frame) => frame.real)?.t;
  result.checks.push({
    check: 'idle send',
    clearMs: Math.round(firstEmpty.t - pressed),
    placeholderMs: Math.round(firstPlaceholder.t - pressed),
    realMessageMs: Math.round(realAt - pressed),
  });
  console.log('PASS Enter clears the composer at once and shows the message as sending until Pi accepts it');

  // 2. A failed send puts everything back into the composer.
  await delaySend(400, true);
  const failed = 'UI12_FAIL 发送失败的文字';
  await input().fill(failed);
  await input().press('Enter');
  await expect(input()).toHaveValue('');
  await expect(page.locator('.outgoing-message')).toBeVisible();
  await expect(input()).toHaveValue(failed);
  await expect(page.locator('.outgoing-message')).toHaveCount(0);
  await expect(page.locator('.error-banner')).toBeVisible();
  console.log('PASS a failed send restores the text and shows the error');

  // 3. Text typed while the send was pending is kept; the unsent text can be restored in front.
  await page.getByRole('button', { name: '关闭错误提示' }).click();
  await input().fill('UI12_OLD 旧消息');
  await delaySend(1500, true);
  await input().press('Enter');
  await expect(input()).toHaveValue('');
  await input().pressSequentially('UI12_NEW');
  const restore = page.getByRole('button', { name: '恢复到输入框', exact: true });
  await expect(restore).toBeVisible({ timeout: 10000 });
  await expect(input()).toHaveValue('UI12_NEW');
  await restore.click();
  await expect(input()).toHaveValue('UI12_OLD 旧消息\n\nUI12_NEW');
  await input().fill('');
  console.log('PASS typing during a failed send is kept and the unsent text can be restored');

  // 4. Sending during a run: the message joins the queue as "发送中", the composer stays empty.
  await delaySend(0);
  await input().fill('E2E_SLOW 运行中的任务');
  await input().press('Enter');
  await expect.poll(async () => (await snapshot()).runtime.status, { timeout: 60000 }).toBe('running');
  await delaySend(1000);
  await input().fill('UI12_QUEUE 补充要求');
  // Running controls: quiet mode menu, stop, and the send button keeps its icon.
  const sendButton = page.locator('.send-button');
  await expect(sendButton).toHaveAttribute('title', /立即补充/);
  assert.equal((await sendButton.innerText()).trim(), '', 'the send button shows an icon, not text');
  await fs.mkdir('test-results', { recursive: true });
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => window.desktop.invoke('saveSettings', { theme }), theme);
    await page.waitForFunction((theme) => document.documentElement.dataset.theme === theme, theme);
    await page.locator('.composer').screenshot({ path: `test-results/composer-running-${theme}.png` });
  }
  await page.getByLabel('运行中发送方式').selectOption('followUp');
  await expect(sendButton).toHaveAttribute('title', /完成后执行/);
  await page.getByLabel('运行中发送方式').selectOption('steer');
  await startFrames('UI12_QUEUE');
  await input().press('Enter');
  await expect(page.locator('.outgoing-queue-item')).toBeVisible();
  await expect(page.locator('.queue')).toContainText('补充', { timeout: 30000 });
  await expect(page.locator('.outgoing-queue-item')).toHaveCount(0, { timeout: 30000 });
  const queueFrames = await stopFrames();
  const firstQueueEmpty = queueFrames.findIndex((frame) => frame.value === '');
  assert.ok(firstQueueEmpty >= 0);
  assert.equal(
    queueFrames.slice(firstQueueEmpty).filter((frame) => frame.value.includes('UI12_QUEUE')).length,
    0,
    'queued text came back into the composer',
  );
  await page.evaluate((id) => window.desktop.invoke('stop', id), fixture.sessionId);
  console.log('PASS a message sent during a run waits in the queue without staying in the composer');

  await fs.mkdir('test-results', { recursive: true });
  await fs.writeFile('test-results/send-latency.json', JSON.stringify(result, null, 2));
  assert.deepEqual(errors, []);
  await app.close();
} catch (error) {
  if (page) await page.screenshot({ path: 'test-results/send-latency-failure.png' }).catch(() => {});
  if (app) await closeApp(app);
  throw error;
} finally {
  await provider.close();
}
