// Real Electron renderer/IPC and unmodified Pi against the isolated local provider.
// The no-agent cases hold readHistory before its production handler and pause the real
// filesystem writer; no Store, SessionAgents, main close handler or save result is mocked.
import { launchApp, closeApp } from '../tests/support/desktop-app.mjs';
import { expect } from 'playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Store } from '../electron/store.ts';
import { completeExpectedExit } from './expected-exit.ts';
import { createLocalProvider, prepareRealPiFixture } from '../tests/support/local-provider.ts';

const provider = await createLocalProvider();
const f = await prepareRealPiFixture(provider.baseUrl, 'placeholder-lifecycle-ui');
const output = path.resolve('test-results/placeholder-lifecycle');
await fs.mkdir(output, { recursive: true });
const evidence = [],
  errors = [],
  permanent = new Set(),
  unused = new Set();
f.store.session(f.sessionId).title = 'Retained legacy conversation';
permanent.add(f.sessionId);
const legacyRace = f.store.createSession();
const legacyCleanup = f.store.createSession();
const secondProject = {
  id: 'placeholder-second-project',
  name: 'Placeholder second project',
  path: path.join(f.dir, 'second-project'),
  trusted: true,
  createdAt: Date.now(),
};
await fs.mkdir(secondProject.path);
f.store.state.projects.push(secondProject);
f.store.selectSession(f.sessionId);
await f.store.save();
let app, page;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const invoke = (method, ...args) =>
  page.evaluate(({ method, args }) => window.desktop.invoke(method, ...args), { method, args });
