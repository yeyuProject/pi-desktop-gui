import { launchApp, closeApp } from '../tests/support/desktop-app.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { emptyRuntime } from '../shared/types.ts';
import { createLocalProvider, prepareRealPiFixture } from '../tests/support/local-provider.ts';

// Deterministic local data: no model requests, credentials or user sessions are used.
const label = process.argv[2] || 'current';
if (!/^[\w-]+$/.test(label)) throw new Error('Use a simple name for the measurement');
const output = path.resolve('test-results', 'performance');
await fs.mkdir(output, { recursive: true });
const provider = await createLocalProvider();
const fixture = await prepareRealPiFixture(provider.baseUrl, 'performance');
const runtime = { ...emptyRuntime(), sessionId: fixture.sessionId, connected: true, status: 'running' };
for (let i = 0; i < 100; i++) {
  const id = 'tool-' + i;
  runtime.messages.push(
    {
      role: 'user',
      content: `检查第 ${i + 1} 个模块的输入和错误处理。`,
      timestamp: 1700000000000 + i * 5000,
    },
    {
      role: 'assistant',
      content: `下面检查模块 **${i + 1}**。\n\n\`\`\`ts\nexport const value = ${i};\n\`\`\``,
    },
    {
      role: 'assistant',
      content: [{ type: 'toolCall', id, name: 'read', arguments: { path: `module-${i}.ts` } }],
    },
    { role: 'toolResult', toolCallId: id, toolName: 'read', content: `export const value = ${i};` },
    { role: 'assistant', content: `检查完成。\n\n- 输入有效\n- 错误包含处理办法\n- 用例覆盖正常和失败路径` },
  );
  runtime.tools.push({
    id,
    name: 'read',
    args: { path: `module-${i}.ts` },
    status: 'done',
    output: `export const value = ${i};`,
    startedAt: 1700000000000,
  });
}
let app;
try {
  const errors = [];
  const launched = await launchApp({ dataDir: fixture.dataDir, errors: errors });
  app = launched.app;
  const page = launched.page;

  await page.getByRole('textbox', { name: '任务输入' }).waitFor();
  await app.evaluate(({ ipcMain }, runtime) => {
    const handler = ipcMain._invokeHandlers.get('desktop:invoke');
    ipcMain.removeHandler('desktop:invoke');
    ipcMain.handle('desktop:invoke', async (event, method, args) => {
      if (method === 'readHistory') return runtime.messages;
      const result = await handler(event, method, args);
      return method === 'bootstrap' ? { ...result, runtime } : result;
    });
  }, runtime);
  await page.reload();
  await page.bringToFront();
  await page.getByRole('textbox', { name: '任务输入' }).waitFor({ timeout: 30000 });
  while (await page.locator('.load-history').count()) await page.locator('.load-history').click();
  assert.equal(await page.locator('.message.user').count(), 100);
  console.log('Loaded 500 messages and 100 tool cards');
  await page.evaluate(() => document.fonts.ready);
  const streaming = runtime.messages.at(-1);
  const durations = [];
  for (let i = 0; i < 70; i++) {
    const marker = `STREAM_UPDATE_${i}`;
    streaming.content += '\n' + marker;
    await page.evaluate((marker) => {
      globalThis.perfResult = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          observer.disconnect();
          reject(new Error('The streaming update did not appear: ' + marker));
        }, 10000);
        const start = performance.now();
        const observer = new MutationObserver(() => {
          if (!document.querySelector('.thread')?.textContent?.includes(marker)) return;
          observer.disconnect();
          clearTimeout(timeout);
          requestAnimationFrame(() => resolve(performance.now() - start));
        });
        observer.observe(document.querySelector('.thread'), {
          subtree: true,
          characterData: true,
          childList: true,
        });
      });
    }, marker);
    await app.evaluate(
      ({ BrowserWindow }, patch) => {
        BrowserWindow.getAllWindows()[0].webContents.send('desktop:event', { type: 'runtimePatch', patch });
      },
      {
        ...runtime,
        messagesFrom: 499,
        messages: [streaming],
        messageCount: 500,
        toolsFrom: 100,
        tools: [],
        toolCount: 100,
      },
    );
    const elapsed = await page.evaluate(() => globalThis.perfResult);
    if (i >= 10) durations.push(elapsed);
  }
  assert.deepEqual(errors, []);
  await page.locator('.thread').evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await page.screenshot({ path: path.join(output, `${label}.png`), animations: 'disabled' });
  const sorted = durations.toSorted((a, b) => a - b);
  const result = {
    label,
    messages: 500,
    tools: 100,
    samples: durations.length,
    medianMs: sorted[30],
    p90Ms: sorted[54],
    durations,
  };
  await fs.writeFile(path.join(output, `${label}.json`), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ...result, durations: undefined }));
} finally {
  await closeApp(app);
  await provider.close();
}
