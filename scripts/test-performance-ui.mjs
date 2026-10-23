import { _electron as electron } from 'playwright';
import { expect } from 'playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { emptyRuntime } from '../shared/types.ts';
import { createLocalProvider, prepareRealPiFixture } from '../tests/support/local-provider.ts';
const provider = await createLocalProvider();
const fixture = await prepareRealPiFixture(provider.baseUrl, 'performance-regression-ui');
const result = {
  note: 'Synthetic local data, no model calls. Update timings include test dispatch IPC plus renderer commit and next animation frame.',
  cases: [],
};
const summary = (a) => {
  const s = a.toSorted((a, b) => a - b);
  return {
    samples: s.length,
    medianMs: s[Math.floor(s.length / 2)],
    p95Ms: s[Math.ceil(s.length * 0.95) - 1],
    maxMs: s.at(-1),
  };
};
let app;
try {
  const start = performance.now();
  app = await electron.launch({
    args: [path.resolve('.')],
    env: { ...process.env, PI_DESKTOP_DATA_DIR: fixture.dataDir, PI_OFFLINE: '1' },
    timeout: 60000,
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(60000);
  await page.getByRole('textbox', { name: '任务输入' }).waitFor();
  result.firstLaunchToInputMs = performance.now() - start;
  await app.evaluate(({ ipcMain, BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setSize(1440, 900);
    const original = ipcMain._invokeHandlers.get('desktop:invoke');
    ipcMain.removeHandler('desktop:invoke');
    ipcMain.handle('desktop:invoke', async (event, method, args) => {
      if (method === 'readHistory' && globalThis.auditRuntime) return globalThis.auditRuntime.messages;
      const value = await original(event, method, args);
      return method === 'bootstrap' && globalThis.auditRuntime
        ? { ...value, runtime: globalThis.auditRuntime }
        : value;
    });
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  for (const spec of [
    { messages: 500, activeChars: 100, expand: false },
    { messages: 5000, activeChars: 100, expand: false },
    { messages: 500, activeChars: 100, expand: true },
    { messages: 500, activeChars: 50000, expand: false },
    { messages: 5000, activeChars: 100, expand: false, patchLines: 500 },
  ]) {
    const runtime = { ...emptyRuntime(), sessionId: fixture.sessionId, connected: true, status: 'running' };
    for (let i = 0; i < spec.messages; i++)
      runtime.messages.push({
        role: i % 2 ? 'assistant' : 'user',
        content:
          i % 2
            ? `Module **${i}**.\n\n- Check one\n- Check two\n\n\`\`\`ts\nconst value = ${i};\n\`\`\``
            : `Check module ${i}.`,
        timestamp: 1700000000000 + i,
      });
    if (spec.patchLines) {
      const patch = Array.from(
        { length: spec.patchLines },
        (_, i) => (i % 2 ? '+' : '-') + 'const item = { value: 12345678, label: "fixture" };',
      ).join('\n');
      for (let i = 0; i < runtime.messages.length; i += 4) {
        runtime.messages[i] = { role: 'user', content: `Check module ${i}.` };
        runtime.messages[i + 1] = {
          role: 'assistant',
          content: [{ type: 'toolCall', id: `tool-${i}`, name: 'edit', arguments: { path: `file-${i}.ts` } }],
        };
        runtime.messages[i + 2] = {
          role: 'toolResult',
          toolCallId: `tool-${i}`,
          toolName: 'edit',
          content: 'Edited',
          details: { patch },
        };
      }
    }
    const block =
      'A **formatted** paragraph with [a link](https://example.invalid).\n\n- first item\n- second item\n\n';
    runtime.messages.at(-1).content =
      block.repeat(Math.ceil(spec.activeChars / block.length)) + 'AUDIT_READY';
    await app.evaluate((_e, r) => (globalThis.auditRuntime = r), runtime);
    await page.reload();
    await page.bringToFront();
    await page.getByRole('textbox', { name: '任务输入' }).waitFor();
    await page.waitForFunction(() => document.querySelector('.thread')?.textContent?.includes('AUDIT_READY'));
    if (spec.expand)
      while (await page.locator('.load-history').count()) await page.locator('.load-history').click();
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => {
      globalThis.auditLongTasks = [];
      globalThis.auditLongTaskObserver = new PerformanceObserver((list) =>
        globalThis.auditLongTasks.push(...list.getEntries().map((e) => e.duration)),
      );
      globalThis.auditLongTaskObserver.observe({ type: 'longtask' });
    });
    const durations = [];
    for (let i = 0; i < 35; i++) {
      const marker = `AUDIT_UPDATE_${i}_END`;
      await page.evaluate((marker) => {
        globalThis.auditMeasurement = new Promise((resolve, reject) => {
          const start = performance.now();
          const timer = setTimeout(() => {
            observer.disconnect();
            reject(new Error('update timeout'));
          }, 20000);
          const observer = new MutationObserver(() => {
            if (!document.querySelector('.thread')?.textContent?.includes(marker)) return;
            observer.disconnect();
            clearTimeout(timer);
            requestAnimationFrame(() => resolve(performance.now() - start));
          });
          observer.observe(document.querySelector('.thread'), {
            subtree: true,
            characterData: true,
            childList: true,
          });
        });
      }, marker);
      await app.evaluate(({ BrowserWindow }, marker) => {
        const r = globalThis.auditRuntime;
        r.messages.at(-1).content += '\n' + marker;
        BrowserWindow.getAllWindows()[0].webContents.send('desktop:event', {
          type: 'runtimePatch',
          patch: {
            sessionId: r.sessionId,
            messagesFrom: r.messages.length - 1,
            messages: [r.messages.at(-1)],
            messageCount: r.messages.length,
            toolsFrom: 0,
            tools: [],
            toolCount: 0,
          },
        });
      }, marker);
      const elapsed = await page.evaluate(() => globalThis.auditMeasurement);
      if (i >= 5) durations.push(elapsed);
    }
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('HeapProfiler.collectGarbage');
    const heap = await cdp.send('Runtime.getHeapUsage');
    const dom = await cdp.send('Memory.getDOMCounters');
    await cdp.detach();
    const observation = await page.evaluate(() => {
      globalThis.auditLongTaskObserver.disconnect();
      return {
        longTasks: globalThis.auditLongTasks,
        renderedMessages: document.querySelectorAll('.message').length,
        outlineButtons: document.querySelectorAll('.turn-outline button').length,
        domElements: document.querySelectorAll('*').length,
      };
    });
    const item = {
      ...spec,
      ...summary(durations),
      rendererHeapAfterGcMiB: heap.usedSize / 1024 / 1024,
      dom,
      observation,
    };
    result.cases.push(item);
    console.log(JSON.stringify(item));
    assert.ok(observation.outlineButtons <= 60, 'outline DOM must stay bounded');
    assert.equal(observation.renderedMessages, spec.patchLines ? 40 : spec.expand ? spec.messages : 80);
    if (item.p95Ms > 100) console.warn('Slow streaming update; inspect performance-ui.json on this host');
    if (spec.messages === 5000 && !spec.patchLines) {
      const outline = page.getByRole('navigation', { name: '对话轮次' });
      await outline.locator('button').first().focus();
      await page.keyboard.press('End');
      await expect(outline.locator('[data-outline-index="2499"]')).toBeFocused();
      await page.keyboard.press('Home');
      await expect(outline.locator('[data-outline-index="0"]')).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(page.locator('.message').filter({ hasText: 'Check module 0.' })).toBeVisible();
      assert.ok((await outline.locator('button').count()) <= 60);
      await expect(page.locator('.message')).toHaveCount(80);
      await page.getByRole('button', { name: '加载更新的 80 条消息', exact: true }).click();
      await expect(page.locator('[data-message-index="80"]')).toBeVisible();
      await expect(page.locator('.message')).toHaveCount(80);
      await page.getByRole('button', { name: '加载更早的 80 条消息', exact: true }).click();
      await expect(page.locator('[data-message-index="0"]')).toBeVisible();
      await page.getByRole('button', { name: '回到最新', exact: true }).click();
      await expect(page.locator('.message').last()).toContainText('AUDIT_UPDATE_34_END');
      await expect(page.locator('.message')).toHaveCount(80);
      await page
        .getByRole('textbox', { name: '任务输入' })
        .press(process.platform === 'darwin' ? 'Meta+f' : 'Control+f');
      const find = page.getByRole('textbox', { name: '查找当前会话' });
      await find.fill('Check module');
      await expect(page.locator('.session-find [aria-live]')).toHaveText('1 / 2500');
      await expect(page.locator('[data-message-index="0"]')).toBeVisible();
      await expect(page.locator('.message')).toHaveCount(80);
      await find.press('Shift+Enter');
      await expect(page.locator('.session-find [aria-live]')).toHaveText('2500 / 2500');
      await expect(page.locator('[data-message-index="4998"]')).toBeVisible();
      await expect(page.locator('.message')).toHaveCount(80);
      await find.press('Enter');
      await expect(page.locator('[data-message-index="0"]')).toBeVisible();
      await find.fill('Check module 4000.');
      await expect(page.locator('[data-message-index="4000"]')).toBeVisible();
      await find.press('Escape');
      // Rewriting history while inspecting an old page must not leave an empty/stale window.
      await app.evaluate(({ BrowserWindow }) => {
        globalThis.auditRuntime.messages = globalThis.auditRuntime.messages.slice(-100);
        BrowserWindow.getAllWindows()[0].webContents.send('desktop:event', {
          type: 'runtime',
          runtime: globalThis.auditRuntime,
        });
      });
      await expect(page.locator('.message')).toHaveCount(80);
      await expect(page.locator('.load-newer')).toHaveCount(0);
      await page.getByRole('button', { name: '加载更早的 20 条消息', exact: true }).click();
      await expect(page.locator('.message')).toHaveCount(100);
      // A fresh session view resets the temporary jump window to the latest page.
      await page.reload();
      await expect(page.locator('.message').last()).toContainText('AUDIT_UPDATE_34_END');
      await expect(page.locator('.message')).toHaveCount(80);
      await expect(page.locator('.load-newer')).toHaveCount(0);
    }
    if (spec.activeChars === 50000) {
      await app.evaluate(({ BrowserWindow }) => {
        globalThis.auditRuntime.status = 'completed';
        BrowserWindow.getAllWindows()[0].webContents.send('desktop:event', {
          type: 'runtime',
          runtime: globalThis.auditRuntime,
        });
      });
      await expect(page.locator('.message').last()).toContainText('AUDIT_UPDATE_34_END');
      await expect(page.locator('.message').last().locator('.message-content strong').first()).toHaveText(
        'formatted',
      );
      await app.evaluate(({ BrowserWindow }) => {
        const runtime = globalThis.auditRuntime;
        runtime.status = 'running';
        runtime.messages.at(-1).content = '```txt\n' + 'long code line\n'.repeat(1500) + 'END_OF_CODE\n```';
        BrowserWindow.getAllWindows()[0].webContents.send('desktop:event', { type: 'runtime', runtime });
      });
      await expect(page.locator('.streaming-markdown-text')).toContainText('END_OF_CODE');
      await app.evaluate(({ BrowserWindow }) => {
        globalThis.auditRuntime.status = 'completed';
        BrowserWindow.getAllWindows()[0].webContents.send('desktop:event', {
          type: 'runtime',
          runtime: globalThis.auditRuntime,
        });
      });
      await expect(page.locator('.streaming-markdown-text')).toHaveCount(0);
      await expect(page.locator('.message').last().locator('code')).toContainText('END_OF_CODE');
    }
  }
  result.errors = errors;
  assert.deepEqual(errors, []);
  result.appMetrics = await app.evaluate(({ app }) =>
    app.getAppMetrics().map((p) => ({ type: p.type, cpu: p.cpu, memory: p.memory })),
  );
  await fs.writeFile('test-results/performance-ui.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ firstLaunchToInputMs: result.firstLaunchToInputMs, errors }));
} finally {
  await app?.close();
  await provider.close();
}
