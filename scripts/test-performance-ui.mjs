import { launchApp, closeApp } from '../tests/support/desktop-app.mjs';
import { expect } from 'playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { emptyRuntime } from '../shared/types.ts';
import { Workspace } from '../electron/workspace.ts';
import { createLocalProvider, prepareRealPiFixture } from '../tests/support/local-provider.ts';

if (process.argv.includes('--glass')) {
  await benchmarkGlass();
  process.exit(process.exitCode ?? 0);
}

const provider = await createLocalProvider();
const fixture = await prepareRealPiFixture(provider.baseUrl, 'performance-regression-ui');
await new Workspace(fixture.dataDir).captureCheckpoint(
  fixture.store.state.projects.find((project) => project.id === fixture.projectId),
  fixture.sessionId,
  1,
  1700000000000,
);
const result = {
  note: 'Synthetic local data, no model calls. Frame timings include dispatch IPC, commit and next frame. rendererScripting is the CDP ScriptDuration delta, excluding dispatch and frame wait; component-count instrumentation is paused during timing. 5000-message cases measure 200 patches after 5 warmups.',
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
  const launched = await launchApp({
    dataDir: fixture.dataDir,
    pageTimeout: 60000,
    // Measure foreground interaction even when another desktop window covers the test window.
    args: [
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      process.env.PI_PERF_APP_ROOT || process.cwd(),
    ],
  });
  app = launched.app;
  const page = launched.page;

  // Count actual component executions via React's DevTools commit hook, excluding memo bailouts.
  // Match the conversation's props because production function names are minified.
  await page.addInitScript(() => {
    // The first ready frame starts a fresh environment probe on every document load.
    // Its event legitimately re-renders App/Composer and must finish before timer measurements.
    globalThis.auditEnvironmentReady = false;
    window.desktop.onEvent((event) => {
      if (event.type === 'environment') globalThis.auditEnvironmentReady = true;
      if (event.type === 'runtimePatch') globalThis.auditReceivedPatchAt = performance.now();
    });
    globalThis.auditConversationRenders = 0;
    globalThis.auditComposerRenders = 0;
    globalThis.auditAppRenders = 0;
    globalThis.auditUserRenders = 0;
    globalThis.auditSidebarRenders = 0;
    globalThis.auditToastRenders = 0;
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
    const toastTypes = new Set();
    globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      supportsFiber: true,
      inject: () => 1,
      onCommitFiberUnmount() {},
      onCommitFiberRoot(_id, root) {
        if (globalThis.auditPauseCounters) return;
        const currentFibers = new WeakSet();
        const visit = (fiber) => {
          // A memo bailout can reuse an entire subtree with old flags still attached.
          const worked = !previousFibers.has(fiber) && Boolean(fiber.flags & 1);
          currentFibers.add(fiber);
          if (
            (fiber.tag === 0 || fiber.tag === 15) &&
            fiber.child?.memoizedProps?.className === 'toast-stack'
          )
            toastTypes.add(fiber.type);
          if (worked && toastTypes.has(fiber.type)) globalThis.auditToastRenders++;
          if (fiber.memoizedProps?.messageContext && fiber.memoizedProps?.messages && worked)
            globalThis.auditConversationRenders++;
          if (fiber.memoizedProps?.m?.role === 'user' && worked) globalThis.auditUserRenders++;
          // UI17 起 Sidebar 接收 sidebarActivities；对比旧版（PI_PERF_APP_ROOT）时仍是 activities。
          if (
            fiber.memoizedProps?.updateBadge &&
            (fiber.memoizedProps.sidebarActivities || fiber.memoizedProps.activities) &&
            worked
          )
            globalThis.auditSidebarRenders++;
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
      if (method === 'saveDraft' && globalThis.auditDraftSaves) {
        globalThis.auditDraftSaves.push(performance.now());
        globalThis.auditSavedDraft = args[1];
      }
      if (method === 'readHistory' && globalThis.auditRuntime) return globalThis.auditRuntime.messages;
      if (method === 'getToolOutput' && globalThis.auditRuntime) {
        const message = globalThis.auditRuntime.messages.findLast(
          (message) => message.role === 'toolResult' && message.toolCallId === args[1],
        );
        return typeof message?.content === 'string'
          ? message.content
          : (globalThis.auditRuntime.tools.find((tool) => tool.id === args[1])?.output ?? '');
      }
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
    { messages: 500, activeChars: 10000, expand: false, brackets: true },
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
      const patch =
        '@@ -1,250 +1,250 @@\n' +
        Array.from(
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
    const block = spec.brackets
      ? 'Access arr[i] and [1, 2].\n\n- [x] checked\n- [ ] next\n\n'
      : 'A **formatted** paragraph with [a link](https://example.invalid).\n\n- first item\n- second item\n\n';
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
    await page.waitForFunction(() => globalThis.auditEnvironmentReady === true);
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    await page.evaluate(() => {
      globalThis.auditLongTasks = [];
      globalThis.auditLongTaskObserver = new PerformanceObserver((list) =>
        globalThis.auditLongTasks.push(...list.getEntries().map((e) => e.duration)),
      );
      globalThis.auditLongTaskObserver.observe({ type: 'longtask' });
      // Component counters walk every Fiber; exclude that test instrumentation from JS timings.
      globalThis.auditPauseCounters = true;
    });
    const durations = [];
    const scripting = [];
    const commits = [];
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    const scriptDuration = async () =>
      (await cdp.send('Performance.getMetrics')).metrics.find((metric) => metric.name === 'ScriptDuration')
        .value;
    for (let i = 0; i < (spec.messages === 5000 ? 205 : 35); i++) {
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
            const commit = performance.now() - globalThis.auditReceivedPatchAt;
            requestAnimationFrame(() => resolve({ frame: performance.now() - start, commit }));
          });
          observer.observe(document.querySelector('.thread'), {
            subtree: true,
            characterData: true,
            childList: true,
          });
        });
      }, marker);
      const scriptingBefore = await scriptDuration();
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
      const scriptingMs = ((await scriptDuration()) - scriptingBefore) * 1000;
      if (i >= 5) {
        durations.push(elapsed.frame);
        commits.push(elapsed.commit);
        scripting.push(scriptingMs);
      }
    }
    await page.evaluate(() => {
      globalThis.auditPauseCounters = false;
    });
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
        outlineRows: document.querySelectorAll('.turn-outline button[data-outline-index]').length,
        domElements: document.querySelectorAll('*').length,
      };
    });
    const item = {
      ...spec,
      ...summary(durations),
      rendererScripting: summary(scripting),
      receivedPatchToDom: summary(commits),
      rendererHeapAfterGcMiB: heap.usedSize / 1024 / 1024,
      dom,
      observation,
    };
    result.cases.push(item);
    console.log(JSON.stringify(item));
    assert.ok(observation.outlineButtons <= 60, 'outline DOM must stay bounded');
    assert.ok(observation.outlineRows <= 60, 'outline rows must stay bounded independently of filters');
    if (spec.messages === 5000 && !spec.patchLines) {
      const outline = page.getByRole('navigation', { name: '对话轮次' });
      const rows = outline.locator('button[data-outline-index]');
      await rows.last().focus();
      await rows.nth((await rows.count()) - 2).hover();
      await expect(outline.locator('.turn-copy')).toHaveCount(2);
      observation.outlineButtonsOnInteraction = await outline.locator('button').count();
      assert.ok(
        observation.outlineButtonsOnInteraction <= 60,
        'hover and keyboard copy controls must stay within the DOM budget',
      );
      await page.locator('.thread').focus();
      const viewport = await page.locator('.thread').boundingBox();
      await page.mouse.move(viewport.x + 20, viewport.y + 20);
    }
    assert.equal(observation.renderedMessages, spec.patchLines ? 40 : spec.expand ? spec.messages : 80);
    const input = page.getByRole('textbox', { name: '任务输入' });
    await input.fill('');
    if (spec.brackets) {
      await input.focus();
      await input.evaluate((element) => {
        globalThis.auditPauseCounters = true;
        globalThis.auditKeys = [];
        element.addEventListener('keydown', () => {
          const start = performance.now();
          requestAnimationFrame(() => globalThis.auditKeys.push(performance.now() - start));
        });
      });
      await app.evaluate(({ BrowserWindow }) => {
        globalThis.auditDraftSaves = [];
        globalThis.auditSavedDraft = '';
        const r = globalThis.auditRuntime;
        globalThis.auditTypingPatches = 0;
        globalThis.auditTypingTimer = setInterval(() => {
          r.messages.at(-1).content += ' 字';
          globalThis.auditTypingPatches++;
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
        }, 40);
      });
      try {
        await input.pressSequentially('x'.repeat(50), { delay: 20 });
        await expect(input).toHaveValue('x'.repeat(50));
        await page.waitForFunction(() => globalThis.auditKeys.length === 50);
        await expect.poll(() => app.evaluate(() => globalThis.auditSavedDraft)).toBe('x'.repeat(50));
        const { saves, patches } = await app.evaluate(() => ({
          saves: globalThis.auditDraftSaves,
          patches: globalThis.auditTypingPatches,
        }));
        assert.ok(patches > 0);
        const peakSaves = Math.max(
          ...saves.map((at) => saves.filter((other) => other >= at && other < at + 1000).length),
        );
        assert.ok(peakSaves <= 5);
        result.streamingTyping = {
          ...summary(await page.evaluate(() => globalThis.auditKeys)),
          peakSaves,
          patches,
        };
      } finally {
        await app.evaluate(() => clearInterval(globalThis.auditTypingTimer));
        await page.evaluate(() => {
          globalThis.auditPauseCounters = false;
        });
      }
      await input.fill('');
    }
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

      await page.getByRole('button', { name: '设置', exact: true }).click();
      await page.getByRole('button', { name: '关于与更新', exact: true }).click();
      const sendProgress = (percent) =>
        app.evaluate(({ BrowserWindow }, percent) => {
          BrowserWindow.getAllWindows()[0].webContents.send('desktop:event', {
            type: 'update',
            update: {
              currentVersion: '0.14.58',
              version: '0.14.59',
              installation: 'nsis',
              mode: 'auto',
              enabled: true,
              installing: false,
              state: 'downloading',
              progress: percent,
              size: 100 * 1024 ** 2,
              download: {
                transferred: percent * 1024 ** 2,
                total: 100 * 1024 ** 2,
                phase: 'transferring',
                differential: false,
                stalled: false,
                bytesPerSecond: 1024 ** 2,
                remainingMs: (100 - percent) * 1000,
              },
            },
          });
        }, percent);
      const updateCounts = () =>
        page.evaluate(() => ({
          app: globalThis.auditAppRenders,
          composer: globalThis.auditComposerRenders,
          conversation: globalThis.auditConversationRenders,
          sidebar: globalThis.auditSidebarRenders,
        }));
      await sendProgress(1);
      await expect(page.getByRole('progressbar', { name: '更新下载进度' })).toHaveAttribute('value', '1');
      const beforeProgress = await updateCounts();
      assert.ok(
        Object.values(beforeProgress).every((count) => count > 0),
        'render probes must observe every protected component',
      );
      for (let percent = 2; percent <= 6; percent++) {
        await page.waitForTimeout(1000);
        await sendProgress(percent);
        await expect(page.getByRole('progressbar', { name: '更新下载进度' })).toHaveAttribute(
          'value',
          String(percent),
        );
        assert.deepEqual(
          await updateCounts(),
          beforeProgress,
          'update progress must not render App, Composer, Conversation or Sidebar',
        );
      }
      result.updateProgress = {
        pushes: 6,
        intervalMs: 1000,
        app: 0,
        composer: 0,
        conversation: 0,
        sidebar: 0,
      };
      await page
        .getByRole('dialog', { name: '设置', exact: true })
        .locator(':scope > footer')
        .getByRole('button', { name: '关闭', exact: true })
        .click();
      console.log('PASS per-second update progress only renders update surfaces');

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
    if (spec.patchLines) {
      const cards = page.locator('.tool-card');
      assert.equal(await cards.count(), 20);
      assert.equal(await cards.locator('.tool-body').count(), 0, 'collapsed tools do not mount hidden diffs');
      const card = cards.last();
      await card.locator('summary').click();
      await expect(card.locator('.diff-row')).toHaveCount(500);
      await card.getByRole('button', { name: '复制输出', exact: true }).click();
      assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), 'Edited');
      await card.locator('.inline-diff').evaluate((element) => {
        element.scrollTop = 140;
      });
      await expect
        .poll(() => card.locator('.inline-diff').evaluate((element) => element.scrollTop))
        .toBe(140);
      await card.locator('summary').click();
      await expect(card.locator('.tool-body')).toHaveCount(0);
      await card.locator('summary').click();
      await expect(card.locator('.diff-row')).toHaveCount(500);
      await expect
        .poll(() => card.locator('.inline-diff').evaluate((element) => element.scrollTop))
        .toBe(140);
      await card.locator('summary').click();
      await input.press(process.platform === 'darwin' ? 'Meta+f' : 'Control+f');
      const find = page.getByRole('textbox', { name: '查找当前会话' });
      await find.fill('file-4996.ts');
      await expect(page.locator('.tool-card[open] .tool-search-content')).toContainText('file-4996.ts');
      await find.press('Escape');
      await expect(page.locator('.tool-search-content')).toHaveCount(0);
      console.log('PASS collapsed structured diffs, on-demand expansion, full output copy and search reveal');
      const outline = page.getByRole('navigation', { name: '对话轮次' });
      await outline.locator('button[data-outline-index]').first().focus();
      await expect(outline).toHaveClass(/expanded/);
      const modified = outline.getByRole('button', { name: '修改 1250', exact: true });
      await modified.click();
      await outline.locator('button[data-outline-index]').first().focus();
      await page.keyboard.press('Home');
      await expect(outline.locator('[data-outline-index="0"]')).toBeFocused();
      await page.keyboard.press('End');
      await expect(outline.locator('[data-outline-index="1249"]')).toBeFocused();
      assert.equal(
        await outline.locator('[data-outline-index="1249"]').getAttribute('data-turn-number'),
        '1250',
      );
      assert.ok((await outline.locator('button').count()) <= 60);
      assert.ok((await outline.locator('.turn-outline-row').count()) <= 60);
      assert.ok((await outline.locator('.turn-tick').count()) <= 80);
      await modified.click();
      console.log('PASS a 5,000-message modified-turn filter keeps keyboard navigation and DOM bounded');
    }
    if (item.p95Ms > 100) console.warn('Slow streaming update; inspect performance-ui.json on this host');
    if (spec.messages === 5000 && !spec.patchLines) {
      const outline = page.getByRole('navigation', { name: '对话轮次' });
      await outline.locator('button[data-outline-index]').first().focus();
      await page.keyboard.press('End');
      await expect(outline.locator('[data-outline-index="2499"]')).toBeFocused();
      await page.keyboard.press('Home');
      await expect(outline.locator('[data-outline-index="0"]')).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(page.locator('.message').filter({ hasText: 'Check module 0.' })).toBeVisible();
      assert.ok((await outline.locator('button').count()) <= 60);
      assert.ok((await outline.locator('.turn-outline-row').count()) <= 60);
      assert.ok((await outline.locator('.turn-tick').count()) <= 80);
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
  // A keyboard-only notice updates the actual store without injecting a runtime/state event.
  await app.evaluate(({ BrowserWindow }) => {
    const runtime = globalThis.auditRuntime;
    runtime.status = 'completed';
    runtime.tools = [];
    runtime.notifications = [];
    runtime.dialogs = [];
    runtime.messages = [1, 2, 3].map((turn) => ({
      role: 'user',
      content: `反馈检查 ${turn}`,
      timestamp: 1800000000000 + turn,
    }));
    BrowserWindow.getAllWindows()[0].webContents.send('desktop:event', { type: 'runtime', runtime });
  });
  await expect(page.locator('.message.user')).toHaveCount(3);
  const outlineRow = page.locator('.turn-outline-row').first();
  await outlineRow.focus();
  await page.waitForTimeout(250);
  await page.evaluate(() => {
    globalThis.auditPauseCounters = false;
    globalThis.auditConversationRenders =
      globalThis.auditComposerRenders =
      globalThis.auditSidebarRenders =
      globalThis.auditAppRenders =
      globalThis.auditToastRenders =
        0;
  });
  await outlineRow.press('c');
  await expect(page.locator('.toast')).toContainText('本轮没有可复制的回复');
  await expect(page.locator('.toast-stack')).toHaveCount(0, { timeout: 6000 });
  result.noticeCommits = await page.evaluate(() => ({
    app: globalThis.auditAppRenders,
    conversation: globalThis.auditConversationRenders,
    composer: globalThis.auditComposerRenders,
    sidebar: globalThis.auditSidebarRenders,
    toasts: globalThis.auditToastRenders,
  }));
  for (const key of ['app', 'conversation', 'composer', 'sidebar'])
    assert.equal(result.noticeCommits[key], 0, `${key} must not render for notice changes`);
  assert.ok(result.noticeCommits.toasts > 0);
  result.errors = errors;
  assert.deepEqual(errors, []);
  result.appMetrics = await app.evaluate(({ app }) =>
    app.getAppMetrics().map((p) => ({ type: p.type, cpu: p.cpu, memory: p.memory })),
  );
  await fs.writeFile(
    process.env.PI_PERF_RESULT || 'test-results/performance-ui.json',
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify({ firstLaunchToInputMs: result.firstLaunchToInputMs, errors }));
} finally {
  await closeApp(app);
  await provider.close();
}

