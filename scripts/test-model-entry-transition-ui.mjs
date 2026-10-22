import { _electron as electron } from 'playwright';
import { expect } from 'playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createLocalProvider, prepareRealPiFixture } from '../tests/support/local-provider.ts';

const provider = await createLocalProvider();
const f = await prepareRealPiFixture(provider.baseUrl, 'model-entry-transition-ui');
f.store.project(f.projectId).trusted = false;
f.store.session(f.sessionId).title = 'Protected project chat';
await f.store.save();
const output = path.resolve('test-results/model-entry-transition');
await fs.mkdir(output, { recursive: true });
let app, page;
const errors = [],
  evidence = [],
  protocolEvidence = [];
const selected = () => page.evaluate(() => window.entryState.selectedSessionId);
const calls = () => app.evaluate(() => globalThis.entryProbe.calls);
const modelReadCalls = async () => (await calls()).filter((call) => call.method === 'readModels');
const gate = (token, method, phase = 'after', id) =>
  app.evaluate(
    (_electron, config) => {
      const value = { ...config, used: false };
      value.ready = new Promise((resolve) => {
        value.enter = resolve;
      });
      value.wait = new Promise((resolve, reject) => {
        value.release = resolve;
        value.reject = reject;
      });
      globalThis.entryProbe.gates.push(value);
    },
    { token, method, phase, id },
  );
const entered = (token) =>
  app.evaluate(
    (_electron, token) => globalThis.entryProbe.gates.find((gate) => gate.token === token).ready,
    token,
  );
const release = (token, reject = false) =>
  app.evaluate(
    (_electron, { token, reject }) => {
      const value = globalThis.entryProbe.gates.find((gate) => gate.token === token);
      if (reject) value.reject(new Error('TEST_NAVIGATION_CANCELLED'));
      else value.release();
    },
    { token, reject },
  );
