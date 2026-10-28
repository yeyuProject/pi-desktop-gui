import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createLocalProvider, prepareRealPiFixture } from '../tests/support/local-provider.ts';
import { verifyTurnOutlineUI } from '../tests/support/turn-outline-ui.mjs';

const provider = await createLocalProvider({ holdSlowResponses: true });
const fixture = await prepareRealPiFixture(provider.baseUrl, 'chat-ui');
fixture.store.state.projects = [];
fixture.store.state.sessions = [];
delete fixture.store.state.selectedProjectId;
delete fixture.store.state.selectedSessionId;
const piPath = fixture.store.state.settings.piPath;
fixture.store.state.settings.piPath = path.join(fixture.dir, 'missing-pi.js');
const modelsPath = path.join(fixture.agentDir, 'models.json');
const modelConfig = JSON.parse(await fs.readFile(modelsPath, 'utf8'));
const baseModel = modelConfig.providers['local-e2e'].models[0];
const extraModels = Array.from({ length: 24 }, (_, i) => ({
  ...baseModel,
  id: `local-e2e-${i}`,
  name: `滚动测试模型 ${i}`,
}));
modelConfig.providers['local-e2e'].models.push(...extraModels);
await fs.writeFile(modelsPath, JSON.stringify(modelConfig));
await fixture.store.save();
const output = path.resolve('test-results');
const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
await fs.mkdir(output, { recursive: true });
const errors = [];
let app, page, testError, lastViewExpectation, lastModelCheck;
const launch = async () => {
  app = await electron.launch({
    executablePath: process.env.PI_DESKTOP_EXE,
    args: process.env.PI_DESKTOP_EXE ? [] : [path.resolve('.')],
    env: { ...process.env, PI_DESKTOP_DATA_DIR: fixture.dataDir, PI_OFFLINE: '1' },
    timeout: 30000,
  });
  page = await app.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.getByRole('textbox', { name: '任务输入' }).waitFor();
  await page.evaluate(async () => {
    window.chatUiRuntimes = new Map();
    window.desktop.onEvent((event) => {
      if (event.type === 'state') window.chatUiState = event.state;
      if (event.type === 'storage') window.chatUiStorage = event.storage;
      if (event.type === 'runtime' && event.runtime.sessionId)
        window.chatUiRuntimes.set(event.runtime.sessionId, event.runtime);
      if (event.type === 'runtimePatch' && event.patch.sessionId) {
        // Readiness uses scalar fields; omitted fields retain their previous values.
        const next = { ...window.chatUiRuntimes.get(event.patch.sessionId), ...event.patch };
        for (const key of event.patch.removed ?? []) delete next[key];
        window.chatUiRuntimes.set(event.patch.sessionId, next);
      }
      if (event.type === 'runtimeRemoved') window.chatUiRuntimes.delete(event.sessionId);
    });
    // Bootstrap once after subscribing, rather than repeatedly resyncing during readiness waits.
    const { state, runtime, storage } = await window.desktop.invoke('bootstrap');
    window.chatUiState = state;
    window.chatUiStorage = storage;
    if (runtime.sessionId) window.chatUiRuntimes.set(runtime.sessionId, runtime);
  });
};
const waitForSaved = async (predicate) => {
  const start = Date.now();
  while (Date.now() - start < 10000) {
    const state = JSON.parse(await fs.readFile(path.join(fixture.dataDir, 'state.json'), 'utf8'));
    if (predicate(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Conversation state was not saved');
};
// These predicates deliberately return booleans, never Promises (Playwright 1.64).
function chatSelectionReady({ id, draft, modelId, connected = true }) {
  const selectedId = id ?? window.chatUiState?.selectedSessionId;
  const runtime = window.chatUiRuntimes.get(selectedId);
  const input = document.querySelector('textarea[aria-label="任务输入"]');
  const send = document.querySelector('button[aria-label="发送任务"]');
  return Boolean(
    selectedId &&
    window.chatUiState?.selectedSessionId === selectedId &&
    document
      .querySelector(`.session-row[data-session-id="${selectedId}"] > button`)
      ?.getAttribute('aria-current') === 'page' &&
    runtime?.connected === connected &&
    (connected || (runtime.modelsLoaded && !runtime.modelsLoading)) &&
    ['idle', 'completed', 'stopped'].includes(runtime.status) &&
    !runtime.configurationPending &&
    (!modelId || runtime.model?.id === modelId) &&
    (draft === undefined || input?.value === draft) &&
    send &&
    !send.querySelector('.spin') &&
    (!draft || !send.disabled),
  );
}
function allChatRuntimesSettled() {
  return [...window.chatUiRuntimes.values()].every(
    (runtime) =>
      !['starting', 'running', 'waiting', 'retrying', 'compacting', 'stopping'].includes(runtime.status) &&
      !runtime.modelsLoading &&
      !runtime.configurationPending &&
      !runtime.dialogs?.length,
  );
}
// Selection must settle before a model click; a model name is only a postcondition.
function chatViewReady({ id, differentFrom, scope, projectId, draft, connectable = false }) {
  const state = window.chatUiState;
  const selected = state?.sessions.find((session) => session.id === state.selectedSessionId);
  if (!selected || (id && selected.id !== id) || selected.id === differentFrom) return false;
  if (scope === 'standalone' && selected.projectId) return false;
  if (scope === 'project' && !selected.projectId) return false;
  if (projectId && selected.projectId !== projectId) return false;
  const project = state.projects.find((project) => project.id === selected.projectId);
  const runtime = window.chatUiRuntimes.get(selected.id);
  const send = document.querySelector('button[aria-label="发送任务"]');
  return Boolean(
    state.selectedProjectId === selected.projectId &&
    document
      .querySelector(`.session-row[data-session-id="${selected.id}"] > button`)
      ?.getAttribute('aria-current') === 'page' &&
    document.querySelector('h1')?.textContent === selected.title &&
    send &&
    !send.querySelector('.spin') &&
    (draft === undefined || document.querySelector('textarea[aria-label="任务输入"]')?.value === draft) &&
    (!connectable ||
      (!document.querySelector('button[aria-label="选择模型"]')?.disabled &&
        window.chatUiStorage?.writable &&
        (!selected.projectId || project?.trusted) &&
        (!runtime?.crash || runtime.crash.cleanup === 'confirmed') &&
        !runtime?.configurationPending &&
        !['starting', 'running', 'waiting', 'retrying', 'compacting', 'stopping'].includes(runtime?.status))),
  );
}
const waitForView = (expected) => {
  lastViewExpectation = expected;
  return page.waitForFunction(chatViewReady, expected, { timeout: 30000 });
};
const newStandalone = async (open) => {
  const previousId = await page.evaluate(() => window.chatUiState.selectedSessionId);
  await open();
  await waitForView({ differentFrom: previousId, scope: 'standalone', draft: '', connectable: true });
  return page.evaluate(() => window.chatUiState.selectedSessionId);
};
const waitForSelection = (expected) => page.waitForFunction(chatSelectionReady, expected, { timeout: 30000 });
const expectSelectedModel = async (model, id) => {
  assert.ok(id, 'Model checks require an explicit target session');
  lastModelCheck = { id, modelId: model.id, stage: 'before view readiness' };
  await waitForView({ id, scope: 'standalone', connectable: true });
  lastModelCheck.stage = 'before model click';
  await page.getByRole('button', { name: '选择模型', exact: true }).click();
  lastModelCheck.stage = 'waiting for model response';
  await page.waitForFunction(
    (name) => document.querySelector('.model-pill > span')?.textContent === name,
    model.name,
    { timeout: 25000 },
  );
  lastModelCheck.stage = 'model metadata loaded';
  await waitForSelection({ id, modelId: model.id, connected: false });
  const { state, runtime } = await page.evaluate(() => ({
    state: window.chatUiState,
    runtime: window.chatUiRuntimes.get(window.chatUiState.selectedSessionId),
  }));
  assert.equal(state.selectedSessionId, id);
  assert.equal(runtime.connected, false, 'reading models must not connect the conversation');
  assert.equal(runtime.sessionId, state.selectedSessionId);
  assert.equal(runtime.model.id, model.id);
  const current = page.locator('.model-list [aria-current="true"]');
  assert.equal(await current.count(), 1, 'the actual Pi model must be checked before sending a message');
  assert.ok((await current.textContent()).includes(model.name));
  await page.keyboard.press('Escape');
  await page.getByRole('dialog', { name: '模型与推理级别' }).waitFor({ state: 'detached' });
  lastModelCheck.stage = 'complete';
};
const within = async (operation, ms, label) => {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};
const cleanupApp = async () => {
  if (!app) return;
  if (page && !page.isClosed())
    await within(
      page.evaluate(() => {
        // Cleanup only: handle future exit requests and a request already shown by a failed close.
        window.desktop.onEvent((event) => {
          if (event.type === 'appDialog')
            void window.desktop
              .invoke(
                'respondAppDialog',
                event.dialog.id,
                event.dialog.message === 'Pi 仍在执行任务' ? 1 : event.dialog.cancelId,
              )
              .catch(() => {});
        });
        const existing = [...document.querySelectorAll('[data-app-dialog] button')].find(
          (button) => button.textContent === '停止并退出',
        );
        existing?.click();
      }),
      3000,
      'Installing exit cleanup',
    ).catch((error) => console.warn(error.message));
  try {
    await within(app.close(), 15000, 'Electron cleanup');
  } catch (error) {
    // Never leave CI waiting indefinitely, or replace the original assertion with a cleanup failure.
    try {
      app.process().kill('SIGKILL');
    } catch {}
    return error;
  }
};
try {
  await launch();
  await page.getByText('有什么想聊的？', { exact: true }).waitFor();
  assert.equal(await page.locator('.project-row').count(), 0);
  assert.equal(await page.locator('.standalone-sessions .session-row').count(), 1);
  assert.equal(await page.locator('.trust-banner').count(), 0);
  const standaloneOutput = page.getByRole('button', { name: '查看会话输出', exact: true });
  assert.equal(await standaloneOutput.isVisible(), true);
  assert.equal(await standaloneOutput.isEnabled(), true);
  assert.equal(await page.getByRole('button', { name: '查看工作区变更', exact: true }).count(), 0);
  assert.equal(await page.getByRole('textbox', { name: '任务输入' }).isEnabled(), true);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(output, 'standalone-empty.png'), animations: 'disabled' });

  await page.getByRole('button', { name: '选择模型', exact: true }).click();
  const picker = page.getByRole('dialog', { name: '模型与推理级别' });
  await picker.getByText(/^读取模型失败：/).waitFor();
  assert.equal(await picker.locator('.spin').count(), 0);
  await page.evaluate((value) => window.desktop.invoke('saveSettings', { piPath: value }), piPath);
  await picker.getByRole('button', { name: '重新读取模型', exact: true }).click();
  await picker.getByText('正在读取模型…', { exact: true }).waitFor();
  await page.waitForFunction(
    () =>
      !window.chatUiRuntimes.get(window.chatUiState.selectedSessionId)?.connected &&
      !document.querySelector('.stop-button') &&
      !document.querySelector('.run-meta')?.textContent.includes('正在连接 Pi') &&
      !document.querySelector('select[aria-label="运行中发送方式"]') &&
      !document.querySelector('.elapsed'),
  );
  await picker
    .getByRole('option', { name: /local-e2e/ })
    .first()
    .waitFor({ timeout: 25000 });
  await waitForSelection({ connected: false });
  const search = picker.getByRole('textbox', { name: '搜索模型' });
  const lastModel = extraModels.at(-1);
  await search.fill(lastModel.id);
  await search.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true });
  assert.equal(await picker.isVisible(), true, 'IME confirmation must keep the model picker open');
  assert.equal(
    JSON.parse(await fs.readFile(path.join(fixture.dataDir, 'state.json'), 'utf8')).settings.modelId,
    baseModel.id,
    'IME confirmation must not change the model',
  );
  await search.press('Enter');
  await picker.waitFor({ state: 'detached' });
  await waitForSaved((state) => state.settings.modelId === lastModel.id);
  await page.waitForFunction(
    (name) => document.querySelector('.model-pill > span')?.textContent === name,
    lastModel.name,
  );
  const currentModelVisible = () => {
    const list = document.querySelector('.model-list');
    const current = list?.querySelector('[aria-current="true"]');
    if (!list || !current) return false;
    const bounds = list.getBoundingClientRect(),
      selected = current.getBoundingClientRect();
    return selected.top >= bounds.top - 1 && selected.bottom <= bounds.bottom + 1;
  };
  await page.getByRole('button', { name: '选择模型', exact: true }).click();
  await waitForSelection({ connected: false });
  await page.waitForFunction(currentModelVisible);
  await search.press('Escape');
  await picker.waitFor({ state: 'detached' });
  await page.getByRole('button', { name: '选择模型', exact: true }).click();
  await waitForSelection({ connected: false });
  await page.waitForFunction(currentModelVisible);
  await search.fill(baseModel.name);
  await search.press('Enter');
  await picker.waitFor({ state: 'detached' });
  await waitForSaved((state) => state.settings.modelId === baseModel.id);
  await page.locator('.run-meta .status.idle').waitFor({ timeout: 25000 });
  console.log('PASS model metadata failure/retry without connecting, IME confirmation and reopen scroll');
  // Saving a path through IPC skips the settings form's environment refresh.
  // Use the actual check action before testing the configured provider.
  await page.getByRole('button', { name: '检查运行环境', exact: true }).click();
  await page.getByRole('button', { name: '重新检测', exact: true }).click();
  await page.locator('.readiness').waitFor({ state: 'detached' });
  await page.getByRole('button', { name: '关闭', exact: true }).last().click();
  await page.getByRole('button', { name: '选择模型', exact: true }).click();
  await picker.getByRole('button', { name: '连接设置', exact: true }).click();
  await page.getByRole('combobox', { name: '选择模型', exact: true }).waitFor({ state: 'visible' });
  await page.waitForFunction(
    () => document.querySelector('select[aria-label="选择模型"]')?.value === 'local-e2e::local-e2e',
  );
  await page.getByRole('button', { name: '测试模型连接', exact: true }).click();
  await page.locator('.test-result').filter({ hasText: 'OK' }).waitFor({ timeout: 25000 });
  await page.getByRole('button', { name: '关闭', exact: true }).last().click();
  const input = page.getByRole('textbox', { name: '任务输入' });
  const first = (await waitForSaved((state) => !!state.sessions[0]?.id)).sessions[0];
  assert.equal(first.title, '新对话');
  const firstPrompt = '@普通消息：不打开工作区也能聊。';
  await input.fill(firstPrompt);
  assert.equal(await page.locator('.file-picker').count(), 0);
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await page.locator('.run-meta .status.completed').waitFor({ timeout: 25000 });
  await page.locator('.message').filter({ hasText: 'OK' }).waitFor();
  assert.ok(provider.requests.at(-1).tools?.length > 0);
  await waitForSaved((state) => !!state.sessions.find((s) => s.id === first.id)?.file);
  await input.fill('独立对话未发送草稿');
  await waitForSaved(
    (state) => state.sessions.find((s) => s.id === first.id)?.draft === '独立对话未发送草稿',
  );
  // Pi can choose its native default without a desktop model preference being saved.
  await page.evaluate(() => window.desktop.invoke('saveSettings', { provider: '', modelId: '' }));
  await waitForSaved((state) => !state.settings.modelId && !state.settings.provider);
  const piSettingsFile = path.join(fixture.agentDir, 'settings.json');
  const piSettings = JSON.parse(await fs.readFile(piSettingsFile, 'utf8'));
  await fs.writeFile(piSettingsFile, JSON.stringify({ ...piSettings, defaultModel: lastModel.id }));
  const requestsBeforeNewChat = provider.requests.length;
  const secondId = await newStandalone(() => page.keyboard.press(`${modifier}+n`));
  await page.waitForFunction(
    () => document.querySelectorAll('.standalone-sessions .session-row').length === 2,
  );
  assert.equal(await input.inputValue(), '');
  await expectSelectedModel(lastModel, secondId);
  assert.equal(
    await page.locator('.readiness').count(),
    0,
    'a new chat with known available models must not repeat first-run model setup',
  );
  assert.equal(
    provider.requests.length,
    requestsBeforeNewChat,
    'model initialization must not send a prompt',
  );
  console.log(
    'PASS opening the model picker reads the actual Pi default without repeated setup or a model request',
  );
  await input.fill('第二条独立对话');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await page.locator('.run-meta .status.completed').waitFor({ timeout: 25000 });
  assert.equal(provider.requests.at(-1).model, lastModel.id);
  // A saved session file can precede the automatic title update. Select the same session
  // by its stable ID and also verify that its title caught up, without reusing a stale title.
  const firstRow = page.locator(`.standalone-sessions .session-row[data-session-id="${first.id}"]`);
  await firstRow.getByRole('button', { name: firstPrompt, exact: true }).waitFor();
  await firstRow.locator(':scope > button').first().click();
  await waitForView({ id: first.id, scope: 'standalone', draft: '独立对话未发送草稿' });
  await waitForSaved((state) => state.selectedSessionId === first.id);
  await page.waitForFunction(() => document.querySelector('textarea')?.value === '独立对话未发送草稿');
  assert.equal(await page.locator('.message').filter({ hasText: '第二条独立对话' }).count(), 0);
  // Previewed history/draft can precede selectSession persistence completion.
  // Normal restart never auto-confirms a running-work exit dialog.
  await waitForSelection({ id: first.id, draft: '独立对话未发送草稿' });
  await page.waitForFunction(allChatRuntimesSettled, undefined, { timeout: 30000 });
  await page.screenshot({ path: path.join(output, 'standalone-conversation.png'), animations: 'disabled' });
  await within(app.close(), 15000, 'Normal conversation restart');
  app = undefined;
  await launch();
  await page.waitForFunction(() => document.querySelector('textarea')?.value === '独立对话未发送草稿');
  await page.locator('.message').filter({ hasText: 'OK' }).waitFor();
  assert.equal(await page.locator('.standalone-sessions .session-row').count(), 2);
  assert.equal(await page.locator('.project-row').count(), 0);
  console.log('PASS fresh startup, model selection/probe, send, Ctrl/Cmd+N, separate histories and restart');

  await page.keyboard.press(`${modifier}+k`);
  const sessionSearch = page.getByRole('textbox', { name: '搜索项目和会话' });
  await sessionSearch.fill('第二条独立对话');
  await page.getByRole('option', { name: /第二条独立对话/ }).waitFor();
  await sessionSearch.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true });
  assert.equal(await page.getByRole('dialog', { name: '快速切换' }).isVisible(), true);
  assert.equal(
    JSON.parse(await fs.readFile(path.join(fixture.dataDir, 'state.json'), 'utf8')).selectedSessionId,
    first.id,
    'IME confirmation must not switch the selected session',
  );
  await page
    .locator('.search-results')
    .getByRole('option', { name: /第二条独立对话/ })
    .click();
  await page.getByRole('heading', { level: 1, name: '第二条独立对话' }).waitFor();
  await waitForView({ id: secondId, scope: 'standalone' });
  // Restart clears the registry cache. Explicit model loading must resolve Pi's actual
  // default without a desktop preference or a warm connection.
  await fs.writeFile(piSettingsFile, JSON.stringify({ ...piSettings, defaultModel: baseModel.id }));
  // Native picker is supplied a temporary test project; no user folders or settings are touched.
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, fixture.projectDir);
  await page.getByRole('button', { name: '添加项目', exact: true }).click();
  await page.locator('.trust-banner').waitFor();
  await page.getByRole('textbox', { name: '任务输入' }).fill('项目仍然需要启用');
  assert.equal(await page.getByRole('button', { name: '发送任务', exact: true }).isDisabled(), true);
  const untrustedConnected = await page.evaluate(
    () => window.chatUiRuntimes.get(window.chatUiState.selectedSessionId)?.connected ?? false,
  );
  assert.equal(untrustedConnected, false, 'an untrusted project must not start Pi automatically');
  const untrustedModel = page.getByRole('button', { name: '选择模型', exact: true });
  assert.equal(await untrustedModel.isDisabled(), true);
  assert.equal(await untrustedModel.getAttribute('title'), '请先启用项目');
  assert.equal(await page.getByRole('dialog', { name: '模型与推理级别' }).count(), 0);
  assert.equal(await page.locator('.error-banner').count(), 0);
  assert.equal(await page.locator('.trust-banner').count(), 1);

  const standaloneFromProjectId = await newStandalone(() =>
    page.getByRole('button', { name: /^新建对话/ }).click(),
  );
  await page.getByText('有什么想聊的？', { exact: true }).waitFor();
  assert.equal(await page.locator('.trust-banner').count(), 0);
  const newStandaloneOutput = page.getByRole('button', { name: '查看会话输出', exact: true });
  assert.equal(await newStandaloneOutput.isVisible(), true);
  assert.equal(await newStandaloneOutput.isEnabled(), true);
  assert.equal(await page.getByRole('button', { name: '查看工作区变更', exact: true }).count(), 0);
  await expectSelectedModel(baseModel, standaloneFromProjectId);
  assert.equal(await page.locator('.readiness').count(), 0);
  await page.getByRole('textbox', { name: '任务输入' }).fill('从项目中直接新建独立对话');
  assert.equal(await page.getByRole('button', { name: '发送任务', exact: true }).isEnabled(), true);
  assert.equal(await page.locator('.project-row').count(), 1);
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await page.locator('.run-meta .status.completed').waitFor({ timeout: 25000 });
  await page.locator('.project-row').click();
  assert.equal(
    await page.locator('.trust-banner').count(),
    0,
    'expanding a project does not switch the current session',
  );
  if ((await page.locator('.project-row').getAttribute('aria-expanded')) !== 'true')
    await page.locator('.project-row').click();
  const projectSessionId = await page
    .locator('.project-group .session-row')
    .first()
    .getAttribute('data-session-id');
  await page.locator('.project-group .session-row > button').first().click();
  const projectId = await page.evaluate(
    (id) => window.chatUiState.sessions.find((session) => session.id === id).projectId,
    projectSessionId,
  );
  await waitForView({ id: projectSessionId, scope: 'project', projectId });
  await page.locator('.trust-banner').waitFor();
  assert.equal(await page.getByRole('button', { name: '发送任务', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: '在 project 中新建会话', exact: true }).click();
  await waitForView({ differentFrom: projectSessionId, scope: 'project', projectId, draft: '' });
  const projectEmptyId = await page.evaluate(() => window.chatUiState.selectedSessionId);
  await page.waitForFunction(() => document.querySelectorAll('.project-group .session-row').length === 2);
  assert.equal(await page.locator('.project-group .session-row').count(), 2);
  assert.equal(await page.locator('.standalone-sessions .session-row').count(), 3);
  console.log('PASS standalone search, global new chat from project, project creation and trust retained');

  const saved = await waitForSaved((state) =>
    state.sessions.some((session) => session.title === '第二条独立对话'),
  );
  const missingFileSession = saved.sessions.find((session) => session.title === '第二条独立对话');
  assert.ok(missingFileSession.file);
  const sessionFile = path.resolve(missingFileSession.file);
  const sessionDirectory = path.resolve(fixture.agentDir, 'sessions');
  assert.equal(
    path.dirname(path.dirname(sessionFile)),
    sessionDirectory,
    'only remove the isolated test session file in Pi’s per-cwd directory',
  );
  await fs.unlink(sessionFile);
  await page.getByRole('button', { name: `${missingFileSession.title} 会话操作`, exact: true }).click();
  await page.getByRole('menuitem', { name: '删除', exact: true }).click();
  await page
    .getByRole('dialog', { name: `删除会话“${missingFileSession.title}”？` })
    .getByRole('button', { name: '删除', exact: true })
    .click();
  await waitForSaved((state) => !state.sessions.some((session) => session.id === missingFileSession.id));
  await page
    .getByRole('button', { name: `${missingFileSession.title} 会话操作`, exact: true })
    .waitFor({ state: 'detached' });
  assert.equal(await page.locator('.standalone-sessions .session-row').count(), 2);
  await waitForView({ id: projectEmptyId, scope: 'project', projectId });
  console.log('PASS IME session search and deletion after the session file is missing');

  const continuationId = await newStandalone(() => page.getByRole('button', { name: /^新建对话/ }).click());
  await expectSelectedModel(baseModel, continuationId);
  await page.getByRole('textbox', { name: '任务输入' }).fill('E2E_SLOW 新会话不能中断当前回复');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await page.getByText('开始流式回复。', { exact: true }).waitFor();
  const active = await page.evaluate(() => window.chatUiRuntimes.get(window.chatUiState.selectedSessionId));
  assert.equal(provider.heldSlowResponseCount, 1, 'The response gate must be held before creating B');
  const requestsDuringReply = provider.requests.length;
  const parallelId = await newStandalone(() => page.getByRole('button', { name: /^新建对话/ }).click());
  await page.getByText('有什么想聊的？', { exact: true }).waitFor();
  // Model metadata loads without connecting the new chat while A keeps streaming.
  await expectSelectedModel(baseModel, parallelId);
  await page.getByRole('button', { name: '选择模型', exact: true }).click();
  await waitForSelection({ id: parallelId, modelId: baseModel.id, connected: false });
  assert.equal(await page.getByRole('option').first().isEnabled(), true);
  await page.keyboard.press('Escape');
  await page.getByRole('dialog', { name: '模型与推理级别' }).waitFor({ state: 'detached' });
  const independent = await page.evaluate(() => ({
    selectedId: window.chatUiState.selectedSessionId,
    runtime: window.chatUiRuntimes.get(window.chatUiState.selectedSessionId),
  }));
  assert.notEqual(independent.selectedId, active.sessionId);
  assert.equal(independent.runtime.connected, false);
  assert.equal(independent.runtime.model.id, baseModel.id);
  const duringReply = await page.evaluate((id) => window.chatUiRuntimes.get(id), active.sessionId);
  assert.equal(duringReply.status, 'running', 'creating a chat must leave the existing response running');
  assert.equal(duringReply.connected, true);
  assert.equal(provider.heldSlowResponseCount, 1, 'A stays held until the explicit targeted stop');
  assert.equal(await page.locator('.error-banner').count(), 0);
  assert.equal(
    provider.requests.length,
    requestsDuringReply,
    'independent model initialization must not send a prompt',
  );
  await page.evaluate((id) => window.desktop.invoke('stop', id), active.sessionId);
  await page.waitForFunction((id) => window.chatUiRuntimes.get(id)?.status === 'stopped', active.sessionId);
  await waitForSelection({ id: independent.selectedId, modelId: baseModel.id, connected: false });
  assert.equal(
    await page.evaluate((id) => window.chatUiRuntimes.get(id)?.status, independent.selectedId),
    'idle',
    'Stopping A must not stop the independent new chat',
  );
  assert.equal(await page.locator('.error-banner').count(), 0);
  assert.equal(
    provider.requests.length,
    requestsDuringReply,
    'stopping the original chat must not send a prompt',
  );
  await page.waitForFunction(allChatRuntimesSettled, undefined, { timeout: 30000 });
  console.log(
    'PASS a new chat initializes independently while the existing response keeps running; stop targets only that response',
  );
  const requestsBeforeOutline = provider.requests.length;
  const outline = await verifyTurnOutlineUI({ app, page, output });
  assert.equal(
    provider.requests.length,
    requestsBeforeOutline,
    'outline checks must not send a model request',
  );
  assert.deepEqual(errors, []);
  await fs.writeFile(
    path.join(output, 'chat-ui-result.json'),
    JSON.stringify(
      {
        result: 'PASS',
        fixture: fixture.dir,
        checks: [
          'zero-project startup',
          'model picker and connection probe',
          'model metadata failure and retry without connecting',
          'model picker IME confirmation',
          'model picker current model visible after reopening',
          'plain @ text',
          'real Pi response with tools available',
          'Ctrl/Cmd+N',
          'new chat automatically selects the actual Pi default before the first prompt',
          'cold new chat model initialization and checked picker item',
          'model initialization sends no provider request and respects project trust',
          'new chat initializes independently without interrupting a running response',
          'stopping a background response leaves the selected chat usable without connecting',
          'independent histories',
          'draft/history restart',
          'search',
          'session search IME confirmation',
          'delete session with missing history file',
          'global new chat',
          'project new session',
          'project trust retained',
        ],
        consoleErrors: errors,
        outline,
      },
      null,
      2,
    ),
  );
} catch (error) {
  testError = error;
  console.error(error);
  if (page && !page.isClosed())
    await page.screenshot({ path: path.join(output, 'chat-ui-failure.png'), timeout: 5000 }).catch(() => {});
  const state = await page
    ?.evaluate(() => {
      const id = window.chatUiState?.selectedSessionId;
      const selected = window.chatUiState?.sessions.find((session) => session.id === id);
      const runtime = window.chatUiRuntimes?.get(id);
      const retry = [...document.querySelectorAll('.model-picker button')].find(
        (button) => button.textContent === '重新读取模型',
      );
      return {
        selectedId: id,
        projectId: selected?.projectId,
        projectTrusted: window.chatUiState?.projects.find((project) => project.id === selected?.projectId)
          ?.trusted,
        domSelectedId: document.querySelector('.session-row > button[aria-current="page"]')?.parentElement
          .dataset.sessionId,
        pendingIndicator: Boolean(document.querySelector('[aria-label="发送任务"] .spin')),
        runtime: runtime && {
          sessionId: runtime.sessionId,
          connected: runtime.connected,
          status: runtime.status,
          modelId: runtime.model?.id,
          configurationPending: runtime.configurationPending,
        },
        modelLabel: document.querySelector('.model-pill > span')?.textContent,
        modelPickerOpen: Boolean(document.querySelector('.model-picker')),
        reconnectDisabled: retry?.disabled,
        trustBanner: Boolean(document.querySelector('.trust-banner')),
      };
    })
    .catch(() => ({ unavailable: true }));
  await fs
    .writeFile(
      path.join(output, 'chat-ui-failure-state.json'),
      JSON.stringify(
        {
          lastViewExpectation,
          lastModelCheck,
          display: state,
          rendererErrors: errors,
        },
        null,
        2,
      ),
    )
    .catch(() => {});
  console.error('Renderer errors:', errors);
  throw error;
} finally {
  const cleanupError = await cleanupApp();
  await provider.close();
  if (cleanupError) {
    // eslint-disable-next-line no-unsafe-finally -- Preserve the original failure; fail teardown only after a successful test.
    if (!testError) throw cleanupError;
    console.warn('Cleanup after the original failure:', cleanupError.message);
  }
}