/**
 * 1. 在 Windows 独立启动实色、玻璃以及禁用 GPU 合成后的两组窗口。
 * 2. 用同一段 5000 条消息测滚动、流式更新与空闲，记录 Electron CPU 和实际帧间隔。
 * 3. 保存原始结果和预算判定，硬件玻璃无法生效时将相应预算标为未测。
 */
async function benchmarkGlass() {
  const { prepareGlassFixture, loadGlassFixture } = await import('./test-glass-ui.mjs');
  const { default: path } = await import('node:path');
  const { default: os } = await import('node:os');
  const output = process.env.PI_PERF_RESULT || 'test-results/glass-performance-ui.json';
  const report = {
    platform: process.platform,
    os: os.release(),
    cpu: os.cpus()[0].model,
    viewport: [1280, 820],
    messages: 5000,
    cases: [],
  };
  // 1. 保持相同尺寸和独立数据目录。禁用 GPU 的比较两边使用相同启动参数。
  try {
    assert.equal(process.platform, 'win32', 'UI20 performance acceptance requires Windows Electron');
    for (const disableGpu of [false, true]) {
      for (const material of ['solid', 'glass']) {
        const sample = { material, disableGpu };
        report.cases.push(sample);
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-glass-perf-'));
        try {
          await collectGlassPerformance(sample, dir, prepareGlassFixture, loadGlassFixture);
        } finally {
          await fs.rm(dir, { recursive: true, force: true, maxRetries: 4 });
        }
      }
    }
    // 3. 一个模式无法生效时，保留其余实测，并给缺项单独标明原因。
    const [solid, glass, gpuOffSolid, gpuOffGlass] = report.cases;
    const activeCpu = (sample) => {
      const { scroll, stream } = sample;
      return (scroll.cpu * scroll.cpuMs + stream.cpu * stream.cpuMs) / (scroll.cpuMs + stream.cpuMs);
    };
    for (const sample of report.cases) if (sample.stream) sample.activeCpu = activeCpu(sample);
    const budgets = [];
    for (const [reference, candidate] of [
      [solid, glass],
      [gpuOffSolid, gpuOffGlass],
    ]) {
      if (reference.blocked || candidate.blocked) continue;
      assert.ok(reference.activeCpu > 0, 'Cannot compute a CPU percentage increase from a zero baseline');
      const actual = ((candidate.activeCpu - reference.activeCpu) / reference.activeCpu) * 100;
      budgets.push({
        metric: reference.disableGpu ? 'GPU-disabled active CPU difference (%)' : 'Active CPU increase (%)',
        actual: reference.disableGpu ? Math.abs(actual) : actual,
        limit: reference.disableGpu ? 5 : 15,
      });
      if (reference.disableGpu) continue;
      budgets.push(
        {
          metric: 'Active p95 frame interval increase (ms)',
          actual: candidate.p95Ms - reference.p95Ms,
          limit: 2,
        },
        {
          metric: 'Idle CPU difference (percentage points)',
          actual: Math.abs(candidate.idle.cpu - reference.idle.cpu),
          limit: 1,
        },
      );
    }
    report.budgets = budgets.map((budget) => ({ ...budget, passed: budget.actual <= budget.limit }));
    if (report.cases.some(({ blocked }) => blocked) || report.budgets.some(({ passed }) => !passed))
      process.exitCode = 1;
  } catch (error) {
    report.error = error.message;
    throw error;
  } finally {
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n');
    const cases = report.cases.map((sample) => ({
      material: sample.material,
      disableGpu: sample.disableGpu,
      effectiveMaterial: sample.presentation?.effectiveMaterial,
      blocked: sample.blocked,
      scrollCpu: sample.scroll?.cpu,
      streamCpu: sample.stream?.cpu,
      activeCpu: sample.activeCpu,
      idleCpu: sample.idle?.cpu,
      p95Ms: sample.p95Ms,
    }));
    await new Promise((resolve) =>
      process.stdout.write(
        JSON.stringify({ cases, budgets: report.budgets, error: report.error, output }, null, 2) + '\n',
        resolve,
      ),
    );
  }
}

