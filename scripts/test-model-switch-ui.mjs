import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { prepareRealPiFixture } from '../tests/support/local-provider.ts';
import { modelSwitchReady } from './model-switch-readiness.mjs';

process.env.PI_OFFLINE = '1';
const requests = [];
let releaseResponse;
let releaseOther;
const responseGate = new Promise((resolve) => {
  releaseResponse = resolve;
});
const otherGate = new Promise((resolve) => {
  releaseOther = resolve;
});
const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const user = body.messages.findLast((message) => message.role === 'user');
  const prompt =
    typeof user.content === 'string' ? user.content : user.content.map((item) => item.text || '').join('');
  const otherRequest = prompt.includes('CONCURRENT_B');
  body.otherRequest = otherRequest;
  requests.push(body);
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const send = (delta, finish_reason = null) =>
    res.write(
      `data: ${JSON.stringify({
        id: 'model-switch',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [{ index: 0, delta, finish_reason }],
      })}\n\n`,
    );
  send({
    role: 'assistant',
    content: otherRequest
      ? 'CONCURRENT_RESPONSE_B'
      : requests.length === 1
        ? 'CURRENT_RESPONSE_A'
        : 'NEXT_RESPONSE_B',
  });
  if (otherRequest) {
    await otherGate;
    if (res.destroyed) return;
    send({}, 'stop');
  } else if (requests.length === 1) {
    await responseGate;
    if (res.destroyed) return;
    send({
      tool_calls: [
        {
          index: 0,
          id: 'read-after-model-switch',
          type: 'function',
          function: { name: 'read', arguments: JSON.stringify({ path: '输入 文件.txt' }) },
        },
      ],
    });
    send({}, 'tool_calls');
  } else send({}, 'stop');
  res.end('data: [DONE]\n\n');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const f = await prepareRealPiFixture(`http://127.0.0.1:${server.address().port}/v1`, 'model-switch-ui');
const modelFile = path.join(f.agentDir, 'models.json');
const models = JSON.parse(await fs.readFile(modelFile, 'utf8'));
models.providers['local-e2e'].models[0].reasoning = true;
models.providers['local-e2e'].models[0].compat = { supportsReasoningEffort: true };
models.providers['local-e2e'].models.push({
  ...models.providers['local-e2e'].models[0],
  id: 'local-next',
  name: '下一任务模型',
});
await fs.writeFile(modelFile, JSON.stringify(models));
if (process.argv[2]) f.store.state.settings.piPath = path.resolve(process.argv[2]);
const other = f.store.createSession(f.projectId);
other.title = '查看其他会话';
f.store.selectSession(f.sessionId);
await f.store.save();
let app, page;
const errors = [];
function coldSelectionReady({ id, title, draft }) {
  const input = document.querySelector('textarea[aria-label="任务输入"]');
  const send = document.querySelector('.send-button');
  return Boolean(
    window.modelSwitchState?.selectedSessionId === id &&
    !window.modelSwitchRuntimes.get(id)?.connected &&
    document.querySelector('.workspace-title h1')?.textContent === title &&
    input &&
    !input.disabled &&
    (draft === undefined || input.value === draft) &&
    send &&
    !send.querySelector('.spin') &&
    (!draft || !send.disabled) &&
    !document.querySelector('.stop-button'),
  );
}
const observeModelSwitchState = () =>
  page.evaluate(async () => {
    window.modelSwitchRuntimes = new Map();
    window.desktop.onEvent((event) => {
      if (event.type === 'state') window.modelSwitchState = event.state;
      // Readiness uses scalar fields; patches only carry fields that changed.
      if (event.type === 'runtime' && event.runtime.sessionId)
        window.modelSwitchRuntimes.set(event.runtime.sessionId, event.runtime);
      if (event.type === 'runtimePatch' && event.patch.sessionId) {
        const next = { ...window.modelSwitchRuntimes.get(event.patch.sessionId), ...event.patch };
        for (const key of event.patch.removed ?? []) delete next[key];
        window.modelSwitchRuntimes.set(event.patch.sessionId, next);
      }
      if (event.type === 'runtimeRemoved') window.modelSwitchRuntimes.delete(event.sessionId);
    });
    // Subscribe before one bootstrap; readiness polling must not repeatedly resync Pi.
    const { state, runtime } = await window.desktop.invoke('bootstrap');
    window.modelSwitchState = state;
    if (runtime.sessionId) window.modelSwitchRuntimes.set(runtime.sessionId, runtime);
  });

