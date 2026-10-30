import { launchApp, closeApp } from '../tests/support/desktop-app.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { emptyRuntime } from '../shared/types.ts';
import { createLocalProvider, prepareRealPiFixture } from '../tests/support/local-provider.ts';

// Exercise renderer scrolling with local runtime events, without sending model requests.
const provider = await createLocalProvider();
const fixture = await prepareRealPiFixture(provider.baseUrl, 'scroll-ui');
const historyFile = path.join(fixture.dir, 'history.jsonl');
await fs.writeFile(historyFile, '');
fixture.store.session(fixture.sessionId).file = historyFile;
await fixture.store.save();
const runtime = {
  ...emptyRuntime(),
  sessionId: fixture.sessionId,
  connected: true,
  status: 'running',
  messages: [
    { role: 'user', content: '历史内容\n'.repeat(70), timestamp: 1700000000000 },
    { role: 'assistant', content: [{ type: 'thinking', thinking: '开始思考。\n' }] },
  ],
};
const assistant = runtime.messages.at(-1);
const output = path.resolve('output/playwright', `scroll-${process.platform}`);
await fs.mkdir(output, { recursive: true });
let app, page;
const errors = [];
const frames = () =>
  page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const publish = async (marker) => {
  await app.evaluate(({ BrowserWindow }, runtime) => {
    globalThis.scrollRuntime = runtime;
    BrowserWindow.getAllWindows()[0].webContents.send('desktop:event', { type: 'runtime', runtime });
  }, runtime);
  await page.waitForFunction(
    (marker) => document.querySelector('.thread')?.textContent.includes(marker),
    marker,
  );
  await frames();
};
const atBottom = async (selector) => {
  await page.waitForFunction((selector) => {
    const element = document.querySelector(selector);
    return element && element.scrollHeight - element.scrollTop - element.clientHeight < 2;
  }, selector);
};
const appendThinking = async (marker, lines = 12) => {
  assistant.content[0].thinking += `${marker}\n` + '继续分析当前实现，核对滚动位置。\n'.repeat(lines);
  await publish(marker);
};
const appendReply = async (marker) => {
  let reply = assistant.content.find((block) => block.type === 'text');
  if (!reply) assistant.content.push((reply = { type: 'text', text: '' }));
  reply.text += `\n\n${marker}\n\n` + '新增回复内容。\n\n'.repeat(25);
  await publish(marker);
};
try {
  ({ app, page } = await launchApp({ dataDir: fixture.dataDir, pageTimeout: 10000, errors: errors }));

  await page.getByRole('textbox', { name: '任务输入' }).waitFor();
  await app.evaluate(({ ipcMain }, runtime) => {
    globalThis.scrollRuntime = runtime;
    const handler = ipcMain._invokeHandlers.get('desktop:invoke');
    ipcMain.removeHandler('desktop:invoke');
    ipcMain.handle('desktop:invoke', async (event, method, args) => {
      if (method === 'readHistory') return globalThis.scrollRuntime.messages;
      const result = await handler(event, method, args);
      return method === 'bootstrap' ? { ...result, runtime: globalThis.scrollRuntime } : result;
    });
  }, runtime);
  await page.reload();
  await page.bringToFront();
  await page.getByRole('textbox', { name: '任务输入' }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(100); // Let the existing saved-position restoration finish.
  const thread = page.locator('.thread');
  const thinking = page.locator('.thinking pre');
  await page.locator('.thinking summary').click();
  await appendThinking('THINK_NEEDLE', 80);
  await atBottom('.thinking pre');
  for (let index = 0; index < 8; index++) {
    await appendThinking(`STREAM_${index}`);
    await atBottom('.thinking pre');
  }
  await appendThinking('LARGE_DELTA', 160);
  await atBottom('.thinking pre');
  console.log('PASS thinking follows successive updates and large streaming deltas');

  await thinking.hover();
  await page.mouse.wheel(0, -180);
  await page.getByRole('button', { name: '最新思考', exact: true }).waitFor();
  const thinkingTop = await thinking.evaluate((element) => element.scrollTop);
  await appendThinking('PAUSED_THINKING');
  assert.ok(Math.abs((await thinking.evaluate((element) => element.scrollTop)) - thinkingTop) < 2);
  await thinking.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await frames();
  await appendThinking('RESUMED_THINKING');
  await atBottom('.thinking pre');
  await thinking.evaluate((element) => {
    element.scrollTop -= 180;
  });
  await page.getByRole('button', { name: '最新思考', exact: true }).click();
  await appendThinking('BUTTON_RESUMED_THINKING');
  await atBottom('.thinking pre');
  console.log('PASS reading earlier thinking pauses following; reaching the bottom or clicking resumes it');

  await thread.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await frames();
  await atBottom('.thread');
  await thread.evaluate((element) => {
    element.scrollTop -= 220;
  });
  await page.getByRole('button', { name: '回到最新', exact: true }).waitFor();
  const threadTop = await thread.evaluate((element) => element.scrollTop);
  await appendReply('PAUSED_REPLY');
  assert.ok(Math.abs((await thread.evaluate((element) => element.scrollTop)) - threadTop) < 2);
  await page.getByRole('button', { name: '回到最新', exact: true }).click();
  await appendReply('BUTTON_RESUMED_REPLY');
  await atBottom('.thread');
  await thread.evaluate((element) => {
    element.scrollTop -= 220;
  });
  await frames();
  await thread.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await frames();
  await appendReply('MANUALLY_RESUMED_REPLY');
  await atBottom('.thread');
  console.log('PASS the message list preserves reading position and resumes following by either route');

  runtime.notices = ['RESIZE_NOTICE\n' + '运行记录内容\n'.repeat(60)];
  await publish('RESIZE_NOTICE');
  await page.locator('.runtime-notices summary').click();
  await atBottom('.thread');
  await page.locator('.runtime-notices summary').click();
  await atBottom('.thread');
  for (const size of [
    [1050, 720],
    [1400, 900],
    [1000, 650],
  ]) {
    const contentSize = await app.evaluate(({ BrowserWindow }, [width, height]) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.setSize(width, height);
      return window.getContentSize();
    }, size);
    await page.waitForFunction(
      ([width, height]) => innerWidth === width && innerHeight === height,
      contentSize,
    );
    await frames();
    await atBottom('.thread');
    await atBottom('.thinking pre');
  }
  console.log('PASS expanded content and window resizing keep the latest output in view');

  await page
    .getByRole('textbox', { name: '任务输入' })
    .press(process.platform === 'darwin' ? 'Meta+f' : 'Control+f');
  const find = page.getByRole('textbox', { name: '查找当前会话' });
  await find.fill('THINK_NEEDLE');
  await page.locator('.thinking .search-current').waitFor();
  await page.waitForFunction(() => {
    const element = document.querySelector('.thinking .search-current');
    if (!element) return false;
    const bounds = element.getBoundingClientRect(),
      container = element.closest('pre').getBoundingClientRect();
    return bounds.bottom > container.top && bounds.top < container.bottom;
  });
  await appendThinking('SEARCH_STAYS_VISIBLE');
  assert.ok(
    await thinking.evaluate(
      (element) => element.scrollHeight - element.scrollTop - element.clientHeight > 100,
    ),
  );
  await find.press('Escape');
  runtime.status = 'completed';
  await publish('SEARCH_STAYS_VISIBLE');
  await page.reload();
  await page.getByRole('textbox', { name: '任务输入' }).waitFor();
  await page.locator('.thinking summary').click();
  await frames();
  assert.ok(await thinking.evaluate((element) => element.scrollHeight > element.clientHeight));
  assert.equal(await thinking.evaluate((element) => element.scrollTop), 0);
  assert.equal(provider.requests.length, 0);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: path.join(output, 'scroll-follow.png'), animations: 'disabled' });
  console.log('PASS search keeps its match visible and saved thinking opens at the beginning');
} catch (error) {
  await page?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await closeApp(app).catch(() => {});
  await provider.close();
}