async function collectGlassPerformance(sample, dir, prepareFixture, loadFixture) {
  const runtime = await prepareFixture(dir, sample.material);
  runtime.tools = [];
  runtime.messages = Array.from({ length: 5000 }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user',
    content:
      index % 2
        ? `Glass load ${index + 1}.\n\n- Verify input\n- Report results\n\n\`\`\`ts\nconst result = ${index};\n\`\`\``
        : `Review item ${index + 1} and report the expected output.`,
    timestamp: 1700000000000 + index,
  }));
  const { app, page, errors } = await launchApp({
    dataDir: dir,
    args: [
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      ...(sample.disableGpu ? ['--disable-gpu-compositing'] : []),
      process.cwd(),
    ],
  });
  try {
    await loadFixture({ app, page }, runtime);
    await expect(page.locator('.message.assistant').last()).toContainText('Glass load 5000.');
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() => !document.documentElement.hasAttribute('data-resizing'));
    sample.environment = await app.evaluate(async ({ app, BrowserWindow, powerMonitor }) => {
      const window = BrowserWindow.getAllWindows()[0];
      const gpu = await app.getGPUInfo('complete');
      return {
        electron: process.versions.electron,
        gpuCompositing: app.getGPUFeatureStatus().gpu_compositing,
        gpuDevices: gpu.gpuDevice,
        gpuRenderer: gpu.auxAttributes?.glRenderer,
        onBattery: powerMonitor.isOnBatteryPower(),
        viewport: window.getContentSize(),
      };
    });
    if (
      !sample.disableGpu &&
      sample.material === 'glass' &&
      sample.environment.gpuCompositing === 'enabled' &&
      !sample.environment.onBattery &&
      !(await page.evaluate(() => matchMedia('(prefers-reduced-transparency: reduce)').matches))
    )
      await expect(page.locator('html')).toHaveAttribute('data-material', 'glass');
    sample.presentation = await page.evaluate(() => ({
      effectiveMaterial: document.documentElement.dataset.material ?? 'solid',
      reducedTransparency: matchMedia('(prefers-reduced-transparency: reduce)').matches,
      sidebarBlur: getComputedStyle(document.querySelector('.sidebar'), '::before').backdropFilter,
    }));
    if (!sample.disableGpu && sample.environment.gpuCompositing !== 'enabled') {
      sample.blocked = `GPU compositing is ${sample.environment.gpuCompositing}`;
      return;
    }
    if (
      !sample.disableGpu &&
      sample.material === 'glass' &&
      (sample.environment.onBattery || sample.presentation.reducedTransparency)
    ) {
      sample.blocked = 'The host power or transparency preference prevents normal glass rendering';
      return;
    }
    const glass = sample.material === 'glass' && !sample.disableGpu;
    if (sample.disableGpu) assert.notEqual(sample.environment.gpuCompositing, 'enabled');
    assert.equal(sample.presentation.effectiveMaterial, glass ? 'glass' : 'solid');
    assert.equal(sample.presentation.sidebarBlur !== 'none', glass);
    assert.deepEqual(sample.environment.viewport, [1280, 820]);

    // 2. 在原生渲染窗口运行真实滚动与 IPC 流式更新。空闲阶段不挂 rAF。
    const thread = page.locator('.thread');
    const scroll = await measureGlassCpu(app, () =>
      thread.evaluate(
        (element) =>
          new Promise((resolve) => {
            const frames = [];
            const distance = element.scrollHeight - element.clientHeight;
            requestAnimationFrame((start) => {
              let previous = start;
              let minimum = distance;
              const frame = (now) => {
                frames.push(now - previous);
                previous = now;
                const elapsed = Math.min(now - start, 10_000);
                element.scrollTop = distance * Math.abs(elapsed / 5_000 - 1);
                minimum = Math.min(minimum, element.scrollTop);
                if (elapsed === 10_000) resolve({ frames, traveled: distance - minimum });
                if (elapsed < 10_000) requestAnimationFrame(frame);
              };
              requestAnimationFrame(frame);
            });
          }),
      ),
    );
    assert.ok(scroll.work.traveled > 0, 'The long transcript must actually scroll');
    const startStream = await app.evaluate(({ BrowserWindow }) => {
      const runtime = globalThis.glassFixtureRuntime;
      runtime.status = 'running';
      runtime.messages.at(-1).content += '\n\nGlass stream begins';
      BrowserWindow.getAllWindows()[0].webContents.send('desktop:event', { type: 'runtime', runtime });
      return runtime.messages.length;
    });
    assert.equal(startStream, 5000);
    const stop = page.getByRole('button', { name: '停止任务', exact: true });
    await expect(stop).toBeVisible();
    await expect(page.locator('.message.assistant').last()).toContainText('Glass stream begins');
    const stream = await measureGlassCpu(app, async () => {
      const collect = page.evaluate(
        () =>
          new Promise((resolve) => {
            const frames = [];
            requestAnimationFrame((start) => {
              let previous = start;
              const frame = (now) => {
                frames.push(now - previous);
                previous = now;
                if (now - start >= 30_000) resolve(frames);
                if (now - start < 30_000) requestAnimationFrame(frame);
              };
              requestAnimationFrame(frame);
            });
          }),
      );
      await app.evaluate(async ({ BrowserWindow }) => {
        const { webContents } = BrowserWindow.getAllWindows()[0];
        const runtime = globalThis.glassFixtureRuntime;
        const message = runtime.messages.at(-1);
        const start = performance.now();
        for (let i = 1; i <= 300; i++) {
          await new Promise((resolve) =>
            setTimeout(resolve, Math.max(0, start + i * 100 - performance.now())),
          );
          message.content += `\n\nGlass stream update ${i}.`;
          webContents.send('desktop:event', {
            type: 'runtimePatch',
            patch: {
              sessionId: runtime.sessionId,
              messagesFrom: runtime.messages.length - 1,
              messages: [message],
              messageCount: runtime.messages.length,
              toolsFrom: 0,
              tools: [],
              toolCount: 0,
            },
          });
        }
      });
      const frames = await collect;
      await expect(page.locator('.message.assistant').last()).toContainText('Glass stream update 300.');
      return frames;
    });
    await app.evaluate(({ BrowserWindow }) => {
      const runtime = globalThis.glassFixtureRuntime;
      runtime.status = 'completed';
      BrowserWindow.getAllWindows()[0].webContents.send('desktop:event', { type: 'runtime', runtime });
    });
    await expect(stop).toHaveCount(0);
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    const idle = await measureGlassCpu(app, () => new Promise((resolve) => setTimeout(resolve, 30_000)));
    assert.deepEqual(errors, []);
    const frameP95 = (frames) => {
      assert.ok(frames.length > 0, 'A foreground Electron window must produce frame samples');
      return frames.toSorted((a, b) => a - b)[Math.ceil(frames.length * 0.95) - 1];
    };
    sample.scroll = {
      ...scroll.metrics,
      traveled: scroll.work.traveled,
      frames: scroll.work.frames.length,
      p95Ms: frameP95(scroll.work.frames),
    };
    sample.stream = { ...stream.metrics, frames: stream.work.length, p95Ms: frameP95(stream.work) };
    sample.idle = idle.metrics;
    sample.p95Ms = frameP95([...scroll.work.frames, ...stream.work]);
  } finally {
    await closeApp(app);
  }
}