const navigation = async () => (await invoke('navigationState')).state;
const bootstrap = () => invoke('bootstrap');
const input = () => page.getByRole('textbox', { name: '任务输入' });
async function launch(dataDir = f.dataDir, launcher) {
  ({ app, page } = await launchApp({
    executablePath: launcher ? undefined : process.env.PI_DESKTOP_EXE,
    args: launcher ? [launcher] : process.env.PI_DESKTOP_EXE ? [] : [path.resolve('.')],
    dataDir: dataDir,
    pageTimeout: 45000,
    errors: errors,
  }));

  await app.evaluate(({ ipcMain }) => {
    const handler = ipcMain._invokeHandlers.get('desktop:invoke');
    globalThis.placeholderNavigation = [];
    ipcMain.removeHandler('desktop:invoke');
    ipcMain.handle('desktop:invoke', async (event, method, args) => {
      const entry = { method, scope: args[0], done: false };
      if (['newSession', 'navigationState', 'readModels'].includes(method))
        globalThis.placeholderNavigation.push(entry);
      try {
        const result = await handler(event, method, args);
        if (method === 'newSession') entry.result = structuredClone(result);
        if (method === 'navigationState') {
          entry.selectedId = result.state.selectedSessionId;
          entry.revision = result.revision;
        }
        entry.done = true;
        return result;
      } catch (error) {
        entry.error = String(error);
        entry.done = true;
        throw error;
      }
    });
  });
  await input().waitFor();
}
const rendered = () =>
  page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function newChat(scope) {
  const before = await app.evaluate(() => globalThis.placeholderNavigation.length);
  if (scope) await page.getByRole('button', { name: `在 ${scope.name} 中新建会话`, exact: true }).click();
  else await page.locator('.new-session').click();
  // Observe the actual operation result and the renderer's subsequent completion
  // read. Same-scope and reused-ID requests must not pass on the old enabled UI.
  await expect
    .poll(() =>
      app.evaluate((_electron, before) => {
        const calls = globalThis.placeholderNavigation.slice(before);
        const created = calls.find((entry) => entry.method === 'newSession');
        if (!created?.done || created.error || !created.result) return false;
        return calls.some(
          (entry) =>
            entry.method === 'navigationState' && entry.done && entry.selectedId === created.result.id,
        );
      }, before),
    )
    .toBe(true);
  const result = await app.evaluate(
    (_electron, before) =>
      globalThis.placeholderNavigation.slice(before).find((entry) => entry.method === 'newSession').result,
    before,
  );
  await expect(page.locator(`[data-session-id="${result.id}"].active`)).toBeVisible();
  await rendered();
  await expect(page.getByRole('button', { name: '选择模型', exact: true })).toBeEnabled();
  await expect(input()).toHaveValue(result.draft);
  const state = await navigation();
  assert.equal(state.selectedSessionId, result.id);
  assert.equal(state.selectedProjectId, scope?.id);
  return result;
}
async function select(id) {
  await invoke('selectSession', id);
  await expect.poll(async () => (await navigation()).selectedSessionId).toBe(id);
  await expect(page.locator(`[data-session-id="${id}"].active`)).toBeVisible();
  await rendered();
  const selected = (await navigation()).sessions.find((session) => session.id === id);
  await expect(input()).toHaveValue(selected.draft);
}
async function waitField(id, field, expected) {
  await expect
    .poll(async () => (await navigation()).sessions.find((session) => session.id === id)?.[field])
    .toEqual(expected);
}
async function quit() {
  const closing = app.waitForEvent('close', { timeout: 60000 });
  await app.evaluate(({ app }) => {
    setImmediate(() => app.quit());
  });
  await closing;
  app = undefined;
}
async function indexes(dataDir = f.dataDir) {
  const names = (await fs.readdir(dataDir)).filter((name) => /^state(?:\.backup-[123])?\.json$/.test(name));
  return Promise.all(
    names.map(async (name) => ({
      name,
      state: JSON.parse(await fs.readFile(path.join(dataDir, name), 'utf8')),
    })),
  );
}
function validSelection(state) {
  if (!state.selectedSessionId) return;
  const selected = state.sessions.find((session) => session.id === state.selectedSessionId);
  assert.ok(selected, 'saved selection must refer to an included ID');
  assert.equal(state.selectedProjectId, selected.projectId);
}
async function capture(label) {
  const value = await bootstrap();
  evidence.push({
    label,
    revision: value.revision,
    state: value.state,
    runtime: {
      connected: value.runtime.connected,
      sessionId: value.runtime.sessionId,
      modelsLoading: value.runtime.modelsLoading,
    },
    requests: provider.requests.length,
  });
  await page.screenshot({ path: path.join(output, `${label}.png`), animations: 'disabled' });
}
async function modelMenu() {
  const before = await app.evaluate(() => globalThis.placeholderNavigation.length);
  const id = (await navigation()).selectedSessionId;
  const { runtime } = await bootstrap();
  const cached = runtime.sessionId === id && runtime.modelsLoaded;
  await page.getByRole('button', { name: '选择模型', exact: true }).click();
  const menu = page.getByRole('dialog', { name: '模型与推理级别' });
  await menu.waitFor();
  if (!cached)
    await expect
      .poll(() =>
        app.evaluate(
          (_electron, { before, id }) =>
            globalThis.placeholderNavigation
              .slice(before)
              .some(
                (entry) => entry.method === 'readModels' && entry.scope === id && entry.done && !entry.error,
              ),
          { before, id },
        ),
      )
      .toBe(true);
  await rendered();
  if (cached)
    assert.equal(
      await app.evaluate(
        (_electron, { before, id }) =>
          globalThis.placeholderNavigation
            .slice(before)
            .filter((entry) => entry.method === 'readModels' && entry.scope === id).length,
        { before, id },
      ),
      0,
      'a reused placeholder keeps its catalog without another metadata reader',
    );
  await expect(menu.getByRole('option').first()).toBeEnabled();
  return menu;
}
async function makeNoAgentLauncher(dataDir, label) {
  const directory = path.join(f.dir, `no-agent-${label}-launcher`);
  await fs.mkdir(directory);
  const pkg = JSON.parse(await fs.readFile('package.json', 'utf8'));
  await fs.writeFile(
    path.join(directory, 'package.json'),
    JSON.stringify({ name: 'pi-placeholder-close-fixture', version: pkg.version, main: 'main.cjs' }),
  );
  await fs.writeFile(
    path.join(directory, 'main.cjs'),
    `
const { app, ipcMain } = require('electron');
const fs = require('node:fs/promises');
app.setAppPath(${JSON.stringify(path.resolve('.'))});
const probe = globalThis.placeholderLifecycleProbe = { calls: [], heldHistory: 0, writeEntered: false, arm: undefined };
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) => handle(channel, channel === 'desktop:invoke' ? async (event, method, args) => {
  probe.calls.push({ method, id: args[0] });
  if (method === 'readHistory') {
    probe.heldHistory++;
    await new Promise(() => {});
  }
  return handler(event, method, args);
} : handler);
const write = fs.writeFile;
fs.writeFile = async function(...args) {
  if (probe.arm && String(args[0]) === ${JSON.stringify(path.join(dataDir, 'state.json.tmp'))} && String(args[1]).includes(probe.arm.marker)) {
    const arm = probe.arm;
    probe.arm = undefined;
    probe.writeEntered = true;
    await new Promise(resolve => { probe.releaseWrite = resolve; });
    if (arm.fail) throw Object.assign(new Error('placeholder UI ENOSPC fixture'), { code: 'ENOSPC' });
  }
  return write.apply(this, args);
};
require(${JSON.stringify(path.resolve('dist-electron/main.cjs'))});
`,
  );
  return directory;
}
async function noAgentFixture(label) {
  const dataDir = path.join(f.dir, `no-agent-${label}-data`);
  const store = new Store(dataDir);
  await store.load();
  store.state.settings = { ...f.store.state.settings };
  await store.save();
  const launcher = await makeNoAgentLauncher(dataDir, label);
  await launch(dataDir, launcher);
  await expect
    .poll(() => app.evaluate(() => globalThis.placeholderLifecycleProbe.heldHistory))
    .toBeGreaterThan(0);
  const state = await navigation();
  assert.equal(state.sessions.length, 1);
  assert.equal((await bootstrap()).runtime.connected, false);
  return { dataDir, id: state.selectedSessionId };
}
try {
  await launch();
  assert.equal(
    await page.locator('.sidebar-footer').getByRole('button', { name: '清理空会话', exact: true }).count(),
    0,
  );
  const blank = await newChat();
  unused.add(blank.id);
  assert.equal((await newChat()).id, blank.id);
  await select(f.sessionId);
  await expect(page.locator(`[data-session-id="${blank.id}"]`)).toHaveCount(0);
  await invoke('saveSettings', { theme: 'dark', sidebarWidth: 250 });
  await invoke('saveView', f.sessionId, 12, []);
  await invoke('usageSummary');
  for (const { state } of await indexes()) {
    validSelection(state);
    assert.equal(
      state.sessions.some((session) => session.id === blank.id),
      false,
    );
  }
  console.log(
    'PASS real Electron New/leave/unrelated saves exclude untouched IDs from current index and backups',
  );

  // Legacy cleanup stays explicit and discoverable in Settings; the real confirmation
  // rechecks a late draft and still removes a separate eligible legacy row.
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '诊断与数据', exact: true }).click();
  await page.getByRole('button', { name: '清理空会话', exact: true }).click();
  const cleanup = page.getByRole('dialog', { name: /清理 .* 个空会话/ });
  await cleanup.waitFor();
  await invoke('saveDraft', legacyRace.id, 'legacy draft arriving during confirmation', [], [], []);
  await cleanup.getByRole('button', { name: '清理空会话', exact: true }).click();
  await expect
    .poll(async () => (await navigation()).sessions.some((session) => session.id === legacyCleanup.id))
    .toBe(false);
  await waitField(legacyRace.id, 'draft', 'legacy draft arriving during confirmation');
  permanent.add(legacyRace.id);
  await page.getByRole('button', { name: '关闭', exact: true }).last().click();
  assert.equal(
    (await navigation()).sessions.some((session) => session.id === blank.id),
    false,
  );
  console.log(
    'PASS Settings legacy cleanup confirms and protects a late draft without exposing hidden transients',
  );

  const selectedBeforeLateDraft = (await navigation()).selectedSessionId;
  await invoke('saveDraft', blank.id, 'late draft for original ID', [], [], []);
  unused.delete(blank.id);
  permanent.add(blank.id);
  assert.equal((await navigation()).selectedSessionId, selectedBeforeLateDraft);
  await waitField(blank.id, 'draft', 'late draft for original ID');
  await invoke('saveDraft', blank.id, '', [], [], []);

  const typed = await newChat();
  permanent.add(typed.id);
  await input().fill(' ');
  await waitField(typed.id, 'draft', ' ');
  await input().fill('');
  await waitField(typed.id, 'draft', '');
  await select(f.sessionId);
  await expect(page.locator(`[data-session-id="${typed.id}"]`)).toBeVisible();

  const image = {
    id: 'pixel',
    name: 'pixel.png',
    mimeType: 'image/png',
    data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2sWQAAAAASUVORK5CYII=',
  };
  for (const [label, payload] of [
    ['attachment', ['', ['输入 文件.txt'], [], []]],
    ['image', ['', [], [image], []]],
    ['snippet', ['', [], [], [{ id: 'snippet', offset: 0, text: 'retained snippet' }]]],
  ]) {
    const selected = await newChat();
    permanent.add(selected.id);
    await invoke('saveDraft', selected.id, ...payload);
    await invoke('saveDraft', selected.id, '', [], [], []);
    await select(f.sessionId);
    assert.ok(
      (await navigation()).sessions.some((session) => session.id === selected.id),
      label,
    );
  }
  console.log(
    'PASS late IPC, whitespace, attachments, images and snippets stay durable after clearing without selection theft',
  );

  const passive = await newChat();
  await modelMenu();
  const passiveState = await bootstrap();
  assert.equal(passiveState.runtime.connected, false);
  assert.equal(passiveState.state.sessions.find((session) => session.id === passive.id).model, undefined);
  assert.equal(passiveState.state.sessions.find((session) => session.id === passive.id).file, undefined);
  await page.keyboard.press('Escape');
  await select(f.sessionId);
  unused.add(passive.id);
  await expect(page.locator(`[data-session-id="${passive.id}"]`)).toHaveCount(0);
  assert.equal(provider.requests.length, 0, 'metadata browsing must not send a provider prompt');

  const model = await newChat();
  assert.equal(model.id, passive.id, 'a finished passive catalog read leaves the same placeholder reusable');
  const menu = await modelMenu();
  await menu.locator('[role="option"][aria-current="true"]').click();
  await waitField(model.id, 'model', { provider: 'local-e2e', id: 'local-e2e' });
  unused.delete(model.id);
  permanent.add(model.id);
  await select(f.sessionId);
  const thinking = await newChat();
  const thinkingMenu = await modelMenu();
  await thinkingMenu.getByRole('radio', { name: 'off', exact: true }).click();
  await waitField(thinking.id, 'thinking', 'off');
  await page.keyboard.press('Escape');
  permanent.add(thinking.id);
  await select(f.sessionId);
  const approval = await newChat();
  await page.getByRole('button', { name: '审批模式', exact: true }).click();
  await page.getByRole('menuitemradio', { name: /^全自动/ }).click();
  await waitField(approval.id, 'approvalMode', 'auto');
  permanent.add(approval.id);
  await select(f.sessionId);
  assert.equal(provider.requests.length, 0);
  console.log(
    'PASS real Pi catalog-only browsing remains temporary; explicit current model/off/auto clicks persist',
  );

  const renamed = await newChat();
  permanent.add(renamed.id);
  const row = page.locator(`[data-session-id="${renamed.id}"]`);
  await row.getByRole('button', { name: '新对话 会话操作', exact: true }).click();
  await page.getByRole('menuitem', { name: '重命名', exact: true }).click();
  const rename = page.getByRole('dialog', { name: '重命名会话', exact: true });
  await rename.getByRole('textbox', { name: '新名称', exact: true }).fill('新对话');
  await rename.getByRole('button', { name: '保存', exact: true }).click();
  await rename.waitFor({ state: 'hidden' });
  await row.getByRole('button', { name: '新对话 会话操作', exact: true }).click();
  await page.getByRole('menuitem', { name: '置顶', exact: true }).click();
  await waitField(renamed.id, 'pinned', true);
  await row.getByRole('button', { name: '新对话 会话操作', exact: true }).click();
  await page.getByRole('menuitem', { name: '取消置顶', exact: true }).click();
  await waitField(renamed.id, 'pinned', false);
  await select(f.sessionId);

  const task = await newChat();
  permanent.add(task.id);
  await input().fill('E2E_USAGE placeholder lifecycle actual task');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect.poll(async () => (await bootstrap()).runtime.status, { timeout: 60000 }).toBe('completed');
  assert.ok(provider.requests.length > 0, 'unmodified Pi must reach the local provider for the task');
  await capture('durable-choices');

  const deleted = await newChat();
  const deletedId = deleted.id;
  await page
    .locator(`[data-session-id="${deletedId}"]`)
    .getByRole('button', { name: '新对话 会话操作', exact: true })
    .click();
  await page.getByRole('menuitem', { name: '删除', exact: true }).click();
  const deletion = page.getByRole('dialog', { name: /删除会话/ });
  await deletion.getByRole('button', { name: '删除', exact: true }).click();
  await expect
    .poll(async () => (await navigation()).sessions.some((session) => session.id === deletedId))
    .toBe(false);
  await assert.rejects(
    invoke('saveDraft', deletedId, 'late write after explicit deletion', [], [], []),
    /会话不存在/,
  );
  const afterDelete = await newChat();
  assert.notEqual(afterDelete.id, deletedId);
  unused.add(afterDelete.id);

  const scope = await newChat(secondProject);
  unused.add(scope.id);
  await invoke('saveSettings', { sidebarWidth: 251 });
  await capture('selected-temporary-project');
  await quit();
  for (const { state } of await indexes()) {
    validSelection(state);
    for (const id of unused)
      assert.equal(
        state.sessions.some((session) => session.id === id),
        false,
      );
    assert.equal(
      state.sessions.some((session) => session.id === deletedId),
      false,
    );
  }
  await launch();
  const restarted = await navigation();
  assert.equal(restarted.selectedProjectId, secondProject.id);
  assert.notEqual(restarted.selectedSessionId, scope.id);
  for (const id of permanent)
    assert.ok(
      restarted.sessions.some((session) => session.id === id),
      `missing durable ${id}`,
    );
  assert.equal(restarted.sessions.find((session) => session.id === model.id).model.id, 'local-e2e');
  assert.equal(restarted.sessions.find((session) => session.id === thinking.id).thinking, 'off');
  assert.equal(restarted.sessions.find((session) => session.id === approval.id).approvalMode, 'auto');
  await capture('restart-preserves-choices-and-scope');
  await quit();
  console.log(
    'PASS real Electron restart preserves every accepted choice and selected project scope, excludes unused/deleted IDs',
  );

  const firstDraft = await noAgentFixture('held-write');
  const marker = 'NO_AGENT_FIRST_DRAFT_QUIT';
  await app.evaluate((_electron, marker) => {
    globalThis.placeholderLifecycleProbe.arm = { marker, fail: false };
  }, marker);
  await input().fill(marker);
  await expect.poll(() => app.evaluate(() => globalThis.placeholderLifecycleProbe.writeEntered)).toBe(true);
  let closed = false;
  app.once('close', () => {
    closed = true;
  });
  const closing = app.waitForEvent('close', { timeout: 60000 });
  await app.evaluate(({ app }) => {
    setImmediate(() => app.quit());
  });
  await delay(150);
  assert.equal(closed, false, 'actual main quit must wait while no-agent first draft writer is held');
  await app.evaluate(() => globalThis.placeholderLifecycleProbe.releaseWrite());
  await closing;
  app = undefined;
  const committed = JSON.parse(await fs.readFile(path.join(firstDraft.dataDir, 'state.json'), 'utf8'));
  assert.equal(committed.sessions.find((session) => session.id === firstDraft.id).draft, marker);
  evidence.push({
    label: 'real-no-agent-held-write-quit',
    id: firstDraft.id,
    committed: true,
    historyHandlerHeld: true,
  });
  console.log('PASS real Electron no-agent quit waits for the held first-draft filesystem writer');

  const failedDraft = await noAgentFixture('write-failure');
  const failedMarker = 'NO_AGENT_UNSAVED_ENOSPC';
  await app.evaluate((_electron, marker) => {
    globalThis.placeholderLifecycleProbe.arm = { marker, fail: true };
  }, failedMarker);
  await input().fill(failedMarker);
  await expect.poll(() => app.evaluate(() => globalThis.placeholderLifecycleProbe.writeEntered)).toBe(true);
  await app.evaluate(() => globalThis.placeholderLifecycleProbe.releaseWrite());
  await expect.poll(async () => (await bootstrap()).storage.writable).toBe(false);
  await app.evaluate(({ app }) => {
    setImmediate(() => app.quit());
  });
  const unsaved = page.getByRole('dialog', { name: '本地内容尚未保存，仍然退出？', exact: true });
  await unsaved.getByRole('button', { name: '留在窗口', exact: true }).click();
  await expect(input()).toHaveValue(failedMarker);
  assert.equal(
    (await navigation()).sessions.find((session) => session.id === failedDraft.id).draft,
    failedMarker,
  );
  await capture('failed-quit-retains-unsaved-draft');
  const failedClosing = app.waitForEvent('close', { timeout: 60000 });
  await app.evaluate(({ app }) => {
    setImmediate(() => app.quit());
  });
  const discardedExit = await completeExpectedExit(
    () => unsaved.getByRole('button', { name: '仍然退出，丢弃未保存内容', exact: true }).click(),
    failedClosing,
    app.process(),
  );
  app = undefined;
  const prior = JSON.parse(await fs.readFile(path.join(failedDraft.dataDir, 'state.json'), 'utf8'));
  assert.equal(
    prior.sessions.some((session) => session.id === failedDraft.id),
    false,
    'failed write is never reported as saved',
  );
  evidence.push({
    label: 'real-no-agent-ENOSPC-quit',
    exit: discardedExit,
    id: failedDraft.id,
    retainedUntilExplicitDiscard: true,
    historyHandlerHeld: true,
  });
  console.log(
    'PASS real Electron ENOSPC keeps unsaved draft visible and requires explicit discard before quit',
  );
  assert.deepEqual(errors, []);
  await fs.writeFile(
    path.join(output, 'evidence.json'),
    JSON.stringify(
      { passed: true, evidence, unused: [...unused], permanent: [...permanent], errors },
      null,
      2,
    ),
  );
} catch (error) {
  if (page && !page.isClosed())
    await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  await fs.writeFile(
    path.join(output, 'evidence.json'),
    JSON.stringify({ passed: false, error: String(error), evidence, errors }, null, 2),
  );
  throw error;
} finally {
  if (app) await closeApp(app).catch(() => {});
  await provider.close();
}