try {
  app = await electron.launch({
    executablePath: process.env.PI_DESKTOP_EXE,
    args: process.env.PI_DESKTOP_EXE ? [] : [path.resolve('.')],
    env: { ...process.env, PI_OFFLINE: '1', PI_DESKTOP_DATA_DIR: f.dataDir },
    timeout: 60000,
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(30000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.getByRole('textbox', { name: '任务输入' }).waitFor();
  await observeModelSwitchState();
  // Opening the model picker reads metadata without connecting the conversation.
  await page.getByRole('button', { name: '选择模型', exact: true }).click();
  await page.getByRole('option', { name: /本地验收接口/ }).waitFor();
  await page.keyboard.press('Escape');
  // Wait for acknowledged metadata before changing the selected model's thinking level.
  await page.waitForFunction(modelSwitchReady, {
    id: f.sessionId,
    title: f.store.session(f.sessionId).title,
    modelId: 'local-e2e',
    connected: false,
    status: 'idle',
    supportsThinking: 'low',
    readyToType: true,
  });
  await page.evaluate((id) => window.desktop.invoke('setSessionThinking', id, 'low'), f.sessionId);
  await page.waitForFunction(modelSwitchReady, {
    id: f.sessionId,
    modelId: 'local-e2e',
    connected: false,
    status: 'idle',
    thinking: 'low',
  });
  await page.evaluate(
    (id) => window.desktop.invoke('send', id, 'MODEL_SWITCH_DURING_RESPONSE', [], 'steer'),
    f.sessionId,
  );
  await page.getByText('CURRENT_RESPONSE_A', { exact: true }).waitFor();
  await page.getByRole('button', { name: '选择模型', exact: true }).click();
  const nextModel = page.getByRole('option', { name: /下一任务模型/ });
  assert.equal(await nextModel.isEnabled(), true);
  assert.equal(await page.getByRole('radio', { name: 'high', exact: true }).isEnabled(), true);
  await nextModel.click();
  await page.waitForFunction(modelSwitchReady, {
    id: f.sessionId,
    modelId: 'local-e2e',
    nextModelId: 'local-next',
    status: 'running',
    connected: true,
    supportsThinking: 'high',
    readyToType: true,
  });
  await page.evaluate((id) => window.desktop.invoke('setSessionThinking', id, 'high'), f.sessionId);
  await page.waitForFunction(modelSwitchReady, {
    id: f.sessionId,
    modelId: 'local-e2e',
    nextModelId: 'local-next',
    status: 'running',
    thinking: 'low',
    nextThinking: 'high',
  });
  await page.evaluate(
    (id) => window.desktop.invoke('send', id, 'MODEL_SWITCH_SUPPLEMENT', [], 'steer'),
    f.sessionId,
  );
  assert.equal(requests.length, 1, 'changing selection must not interrupt or restart the current request');

  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '模型连接', exact: true }).click();
  const selector = page.getByRole('combobox', { name: '选择模型' });
  assert.equal(await selector.isEnabled(), true);
  assert.equal(await page.getByRole('button', { name: '保存设置', exact: true }).isEnabled(), true);
  await selector.selectOption('local-e2e::local-e2e');
  // Running-task selectors stay enabled, so enabled alone cannot acknowledge the change.
  await page.waitForFunction(modelSwitchReady, {
    id: f.sessionId,
    status: 'running',
    modelId: 'local-e2e',
    nextModelId: 'local-e2e',
    savedModelId: 'local-e2e',
    selectorValue: 'local-e2e::local-e2e',
    nextThinking: 'high',
    readyToType: true,
  });
  await selector.selectOption('local-e2e::local-next');
  await page.waitForFunction(modelSwitchReady, {
    id: f.sessionId,
    status: 'running',
    modelId: 'local-e2e',
    nextModelId: 'local-next',
    savedModelId: 'local-next',
    selectorValue: 'local-e2e::local-next',
    nextThinking: 'high',
    readyToType: true,
  });
  await assert.rejects(
    page.evaluate(
      (id) => window.desktop.invoke('setSessionModel', id, 'local-e2e', 'missing-model'),
      f.sessionId,
    ),
    /不可用/,
  );
  const current = await page.evaluate(() => window.desktop.invoke('bootstrap'));
  assert.equal(current.runtime.model.id, 'local-e2e');
  assert.equal(current.runtime.nextTask.model.id, 'local-next');
  assert.equal(current.runtime.thinking, 'low');
  assert.equal(current.runtime.nextTask.thinking, 'high');
  assert.equal(current.runtime.status, 'running');
  assert.equal(current.state.settings.modelId, 'local-next');
  assert.equal(current.state.sessions.find((s) => s.id === f.sessionId).model.id, 'local-next');
  await page.locator('footer').getByRole('button', { name: '关闭', exact: true }).click();

  await page.getByRole('button', { name: other.title, exact: true }).click();
  await page.waitForFunction(coldSelectionReady, {
    id: other.id,
    title: other.title,
  });
  await page.locator('.workspace-title h1').filter({ hasText: other.title }).waitFor();
  await page.getByRole('textbox', { name: '任务输入' }).fill('CONCURRENT_B');
  await page.waitForFunction(coldSelectionReady, {
    id: other.id,
    title: other.title,
    draft: 'CONCURRENT_B',
  });
  assert.equal(await page.getByRole('button', { name: '发送任务', exact: true }).isEnabled(), true);
  await page.getByRole('textbox', { name: '任务输入' }).press('Enter');
  await page.getByText('CONCURRENT_RESPONSE_B', { exact: true }).waitFor();
  await page.getByRole('button', { name: '选择模型', exact: true }).click();
  assert.equal(await page.getByRole('option', { name: /本地验收接口/ }).isEnabled(), true);
  await page.getByRole('option', { name: /本地验收接口/ }).click();
  await page.waitForFunction(modelSwitchReady, {
    id: other.id,
    nextModelId: 'local-e2e',
    savedModelId: 'local-e2e',
    status: 'running',
    connected: true,
    readyToType: true,
  });
  // Recreate the renderer while both processes are quiet but still running.
  await page.reload();
  await observeModelSwitchState();
  await page.waitForFunction(modelSwitchReady, {
    id: other.id,
    title: other.title,
    connected: true,
    status: 'running',
    nextModelId: 'local-e2e',
    readyToType: true,
  });
  await page.getByText('CONCURRENT_RESPONSE_B', { exact: true }).waitFor();
  await page.getByRole('button', { name: '停止任务', exact: true }).click();
  await page.locator('.run-meta .stopped').waitFor();
  await page.waitForFunction(modelSwitchReady, { id: other.id, connected: true, status: 'stopped' });
  const stateWithBoth = await page.evaluate(() => window.desktop.invoke('bootstrap'));
  assert.equal(
    stateWithBoth.state.sessions.find((session) => session.id === f.sessionId).lastStatus,
    'running',
  );
  const firstTitle = stateWithBoth.state.sessions.find((session) => session.id === f.sessionId).title;
  await page.getByRole('button', { name: firstTitle, exact: true }).click();
  await page.waitForFunction(modelSwitchReady, {
    id: f.sessionId,
    title: firstTitle,
    connected: true,
    status: 'running',
    modelId: 'local-e2e',
    nextModelId: 'local-next',
    thinking: 'low',
    nextThinking: 'high',
    readyToType: true,
  });
  await page.getByText('CURRENT_RESPONSE_A', { exact: true }).waitFor();
  const stillRunning = await page.evaluate(() => window.desktop.invoke('bootstrap'));
  assert.equal(stillRunning.runtime.model.id, 'local-e2e');
  assert.equal(stillRunning.runtime.nextTask.model.id, 'local-next');
  assert.equal(stillRunning.runtime.thinking, 'low');
  assert.equal(stillRunning.runtime.status, 'running');

  releaseResponse();
  await page.locator('.run-meta .completed').waitFor();
  await page.waitForFunction(modelSwitchReady, {
    id: f.sessionId,
    connected: true,
    status: 'completed',
    modelId: 'local-e2e',
    thinking: 'low',
  });
  assert.deepEqual(
    requests.filter((request) => !request.otherRequest).map((request) => request.model),
    ['local-e2e', 'local-e2e'],
  );
  assert.deepEqual(
    requests.filter((request) => !request.otherRequest).map((request) => request.reasoning_effort),
    ['low', 'low'],
  );
  const result = await page.evaluate(() => window.desktop.invoke('bootstrap'));
  assert.equal(result.runtime.status, 'completed', result.runtime.error);
  assert.equal(result.runtime.error, undefined);
  const replies = result.runtime.messages.filter((message) => message.role === 'assistant');
  assert.deepEqual(
    replies.map((message) => message.model),
    ['local-e2e', 'local-e2e'],
  );
  await page.evaluate((id) => window.desktop.invoke('send', id, 'A_NEW_TASK', [], 'steer'), f.sessionId);
  await page.waitForFunction(modelSwitchReady, {
    id: f.sessionId,
    modelId: 'local-next',
    status: 'completed',
    thinking: 'high',
  });
  assert.equal(requests.at(-1).model, 'local-next');
  assert.equal(requests.at(-1).reasoning_effort, 'high');
  await page.getByRole('button', { name: other.title, exact: true }).click();
  await page.waitForFunction(modelSwitchReady, {
    id: other.id,
    title: other.title,
    connected: true,
    status: 'stopped',
    readyToType: true,
  });
  assert.equal(await page.getByRole('alert').count(), 0, 'stopped B must not hide a failed stop operation');
  await page.getByRole('textbox', { name: '任务输入' }).fill('B_AFTER_STOP');
  await page.waitForFunction(modelSwitchReady, {
    id: other.id,
    title: other.title,
    draft: 'B_AFTER_STOP',
    canSend: true,
  });
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await page.waitForFunction(modelSwitchReady, {
    id: other.id,
    status: 'completed',
    modelId: 'local-e2e',
  });
  const otherResult = await page.evaluate(() => window.desktop.invoke('bootstrap'));
  assert.equal(otherResult.runtime.model.id, 'local-e2e');
  assert.equal(otherResult.runtime.error, undefined);
  assert.equal(requests.at(-1).model, 'local-e2e');
  assert.equal(
    requests.filter((request) => request.otherRequest).length,
    1,
    'changing B model must not restart its in-flight request',
  );
  const standalone = await page.evaluate(() => window.desktop.invoke('newSession'));
  await page.waitForFunction(coldSelectionReady, {
    id: standalone.id,
    title: standalone.title,
  });
  await page.locator('.workspace-title h1').filter({ hasText: standalone.title }).waitFor();
  await page.waitForFunction(
    () =>
      !document.querySelector('.stop-button') &&
      ![...document.querySelectorAll('.sidebar-footer button')].some(
        (button) => button.textContent === '停止所有会话',
      ),
  );
  assert.equal(await page.getByRole('button', { name: '停止任务', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '停止所有会话', exact: true }).count(), 0);
  await page.getByRole('button', { name: '查看会话输出', exact: true }).click();
  await page.locator('.inspector-tabs').getByRole('button', { name: '输出', exact: true }).waitFor();
  assert.equal(
    await page.locator('.inspector-tabs').getByRole('button', { name: '文件', exact: true }).count(),
    0,
  );
  assert.equal(
    await page.locator('.inspector-tabs').getByRole('button', { name: '变更', exact: true }).count(),
    0,
  );
  await page.getByRole('button', { name: '关闭面板', exact: true }).click();
  await page.getByRole('button', { name: 'Pi 功能', exact: true }).click();
  const features = page.getByRole('dialog');
  await features.getByRole('heading', { name: '当前会话', exact: true }).waitFor();
  assert.equal(await features.getByRole('button', { name: '克隆会话', exact: true }).count(), 0);
  assert.equal(await features.getByRole('button', { name: '导出 HTML', exact: true }).count(), 0);
  const finalErrors = await page.evaluate(
    (ids) => ids.map((id) => ({ id, error: window.modelSwitchRuntimes.get(id)?.error })),
    [f.sessionId, other.id],
  );
  assert.ok(
    finalErrors.every(({ error }) => error === undefined),
    JSON.stringify(finalErrors),
  );
  assert.equal(await page.getByRole('alert').count(), 0);
  assert.deepEqual(errors, []);
  console.log(
    'PASS real Pi preserves model/thinking through tool continuation and runtime supplements; new user task uses the saved choice',
  );
  console.log(
    'PASS two sessions run concurrently, change models independently, survive renderer reload and stop independently',
  );
  console.log(
    'PASS idle controls hide without an operation; standalone chats retain output and hide project-only controls',
  );
} catch (error) {
  // Capture before cleanup stops sessions and changes the failure's runtime state.
  const output = path.resolve('output/playwright', `model-switch-ui-${process.platform}`);
  try {
    await fs.mkdir(output, { recursive: true });
    if (page && !page.isClosed()) {
      const snapshot = await page.evaluate(() => ({
        selectedSessionId: window.modelSwitchState?.selectedSessionId,
        sessions: window.modelSwitchState?.sessions.map(({ id, title, draft }) => ({ id, title, draft })),
        runtimes: [...(window.modelSwitchRuntimes?.values() ?? [])].map(
          ({ sessionId, status, connected, crash, error, model, thinking, thinkingLevels, nextTask }) => ({
            sessionId,
            status,
            connected,
            crash,
            error,
            model,
            thinking,
            thinkingLevels,
            nextTask,
          }),
        ),
        title: document.querySelector('.workspace-title h1')?.textContent,
        input: document.querySelector('textarea[aria-label="任务输入"]')?.value,
        button: document.querySelector('.send-button')?.outerHTML,
        disabled: document.querySelector('.send-button')?.disabled,
        pending: Boolean(document.querySelector('.send-button .spin')),
        alerts: [...document.querySelectorAll('[role="alert"]')].map((item) => item.textContent),
      }));
      console.error('Model-switch failure snapshot:', JSON.stringify(snapshot));
      await fs.writeFile(
        path.join(output, 'failure.json'),
        JSON.stringify({ error: String(error), rendererErrors: errors, ...snapshot }, null, 2),
      );
      await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true });
    }
  } catch (diagnosticError) {
    console.error('Could not capture model-switch failure:', diagnosticError);
  }
  throw error;
} finally {
  releaseResponse();
  releaseOther();
  if (page && !page.isClosed())
    await page
      .evaluate(async () => {
        const { state } = await window.desktop.invoke('bootstrap');
        await Promise.all(state.sessions.map((session) => window.desktop.invoke('stop', session.id)));
      })
      .catch(() => {});
  await app
    ?.evaluate(({ BrowserWindow }) => {
      return BrowserWindow.getAllWindows()[0]?.webContents.executeJavaScript(
        `void window.desktop.onEvent(event => {
            if (event.type === 'appDialog') void window.desktop.invoke('respondAppDialog', event.dialog.id,
              event.dialog.message === 'Pi 仍在执行任务' ? 1 : event.dialog.cancelId);
          })`,
      );
    })
    .catch(() => {});
  await app?.close().catch(() => {});
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