async function measureGlassCpu(app, work) {
  await app.evaluate(({ app, BrowserWindow }) => {
    const rendererPid = BrowserWindow.getAllWindows()[0].webContents.getOSProcessId();
    const byType = { Browser: 0, Tab: 0, GPU: 0 };
    let last = performance.now();
    const select = () =>
      app
        .getAppMetrics()
        .filter((entry) => entry.type === 'GPU' || entry.pid === process.pid || entry.pid === rendererPid);
    const processes = new Map();
    const start = performance.now();
    for (const entry of select()) processes.set(entry.pid, entry.type);
    let samples = 0;
    const sample = () => {
      const entries = select();
      const now = performance.now();
      for (const entry of entries) {
        processes.set(entry.pid, entry.type);
        byType[entry.type] += entry.cpu.percentCPUUsage * (now - last);
      }
      last = now;
      samples++;
    };
    const timer = setInterval(sample, 500);
    globalThis.finishGlassCpu = () => {
      clearInterval(timer);
      sample();
      const ms = last - start;
      const percentages = Object.fromEntries(
        Object.entries(byType).map(([type, value]) => [type, value / ms]),
      );
      return {
        cpu: Object.values(percentages).reduce((sum, value) => sum + value, 0),
        byType: percentages,
        processes: Array.from(processes, ([pid, type]) => ({ pid, type })),
        cpuMs: ms,
        samples,
      };
    };
  });
  const result = await work();
  const metrics = await app.evaluate(() => globalThis.finishGlassCpu());
  assert.ok(metrics.processes.some(({ type }) => type === 'Browser'));
  assert.ok(metrics.processes.some(({ type }) => type === 'Tab'));
  assert.ok(
    metrics.cpuMs >= 10_000 && metrics.samples > 1,
    `CPU sampling ended before the scheduled workload: ${metrics.samples} samples over ${metrics.cpuMs} ms`,
  );
  return { work: result, metrics };
}
