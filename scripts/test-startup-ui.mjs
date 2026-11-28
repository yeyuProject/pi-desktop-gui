import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { desktopTestEnv } from '../tests/support/desktop-env.ts';
import { createLocalProvider, prepareRealPiFixture } from '../tests/support/local-provider.ts';

const provider = await createLocalProvider();
const fixture = await prepareRealPiFixture(provider.baseUrl, 'startup-comparison');
const roots = [process.env.PI_STARTUP_BASELINE, process.env.PI_STARTUP_CANDIDATE || path.resolve('.')].filter(
  Boolean,
);
const samples = [];
try {
  for (let round = 0; round < 21; round++)
    for (const root of round % 2 ? roots.toReversed() : roots) {
      const app = await electron.launch({
        args: [root],
        env: desktopTestEnv({ PI_OFFLINE: '1', PI_DESKTOP_DATA_DIR: fixture.dataDir }),
      });
      try {
        await app.evaluate(async ({ ipcMain }) => {
          const deadline = Date.now() + 10000;
          while (!ipcMain._invokeHandlers.has('desktop:invoke')) {
            if (Date.now() > deadline) throw new Error('IPC was not registered');
            await new Promise((resolve) => setTimeout(resolve, 1));
          }
          const handler = ipcMain._invokeHandlers.get('desktop:invoke');
          ipcMain.removeHandler('desktop:invoke');
          ipcMain.handle('desktop:invoke', (event, method, args) => {
            if (method === 'bootstrap') globalThis.startupBootstrapMs = performance.now();
            if (method === 'rendererReady') globalThis.startupRendererReadyMs = performance.now();
            return handler(event, method, args);
          });
        });
        const page = await app.firstWindow();
        await page.getByRole('textbox', { name: '任务输入' }).waitFor();
        let milliseconds;
        for (let i = 0; i < 100; i++) {
          milliseconds = await app.evaluate(() => globalThis.startupRendererReadyMs);
          if (milliseconds) break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.ok(milliseconds, 'rendererReady must be observed rather than inferred from the input');
        const bootstrapMs = await app.evaluate(() => globalThis.startupBootstrapMs);
        samples.push({
          root,
          round,
          milliseconds,
          bootstrapMs,
          bootstrapToReadyMs: milliseconds - bootstrapMs,
        });
      } finally {
        await app.close();
      }
    }
  const summary = roots.map((root) => {
    const times = samples
      .filter((row) => row.root === root && row.round > 0)
      .map((row) => row.milliseconds)
      .toSorted((a, b) => a - b);
    return {
      root,
      samples: times.length,
      medianMs: (times[Math.floor((times.length - 1) / 2)] + times[Math.floor(times.length / 2)]) / 2,
      p95Ms: times[Math.ceil(times.length * 0.95) - 1],
    };
  });
  const result = {
    node: process.version,
    platform: process.platform,
    note: 'Fresh Electron processes, interleaved roots, first round recorded but excluded from summary. OS disk cache is not cleared. Time from main-process performance origin to the actual rendererReady IPC.',
    samples,
    summary,
  };
  await fs.mkdir('test-results', { recursive: true });
  await fs.writeFile('test-results/startup-ui.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await provider.close();
}
