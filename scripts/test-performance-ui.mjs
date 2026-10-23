import { _electron as electron } from 'playwright';
import { expect } from 'playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { emptyRuntime } from '../shared/types.ts';
import { Workspace } from '../electron/workspace.ts';
import { createLocalProvider, prepareRealPiFixture } from '../tests/support/local-provider.ts';
const provider = await createLocalProvider();
const fixture = await prepareRealPiFixture(provider.baseUrl, 'performance-regression-ui');
await new Workspace(fixture.dataDir).captureCheckpoint(
  fixture.store.state.projects.find((project) => project.id === fixture.projectId),
  fixture.sessionId,
  1,
  1700000000000,
);
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
  // Count actual component executions via React's DevTools commit hook, excluding memo bailouts.
  // Match the conversation's props because production function names are minified.
  await page.addInitScript(() => {
    globalThis.auditConversationRenders = 0;
    globalThis.auditComposerRenders = 0;
    globalThis.auditAppRenders = 0;
    globalThis.auditUserRenders = 0;
    globalThis.auditMarkdownWork = [];
    globalThis.auditSecondTimers = new Set();
    const startInterval = window.setInterval.bind(window),
      stopInterval = window.clearInterval.bind(window);
    window.setInterval = (callback, delay, ...args) => {
      const timer = startInterval(callback, delay, ...args);
      if (delay === 1000) globalThis.auditSecondTimers.add(timer);
      return timer;
    };
    window.clearInterval = (timer) => {
      globalThis.auditSecondTimers.delete(timer);
      stopInterval(timer);
    };
    let previousFibers = new WeakSet();
    globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      supportsFiber: true,
      inject: () => 1,
      onCommitFiberUnmount() {},
      onCommitFiberRoot(_id, root) {
        const currentFibers = new WeakSet();
        const visit = (fiber) => {
          // A memo bailout can reuse an entire subtree with old flags still attached.
          const worked = !previousFibers.has(fiber) && Boolean(fiber.flags & 1);
          currentFibers.add(fiber);
          if (fiber.memoizedProps?.messageContext && fiber.memoizedProps?.messages && worked)
            globalThis.auditConversationRenders++;
          if (fiber.memoizedProps?.m?.role === 'user' && worked) globalThis.auditUserRenders++;
          if (
            worked &&
            fiber.tag === 15 &&
            typeof fiber.memoizedProps?.text === 'string' &&
            Object.keys(fiber.memoizedProps).length === 1
          )
            globalThis.auditMarkdownWork.push(fiber.memoizedProps.text.length);
          if (fiber.tag === 15 && fiber.memoizedProps?.onDraft) {
            if (worked) globalThis.auditComposerRenders++;
            let parent = fiber.return;
            while (parent && parent.tag !== 0) parent = parent.return;
            if (parent && !previousFibers.has(parent) && parent.flags & 1) globalThis.auditAppRenders++;
          }
          if (fiber.child) visit(fiber.child);
          if (fiber.sibling) visit(fiber.sibling);
        };
        visit(root.current);
        previousFibers = currentFibers;
      },
    };
  });
  await page.getByRole('textbox', { name: '任务输入' }).waitFor();
  result.firstLaunchToInputMs = performance.now() - start;
  await app.evaluate(({ ipcMain, BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setSize(1440, 900);
    const original = ipcMain._invokeHandlers.get('desktop:invoke');
    globalThis.auditWorkspaceCalls = [];
    ipcMain.removeHandler('desktop:invoke');
    ipcMain.handle('desktop:invoke', async (event, method, args) => {
      if (method === 'readHistory' && globalThis.auditRuntime) return globalThis.auditRuntime.messages;
      const value = await original(event, method, args);
      if (method === 'changes' || method === 'checkpoints') globalThis.auditWorkspaceCalls.push(method);
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
      (spec.activeChars === 50000 ? '```ts\nconst finalization = "preserve";\n```\n\n' : '') +
      block.repeat(Math.ceil(spec.activeChars / block.length)) +
      'AUDIT_READY';
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
    const input = page.getByRole('textbox', { name: '任务输入' });
    await input.fill('');
    if (spec.messages === 500 && spec.activeChars === 100 && !spec.expand) {
      const changeRuntime = async (fields) => {
        await app.evaluate(({ BrowserWindow }, fields) => {
          Object.assign(globalThis.auditRuntime, fields);
          BrowserWindow.getAllWindows()[0].webContents.send('desktop:event', {
            type: 'runtime',
            runtime: globalThis.auditRuntime,
          });
        }, fields);
        await page.evaluate(
          () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        );
      };
      const counts = () =>
        page.evaluate(() => ({ app: globalThis.auditAppRenders, composer: globalThis.auditComposerRenders }));
      await changeRuntime({ status: 'running', startedAt: Date.now() - 1000 });
      await expect(page.locator('.elapsed')).toBeVisible();
      const elapsed = await page.locator('.elapsed').textContent();
      const runningCounts = await counts();
      assert.ok(runningCounts.app > 0 && runningCounts.composer > 0);
      await expect.poll(() => page.locator('.elapsed').textContent()).not.toBe(elapsed);
      assert.deepEqual(await counts(), runningCounts, 'only the footer ticks while running');

      await changeRuntime({
        status: 'retrying',
        retry: {
          attempt: 1,
          maxAttempts: 3,
          phase: 'waiting',
          startedAt: Date.now(),
          delayMs: 5000,
        },
      });
      const retry = await page.locator('.retry-banner').textContent();
      const retryCounts = await counts();
      await expect.poll(() => page.locator('.retry-banner').textContent()).not.toBe(retry);
      assert.deepEqual(await counts(), retryCounts, 'retry countdown updates stay inside the feedback area');
      await changeRuntime({ status: 'stopping', retry: undefined, stopStartedAt: Date.now() - 14900 });
      await expect(page.getByRole('button', { name: '强制结束', exact: true })).toBeVisible();
      await changeRuntime({ status: 'completed', stopStartedAt: undefined });
      await expect(page.locator('.elapsed')).toHaveCount(0);
      assert.equal(await page.evaluate(() => globalThis.auditSecondTimers.size), 0);
      const idleCounts = await counts();
      await page.waitForTimeout(2200);
      assert.deepEqual(
        await counts(),
        idleCounts,
        'completion stops the former per-second application renders',
      );

      await app.evaluate(() => (globalThis.auditWorkspaceCalls = []));
      const userRenders = await page.evaluate(() => globalThis.auditUserRenders);
      assert.ok(userRenders > 0, 'the probe must observe initial user-message renders');
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect.poll(() => app.evaluate(() => globalThis.auditWorkspaceCalls)).toEqual(['changes']);
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
      assert.equal(await page.evaluate(() => globalThis.auditUserRenders), userRenders);
      result.idleAndFocus = {
        secondTimersAfterCompletion: 0,
        idleAppRenders: 0,
        idleComposerRenders: 0,
        focusRequests: ['changes'],
        focusUserRenders: 0,
      };
      console.log(
        'PASS isolated elapsed/retry timers, delayed force-stop, idle rendering and one-request focus refresh',
      );
    }
    const rendersBeforeTyping = await page.evaluate(() => globalThis.auditConversationRenders);
    assert.ok(rendersBeforeTyping > 0, 'the render probe must observe conversation updates');
    await input.pressSequentially('typing render regression');
    await expect(input).toHaveValue('typing render regression');
    assert.equal(
      await page.evaluate(() => globalThis.auditConversationRenders),
      rendersBeforeTyping,
      'typing must not render the conversation',
    );
    await input.fill('');
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
      await page.locator('.message').last().getByRole('button', { name: '自动换行', exact: true }).click();
      await page
        .locator('.message')
        .last()
        .locator('.message-content strong')
        .first()
        .evaluate((element) => {
          globalThis.auditCompletedParagraph = element;
          globalThis.auditMarkdownWork = [];
        });
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
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
      assert.equal(
        await page
          .locator('.message')
          .last()
          .locator('.message-content strong')
          .first()
          .evaluate((element) => element === globalThis.auditCompletedParagraph),
        true,
        'completion retains the already rendered paragraph DOM',
      );
      const completedWork = await page.evaluate(() => globalThis.auditMarkdownWork);
      assert.deepEqual(completedWork, [], 'unchanged completed Markdown blocks must not parse again');
      await expect(
        page.locator('.message').last().getByRole('button', { name: '自动换行', exact: true }),
      ).toHaveAttribute('aria-pressed', 'true');
      result.markdownCompletion = { retainedParagraph: true, reparsedCharacters: 0 };
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
      await app.evaluate(({ BrowserWindow }) => {
        const runtime = globalThis.auditRuntime;
        runtime.status = 'running';
        runtime.messages.at(-1).content =
          '[REFERENCE_LINK][target] and a note[^note].\n\n' +
          'Long reference document.\n\n'.repeat(750) +
          '\n[target]: https://example.invalid\n\n[^note]: FINAL_FOOTNOTE';
        BrowserWindow.getAllWindows()[0].webContents.send('desktop:event', { type: 'runtime', runtime });
      });
      await expect(page.locator('.streaming-markdown-text')).toContainText('REFERENCE_LINK');
      await app.evaluate(({ BrowserWindow }) => {
        globalThis.auditRuntime.status = 'completed';
        BrowserWindow.getAllWindows()[0].webContents.send('desktop:event', {
          type: 'runtime',
          runtime: globalThis.auditRuntime,
        });
      });
      await expect(
        page.locator('.message').last().locator('.inline-link').filter({ hasText: 'REFERENCE_LINK' }),
      ).toHaveCount(1);
      await expect(page.locator('.message').last().locator('[data-footnotes]')).toContainText(
        'FINAL_FOOTNOTE',
      );
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