const capture = async (label) => {
  const state = await page.evaluate(() => {
    const id = window.entryState.selectedSessionId,
      button = document.querySelector('.model-pill');
    return {
      id,
      projectId: window.entryState.selectedProjectId,
      disabled: button.disabled,
      buttonLabel: button.textContent,
      open: button.getAttribute('aria-expanded'),
      runtime: window.entryRuntimes.get(id),
    };
  });
  evidence.push({ label, ...state, modelReadCalls: await modelReadCalls() });
};
try {
  app = await electron.launch({
    args: [path.resolve('.')],
    env: { ...process.env, PI_DESKTOP_DATA_DIR: f.dataDir, PI_OFFLINE: '1' },
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.getByRole('textbox', { name: '任务输入' }).waitFor();
  await page.evaluate(async () => {
    window.entryRuntimes = new Map();
    window.entryTransport = [];
    window.entryUnlocks = [];
    window.__navigationProbe = [];
    window.desktop.onEvent((event) => {
      if (event.type === 'state') {
        window.entryState = event.state;
        window.entryTransport.push({
          kind: 'state',
          id: event.state.selectedSessionId,
          phase: window.entryPhase,
          revision: event.revision,
          at: Date.now(),
        });
      }
      const runtime = event.runtime ?? event.patch;
      if (runtime?.sessionId) {
        const next = {
          ...window.entryRuntimes.get(runtime.sessionId),
          ...runtime,
        };
        for (const key of event.patch?.removed ?? []) delete next[key];
        window.entryRuntimes.set(runtime.sessionId, next);
      }
      if (event.type === 'runtimeRemoved') window.entryRuntimes.delete(event.sessionId);
    });
    const { state, runtime } = await window.desktop.invoke('bootstrap');
    window.entryState = state;
    if (runtime.sessionId) window.entryRuntimes.set(runtime.sessionId, runtime);
    new MutationObserver(() => {
      const phase = window.entryPhase;
      const button = document.querySelector('.model-pill');
      if (
        !window.entryAwaitUnlock ||
        !phase ||
        !button ||
        button.disabled ||
        window.entryUnlocks.some((entry) => entry.phase === phase)
      )
        return;
      window.entryUnlocks.push({
        phase,
        id: document.querySelector('.session-row.active')?.dataset.sessionId,
        eventStateId: window.entryState.selectedSessionId,
        at: Date.now(),
      });
    }).observe(document.body, { subtree: true, attributes: true, childList: true });
  });
  await app.evaluate(({ ipcMain, BrowserWindow }) => {
    const handler = ipcMain._invokeHandlers.get('desktop:invoke');
    globalThis.entryProbe = { gates: [], calls: [], replies: [], stateSent: [], transport: [] };
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    const send = contents.send;
    contents.send = function (channel, event, ...rest) {
      if (channel === 'desktop:event' && event?.type === 'state') {
        const entry = {
          kind: 'state-send',
          phase: globalThis.entryProbe.phase,
          id: event.state.selectedSessionId,
          revision: event.revision,
          at: Date.now(),
        };
        globalThis.entryProbe.stateSent.push(entry);
        globalThis.entryProbe.transport.push(entry);
      }
      return send.call(this, channel, event, ...rest);
    };
    ipcMain.removeHandler('desktop:invoke');
    ipcMain.handle('desktop:invoke', async (event, method, args) => {
      globalThis.entryProbe.calls.push({ method, id: args?.[0] });
      const gate = globalThis.entryProbe.gates.find(
        (g) => !g.used && g.method === method && (!g.id || g.id === args[0]),
      );
      if (gate) gate.used = true;
      if (gate?.phase === 'before') {
        gate.enter();
        await gate.wait;
      }
      const result = await handler(event, method, args);
      if (gate?.phase === 'after') {
        gate.resultId = result?.id;
        gate.enter();
        await gate.wait;
      }
      const reply = {
        kind: 'reply-send',
        phase: globalThis.entryProbe.phase,
        method,
        id: result?.id,
        stateId: result?.state?.selectedSessionId,
        revision: result?.revision,
        at: Date.now(),
      };
      globalThis.entryProbe.replies.push(reply);
      globalThis.entryProbe.transport.push(reply);
      return result;
    });
  });
  const button = page.getByRole('button', { name: '选择模型', exact: true });
  const newChat = () => page.getByRole('button', { name: /^新建对话/ }).click();
  const clickDisabled = async () => {
    await expect(button).toBeDisabled();
    const connectionButtons = page.locator('.run-meta').getByRole('button', { name: /连接|重连/ });
    await expect
      .poll(() =>
        connectionButtons.evaluateAll((controls) => controls.filter((control) => !control.disabled).length),
      )
      .toBe(0);
    const bounds = await button.boundingBox();
    await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await expect(page.getByRole('dialog', { name: '模型与推理级别' })).toHaveCount(0);
  };
  const readModels = async (id) => {
    await expect(button).toBeEnabled();
    await button.click();
    await page.waitForFunction(
      (id) =>
        Boolean(
          window.entryRuntimes.get(id)?.modelsLoaded &&
          !window.entryRuntimes.get(id)?.modelsLoading &&
          !window.entryRuntimes.get(id)?.connected &&
          window.entryRuntimes.get(id)?.model?.id === 'local-e2e' &&
          !document.querySelector('button[aria-label="发送任务"] .spin'),
        ),
      id,
    );
    await page.locator('.model-list [aria-current="true"]').waitFor();
    assert.equal(await selected(), id);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: '模型与推理级别' })).toHaveCount(0);
    // Looking up models leaves a blank chat reusable. A real draft makes the
    // next New Chat action exercise navigation to a different chat.
    const draft = `Navigation fixture ${id}`;
    await page.getByRole('textbox', { name: '任务输入' }).fill(draft);
    // Typing no longer broadcasts the full state; observe the saved draft directly.
    await expect
      .poll(async () => {
        const state = JSON.parse(await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8'));
        return state.sessions.find((session) => session.id === id)?.draft;
      })
      .toBe(draft);
  };
  const select = (id) => page.locator(`[data-session-id="${id}"] > button`).first().click();
  const nativeNewChat = () =>
    app.evaluate(({ Menu, BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      Menu.getApplicationMenu()
        .getMenuItemById('file')
        .submenu.items.find((item) => item.label === '新建对话')
        .click({}, win, win.webContents);
    });
  await expect(button).toBeDisabled();
  await expect(button).toHaveAttribute('title', '请先启用项目');
  await clickDisabled();
  assert.deepEqual(await modelReadCalls(), []);

  await gate('new-before', 'newSession', 'before');
  await newChat();
  await entered('new-before');
  await expect(button).toHaveText('会话切换中…');
  await clickDisabled();
  assert.equal(await selected(), f.sessionId);
  assert.deepEqual(await modelReadCalls(), []);
  await capture('old untrusted target: early mouse click is disabled');
  await release('new-before');
  await page.waitForFunction((old) => window.entryState.selectedSessionId !== old, f.sessionId);
  const a = await selected();
  await expect(button).toBeEnabled();
  assert.deepEqual(await modelReadCalls(), [], 'no deferred intent may connect after selection');
  await readModels(a);
  assert.deepEqual(
    (await modelReadCalls()).map((call) => call.id),
    [a],
  );
  console.log(
    'PASS quick new from an untrusted project disables the old entry and requires a fresh explicit click',
  );

  // Keep the real closed-picker event callback to exercise a stale event after
  // B is ready. This must remain bound to A even after layout effects settle.
  await button.evaluate((element) => {
    const key = Object.keys(element).find((key) => key.startsWith('__reactProps$'));
    window.entryOldClick = element[key]?.onClick;
    if (typeof window.entryOldClick !== 'function') throw new Error('Missing real picker click callback');
  });
  await gate('reload-a', 'readModels', 'after', a);
  await button.click();
  await entered('reload-a');
  await release('reload-a');
  await page.getByRole('dialog', { name: '模型与推理级别' }).waitFor();
  await page.waitForFunction(() => !document.querySelector('button[aria-label="发送任务"] .spin'));
  await gate('new-after', 'newSession');
  await newChat();
  await entered('new-after');
  const b = await selected();
  assert.notEqual(b, a);
  await clickDisabled();
  await capture('new target selected but reply held: entry remains disabled');
  await page.screenshot({ path: path.join(output, 'transition-disabled.png') });
  assert.deepEqual(
    (await modelReadCalls()).map((call) => call.id),
    [a, a],
  );
  await release('new-after');
  await expect(button).toBeEnabled();
  assert.deepEqual(
    (await modelReadCalls()).map((call) => call.id),
    [a, a],
  );
  await page.evaluate(async () => {
    window.entryOldClick();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  await expect(page.getByRole('dialog', { name: '模型与推理级别' })).toHaveCount(0);
  await expect(button).toHaveAttribute('aria-expanded', 'false');
  assert.deepEqual(
    (await modelReadCalls()).map((call) => call.id),
    [a, a],
    'the old click must neither open a picker for B nor connect a previous target',
  );
  await capture('stale A click after B settles cannot open or connect in the new context');
  await readModels(b);
  console.log(
    'PASS a selected new target stays disabled until IPC completion; the old picker never carries forward',
  );

  await gate('cancel-new', 'newSession', 'before');
  await newChat();
  await entered('cancel-new');
  await clickDisabled();
  await release('cancel-new', true);
  await page.locator('.error-banner').filter({ hasText: 'TEST_NAVIGATION_CANCELLED' }).waitFor();
  await expect(button).toBeEnabled();
  assert.equal(await selected(), b);
  assert.equal((await modelReadCalls()).length, 3);
  await page.locator('.error-banner .icon-button').first().click();

  await gate('old-select', 'selectSession', 'after', f.sessionId);
  await select(f.sessionId);
  await entered('old-select');
  await clickDisabled();
  await select(b);
  await expect(button).toBeEnabled();
  await release('old-select');
  await expect(button).toBeEnabled();
  assert.equal(await selected(), b);
  assert.equal((await modelReadCalls()).length, 3);
  console.log(
    'PASS failed creation releases the lock, and a newer selection supersedes an old held reply without connecting',
  );

  await gate('select-a', 'selectSession', 'after', a);
  await select(a);
  await entered('select-a');
  await gate('select-project', 'selectSession', 'after', f.sessionId);
  await select(f.sessionId);
  await entered('select-project');
  await release('select-a');
  await clickDisabled();
  await expect(button).toHaveText('会话切换中…');
  await release('select-project');
  await expect(button).toHaveText('请先启用项目');
  await clickDisabled();
  assert.equal((await modelReadCalls()).length, 3);
  await select(b);
  await expect(button).toBeEnabled();
  console.log('PASS an older completion cannot unlock a newer pending or untrusted target');

  await gate('menu-overrides-selection', 'selectSession', 'after', a);
  await select(a);
  await entered('menu-overrides-selection');
  await clickDisabled();
  await nativeNewChat();
  await page.waitForFunction((id) => window.entryState.selectedSessionId !== id, a);
  const menuTarget = await selected();
  await clickDisabled();
  await release('menu-overrides-selection');
  await expect(button).toBeEnabled();
  assert.equal(await selected(), menuTarget);
  assert.equal((await modelReadCalls()).length, 3);
  const input = page.getByRole('textbox', { name: '任务输入' });
  await input.fill('An explicit task could now be sent');
  await expect(page.getByRole('button', { name: '发送任务', exact: true })).toBeEnabled();
  await input.fill('');
  await capture('native File > New Chat supersedes the observed old target and survives its late reply');
  await page.screenshot({ path: path.join(output, 'external-menu-ready.png') });
  console.log('PASS native File > New Chat supersedes a held renderer selection without locking model/send');

  await select(b);
  await expect(button).toBeEnabled();
  await gate('delete-observed-selection', 'selectSession', 'after', menuTarget);
  await select(menuTarget);
  await entered('delete-observed-selection');
  const row = page.locator(`[data-session-id="${menuTarget}"]`);
  await row.getByRole('button', { name: /会话操作$/ }).click();
  await page.getByRole('menuitem', { name: '删除', exact: true }).click();
  await page
    .getByRole('dialog', { name: /^删除会话/ })
    .getByRole('button', { name: '删除', exact: true })
    .click();
  await page.waitForFunction(
    (id) => !window.entryState.sessions.some((session) => session.id === id),
    menuTarget,
  );
  const fallback = await selected();
  assert.notEqual(fallback, menuTarget);
  await clickDisabled();
  await release('delete-observed-selection');
  await expect(button).toBeEnabled();
  assert.equal(await selected(), fallback);
  assert.equal((await modelReadCalls()).length, 3);
  await capture('deleting the observed target selects a usable fallback despite the late response');
  console.log('PASS deleting an observed target keeps the confirmed fallback usable after its late reply');

  await nativeNewChat();
  await page.waitForFunction((id) => window.entryState.selectedSessionId !== id, fallback);
  const freshMenuTarget = await selected();
  await readModels(freshMenuTarget);
  assert.deepEqual(
    (await modelReadCalls()).map((call) => call.id),
    [a, a, b, freshMenuTarget],
  );

  await gate('older-observed', 'selectSession', 'after', a);
  await select(a);
  await entered('older-observed');
  await gate('newer-unobserved', 'selectSession', 'before', b);
  await select(b);
  await entered('newer-unobserved');
  await nativeNewChat();
  await page.waitForFunction((id) => window.entryState.selectedSessionId !== id, a);
  await clickDisabled();
  await release('older-observed');
  await clickDisabled();
  assert.equal((await modelReadCalls()).length, 4);
  await release('newer-unobserved');
  await expect(button).toBeEnabled();
  assert.equal(await selected(), b);
  assert.equal((await modelReadCalls()).length, 4);
  await capture('external navigation and older completion cannot release a newer unobserved request');
  console.log(
    'PASS external navigation does not release a newer unobserved target; its own completion restores it',
  );

  await gate('failed-confirmation', 'navigationState', 'before');
  await select(b);
  await entered('failed-confirmation');
  await release('failed-confirmation', true);
  await page.locator('.error-banner').filter({ hasText: '无法确认当前会话，请重新选择会话' }).waitFor();
  await clickDisabled();
  assert.equal((await modelReadCalls()).length, 4);
  await select(b);
  await expect(button).toBeEnabled();
  await expect(page.locator('.error-banner')).toHaveCount(0);
  console.log(
    'PASS a real confirmation failure stays disabled with a visible recovery action; fresh navigation recovers',
  );

  const projectNew = () =>
    page
      .getByRole('button', { name: `在 ${f.store.project(f.projectId).name} 中新建会话`, exact: true })
      .click();
  const startPhase = async (phase) => {
    await app.evaluate((_electron, phase) => {
      globalThis.entryProbe.phase = phase;
    }, phase);
    await page.evaluate((phase) => {
      window.entryPhase = phase;
      window.entryAwaitUnlock = false;
    }, phase);
  };
  const recordProtocol = async (phase, resultId) => {
    await page.waitForFunction(
      (phase) => window.entryTransport.filter((entry) => entry.phase === phase).length >= 2,
      phase,
    );
    const main = await app.evaluate(
      (_electron, phase) => globalThis.entryProbe.transport.filter((entry) => entry.phase === phase),
      phase,
    );
    const renderer = await page.evaluate(
      (phase) => ({
        events: window.entryTransport.filter((entry) => entry.phase === phase),
        unlock: window.entryUnlocks.find((entry) => entry.phase === phase),
        probe: window.__navigationProbe.filter((entry) => entry.phase === phase),
        busy: window.entryBusy,
      }),
      phase,
    );
    const id = await selected();
    assert.equal(renderer.unlock?.id, id);
    const confirmation = main
      .filter((entry) => entry.kind === 'reply-send' && entry.method === 'navigationState')
      .at(-1);
    assert.equal(confirmation?.stateId, id);
    assert.ok(
      confirmation.revision >
        Math.max(...main.filter((entry) => entry.kind === 'state-send').map((entry) => entry.revision)),
    );
    assert.equal(
      main.find((entry) => entry.kind === 'reply-send' && entry.method === 'newSession')?.id,
      resultId,
    );
    protocolEvidence.push({ phase, resultId, selected: id, main, renderer });
    await page.evaluate(() => {
      window.entryAwaitUnlock = false;
    });
    return { main, renderer, id };
  };

  await startPhase('C/C/B-busy');
  await app.evaluate(
    async (_electron, { file, projectId }) => {
      const io = process.getBuiltinModule('fs/promises');
      const original = io.writeFile;
      const value = { used: false };
      value.entered = new Promise((resolve) => {
        value.enter = resolve;
      });
      value.wait = new Promise((resolve) => {
        value.release = resolve;
      });
      globalThis.entryProbe.writeGate = value;
      globalThis.entryProbe.restoreWrite = () => {
        io.writeFile = original;
      };
      io.writeFile = async (...args) => {
        if (!value.used && String(args[0]) === file) {
          const state = JSON.parse(String(args[1]));
          // New untouched placeholders are deliberately absent from this durable
          // projection. Gate the project save, then use the actual IPC reply ID.
          if (state.selectedProjectId === projectId) {
            value.used = true;
            value.enter();
            await value.wait;
          }
        }
        return original(...args);
      };
    },
    { file: path.join(f.dataDir, 'state.json.tmp'), projectId: f.projectId },
  );
  await gate('cc-b-reply', 'newSession', 'after', f.projectId);
  await projectNew();
  await app.evaluate(() => globalThis.entryProbe.writeGate.entered);
  await clickDisabled();
  await nativeNewChat();
  await page.evaluate(() => {
    window.entryAwaitUnlock = true;
  });
  const busyStarted = page.waitForEvent('console', {
    predicate: (event) => event.text() === 'ENTRY_CPU_BUSY',
    timeout: 15000,
  });
  const busy = page.evaluate(() => {
    window.entryBusy = { start: Date.now() };
    console.log('ENTRY_CPU_BUSY');
    const end = performance.now() + 2000;
    while (performance.now() < end) {
      /* Deliberately queue normal incoming IPC while the renderer is busy. */
    }
    window.entryBusy.end = Date.now();
  });
  await busyStarted;
  await app.evaluate(() => globalThis.entryProbe.writeGate.release());
  await entered('cc-b-reply');
  const createdButUnpublished = await app.evaluate(
    () => globalThis.entryProbe.gates.find((gate) => gate.token === 'cc-b-reply').resultId,
  );
  assert.ok(createdButUnpublished);
  await expect
    .poll(() =>
      app.evaluate(
        () => globalThis.entryProbe.stateSent.filter((entry) => entry.phase === 'C/C/B-busy').length,
      ),
    )
    .toBeGreaterThanOrEqual(2);
  await release('cc-b-reply');
  await busy;
  await expect(button).toBeEnabled();
  const cc = await recordProtocol('C/C/B-busy', createdButUnpublished);
  assert.notEqual(cc.id, createdButUnpublished);
  assert.deepEqual(
    cc.main.filter((entry) => entry.kind === 'state-send').map((entry) => entry.id),
    [cc.id, cc.id],
  );
  assert.deepEqual(
    cc.renderer.events.map((entry) => entry.id),
    [cc.id, cc.id],
  );
  assert.ok(
    cc.main
      .filter((entry) => entry.kind === 'state-send' || entry.method === 'newSession')
      .every((entry) => entry.at >= cc.renderer.busy.start && entry.at <= cc.renderer.busy.end),
  );
  assert.ok(cc.renderer.events.every((entry) => entry.at >= cc.renderer.busy.end));
  await app.evaluate(() => globalThis.entryProbe.restoreWrite());
  await capture('normal saved C/C/B IPC with busy renderer unlocks only the authoritative C DOM');
  await page.screenshot({ path: path.join(output, 'protocol-authoritative-c.png') });
  console.log('PASS real saved C/C/B through normal IPC survives renderer CPU blocking and unlocks C');

  await startPhase('B/C/B');
  await gate('bc-b-reply', 'newSession', 'after', f.projectId);
  await projectNew();
  await entered('bc-b-reply');
  await clickDisabled();
  const earlierTarget = await app.evaluate(
    () => globalThis.entryProbe.gates.find((gate) => gate.token === 'bc-b-reply').resultId,
  );
  await nativeNewChat();
  await page.waitForFunction((id) => window.entryState.selectedSessionId !== id, earlierTarget);
  await clickDisabled();
  await page.evaluate(() => {
    window.entryAwaitUnlock = true;
  });
  await release('bc-b-reply');
  await expect(button).toBeEnabled();
  const bc = await recordProtocol('B/C/B', earlierTarget);
  assert.deepEqual(
    bc.main.filter((entry) => entry.kind === 'state-send').map((entry) => entry.id),
    [earlierTarget, bc.id],
  );
  assert.deepEqual(
    bc.renderer.events.map((entry) => entry.id),
    [earlierTarget, bc.id],
  );
  assert.notEqual(bc.id, earlierTarget);
  assert.equal((await modelReadCalls()).length, 4);
  await capture('normal B/C/B IPC does not restore or lock the returned B target');
  console.log('PASS real B/C/B through normal IPC unlocks current C without following the returned B');

  assert.equal(provider.requests.length, 0, 'navigation/model discovery must not send a model prompt');
  assert.deepEqual(
    (await calls()).filter((call) => call.method === 'connect'),
    [],
    'model discovery must never connect a conversation',
  );
  assert.ok(!(await modelReadCalls()).some((call) => call.id === f.sessionId));
  assert.deepEqual(errors, []);
  await fs.writeFile(
    path.join(output, 'result.json'),
    JSON.stringify(
      { passed: true, evidence, protocolEvidence, calls: await calls(), rendererErrors: errors },
      null,
      2,
    ),
  );
} catch (error) {
  await capture('failure').catch(() => {});
  await page?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  await fs.writeFile(
    path.join(output, 'failure.json'),
    JSON.stringify(
      {
        evidence,
        protocolEvidence,
        calls: await calls().catch(() => []),
        rendererErrors: errors,
        rendererTrace: await page
          ?.evaluate(() => ({
            events: window.entryTransport,
            unlocks: window.entryUnlocks,
            probe: window.__navigationProbe,
          }))
          .catch(() => undefined),
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await app
    ?.evaluate(() => {
      globalThis.entryProbe?.writeGate?.release();
      globalThis.entryProbe?.restoreWrite?.();
    })
    .catch(() => {});
  await app?.close();
  await provider.close();
}
