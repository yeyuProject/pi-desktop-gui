import { launchApp, closeApp } from '../tests/support/desktop-app.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createLocalProvider, prepareRealPiFixture } from '../tests/support/local-provider.ts';

const provider = await createLocalProvider();
const fixture = await prepareRealPiFixture(provider.baseUrl, 'experience-ui');
const output = path.resolve('test-results');
await fs.mkdir(output, { recursive: true });
const firstImage = path.join(fixture.projectDir, 'first.png');
const secondImage = path.join(fixture.projectDir, 'second.png');
const invalidImage = path.join(fixture.projectDir, 'unsupported.bmp');
const textFile = path.join(fixture.projectDir, '输入 文件.txt');
const delayedFile = path.join(fixture.projectDir, '延迟校验.txt');
const switchedFile = path.join(fixture.projectDir, '切换会话.txt');
await fs.copyFile(path.resolve('build/icon.png'), firstImage);
await fs.copyFile(firstImage, secondImage);
await fs.writeFile(invalidImage, 'unsupported image format');
await fs.writeFile(delayedFile, 'delayed reference');
await fs.writeFile(switchedFile, 'reference cancelled by switching sessions');

let app, page;
const errors = [];
const launch = async () => {
  ({ app, page } = await launchApp({
    executablePath: process.env.PI_DESKTOP_EXE,
    dataDir: fixture.dataDir,
    errors: errors,
  }));

  await page.getByRole('textbox', { name: '任务输入' }).waitFor();
};
const savedSession = async (id, predicate) => {
  const start = Date.now();
  while (Date.now() - start < 10000) {
    const state = JSON.parse(await fs.readFile(path.join(fixture.dataDir, 'state.json'), 'utf8'));
    const session = state.sessions.find((s) => s.id === id);
    if (session && predicate(session)) return session;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error('Expected draft attachments were not saved');
};
const drop = async (files) => {
  await page.evaluate(() => {
    document.querySelector('#test-drop-files')?.remove();
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.hidden = true;
    input.id = 'test-drop-files';
    document.body.append(input);
  });
  // Native File objects are needed to exercise webUtils.getPathForFile in the preload.
  await page.locator('#test-drop-files').setInputFiles(files);
  await page.evaluate(() => {
    const dataTransfer = new DataTransfer();
    for (const file of document.querySelector('#test-drop-files').files) dataTransfer.items.add(file);
    document
      .querySelector('.composer')
      .dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
  });
};

const holdNextDrop = () =>
  app.evaluate(({ ipcMain }) => {
    const handler = ipcMain._invokeHandlers.get('desktop:invoke');
    ipcMain.removeHandler('desktop:invoke');
    ipcMain.handle('desktop:invoke', async (event, method, args) => {
      const result = await handler(event, method, args);
      if (method !== 'referenceDropped') return result;
      return new Promise((resolve) => {
        globalThis.releaseTestDrop = () => {
          ipcMain.removeHandler('desktop:invoke');
          ipcMain.handle('desktop:invoke', handler);
          delete globalThis.releaseTestDrop;
          resolve(result);
        };
      });
    });
  });
const releaseDrop = () =>
  app.evaluate(async () => {
    const deadline = Date.now() + 5000;
    while (!globalThis.releaseTestDrop) {
      if (Date.now() > deadline) throw new Error('No pending drop validation');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    globalThis.releaseTestDrop();
  });

try {
  await launch();
  const input = page.getByRole('textbox', { name: '任务输入' });
  await input.fill('混合拖放的草稿');
  await drop([firstImage]);
  await savedSession(fixture.sessionId, (s) => s.images?.length === 1);
  await drop([secondImage, textFile]);
  const mixed = await savedSession(
    fixture.sessionId,
    (s) => s.images?.length === 2 && s.attachments.includes('输入 文件.txt'),
  );
  assert.deepEqual(
    mixed.images.map((image) => image.name),
    ['first.png', 'second.png'],
  );
  assert.equal(mixed.draft, '混合拖放的草稿');
  assert.equal(await page.locator('.image-attachments img').count(), 2);
  assert.equal(await input.inputValue(), mixed.draft);

  await drop([invalidImage, path.join(fixture.projectDir, '已有修改.txt')]);
  const partial = await savedSession(fixture.sessionId, (s) => s.attachments.length === 2);
  assert.deepEqual(partial.images, mixed.images, 'a rejected image must preserve existing images');
  assert.deepEqual(partial.attachments, ['输入 文件.txt', '已有修改.txt']);
  console.log(
    'PASS mixed drops preserve existing images, add images and references, and handle partial rejection',
  );

  await holdNextDrop();
  await drop([delayedFile]);
  await input.fill('校验期间补充的重要要求');
  await page.getByRole('button', { name: '移除图片 first.png', exact: true }).click();
  await page.getByRole('button', { name: '移除引用 输入 文件.txt', exact: true }).click();
  await savedSession(fixture.sessionId, (s) => s.images?.length === 1 && s.attachments.length === 1);
  await releaseDrop();
  const editedDuringDrop = await savedSession(fixture.sessionId, (s) =>
    s.attachments.includes('延迟校验.txt'),
  );
  assert.equal(editedDuringDrop.draft, '校验期间补充的重要要求');
  assert.deepEqual(
    editedDuringDrop.images.map((image) => image.name),
    ['second.png'],
  );
  assert.deepEqual(editedDuringDrop.attachments, ['已有修改.txt', '延迟校验.txt']);
  assert.equal(await input.inputValue(), editedDuringDrop.draft);
  console.log('PASS delayed file validation preserves new draft text and attachment removals');
  await input.fill('混合拖放的草稿');

  await holdNextDrop();
  await drop([switchedFile]);
  const standalone = await page.evaluate(() => window.desktop.invoke('newSession'));
  await page.waitForFunction(() => document.querySelector('[aria-label="任务输入"]')?.value === '');
  await input.fill('另一个会话的草稿');
  await releaseDrop();
  await savedSession(standalone.id, (session) => session.draft === '另一个会话的草稿');
  await page.waitForTimeout(150); // Let the cancelled callback finish before checking both sessions.
  assert.equal(await input.inputValue(), '另一个会话的草稿');
  const afterSwitch = JSON.parse(await fs.readFile(path.join(fixture.dataDir, 'state.json'), 'utf8'));
  assert.deepEqual(
    afterSwitch.sessions.find((s) => s.id === fixture.sessionId).attachments,
    editedDuringDrop.attachments,
  );
  assert.deepEqual(afterSwitch.sessions.find((s) => s.id === standalone.id).attachments, []);
  console.log('PASS switching sessions cancels a pending drop without changing either conversation');
  await drop([firstImage, textFile]);
  const standaloneDraft = await savedSession(standalone.id, (s) => s.images?.length === 1);
  assert.deepEqual(standaloneDraft.attachments, []);
  await page
    .getByText('独立对话不能引用本地文件；打开项目后可拖入项目内的文本文件', { exact: true })
    .waitFor();
  console.log('PASS standalone mixed drops retain images while rejecting file references');

  // The quiet-close case needs both sessions settled. Project stop must not cancel
  // the independent connection automatically started for the standalone chat.
  await page.evaluate((id) => window.desktop.invoke('connect', id), standalone.id);

  await page.evaluate((id) => window.desktop.invoke('selectSession', id), fixture.sessionId);
  await page.waitForFunction(
    () => document.querySelector('[aria-label="任务输入"]')?.value === '混合拖放的草稿',
  );
  await page.evaluate((id) => window.desktop.invoke('connect', id), fixture.sessionId);
  await input.fill('E2E_SLOW Esc repeat regression');
  await savedSession(fixture.sessionId, (session) => session.draft === 'E2E_SLOW Esc repeat regression');
  await input.press('Enter');
  await page.locator('.run-meta .status.running').waitFor();
  await page.getByText('开始流式回复。', { exact: true }).waitFor();
  await page.keyboard.down('Escape');
  await page.locator('.stop-button.armed').waitFor();
  await page.keyboard.down('Escape'); // Holding the key emits repeat=true.
  await page.keyboard.up('Escape');
  assert.equal(await page.locator('.stop-button.armed').count(), 1, 'key repeat must not confirm stop');
  assert.equal(await page.locator('.run-meta .status.running').count(), 1);
  await page.keyboard.press('Escape');
  await page.locator('.run-meta .status.stopped').waitFor();
  console.log('PASS held Esc does not stop the task; a second deliberate press still stops it');

  const expectedBounds = await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    const bounds = window.getNormalBounds();
    window.setSize(bounds.width - 20, bounds.height - 20);
    return window.getNormalBounds();
  });
  const child = app.process();
  const closed = app.waitForEvent('close', { timeout: 15000 });
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    const bounds = window.getNormalBounds();
    window.close();
    // A late resize must not cancel the save awaited by the close handler.
    window.setSize(bounds.width + 20, bounds.height + 20);
  });
  await closed;
  app = undefined;
  assert.equal(child.exitCode, 0);
  const saved = JSON.parse(await fs.readFile(path.join(fixture.dataDir, 'window.json'), 'utf8'));
  assert.deepEqual(saved.bounds, expectedBounds, 'close must persist the final snapshot');
  await launch();
  const restored = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].getNormalBounds(),
  );
  // Recreating a native window at fractional Windows DPI can add a few DIP to its frame.
  assert.ok(
    Math.abs(restored.width - expectedBounds.width) <= 8,
    'restored width should match the saved window',
  );
  assert.ok(
    Math.abs(restored.height - expectedBounds.height) <= 8,
    'restored height should match the saved window',
  );
  assert.deepEqual(errors, []);
  console.log('PASS closing during resize exits cleanly, saves bounds, and restores dimensions on restart');
  console.log('Experience UI PASS', fixture.dir);
} catch (error) {
  console.error(error);
  if (page && !page.isClosed()) {
    try {
      const diagnostics = await page.evaluate(() => window.desktop.invoke('diagnostics'));
      await fs.writeFile(path.join(output, 'experience-ui-failure.json'), diagnostics);
      console.error('Experience UI diagnostics:', diagnostics);
    } catch (diagnosticError) {
      console.error('Could not capture experience UI diagnostics:', diagnosticError);
    }
  }
  if (page && !page.isClosed())
    await page.screenshot({ path: path.join(output, 'experience-ui-failure.png') });
  throw error;
} finally {
  if (app) {
    // A failed assertion during a run must not leave the exit confirmation blocking cleanup.
    await app
      .evaluate(({ BrowserWindow }) => {
        return BrowserWindow.getAllWindows()[0]?.webContents.executeJavaScript(
          `void window.desktop.onEvent(event => {
            if (event.type === 'appDialog') void window.desktop.invoke('respondAppDialog', event.dialog.id,
              event.dialog.message === 'Pi 仍在执行任务' ? 1 : event.dialog.cancelId);
          })`,
        );
      })
      .catch(() => {});
    if (page && !page.isClosed()) {
      const pendingExit = page.getByRole('dialog').filter({ hasText: 'Pi 仍在执行任务' });
      if (await pendingExit.isVisible())
        await pendingExit
          .getByRole('button', { name: '停止并退出', exact: true })
          .click()
          .catch(() => {});
    }
    await closeApp(app);
  }
  await provider.close();
}
