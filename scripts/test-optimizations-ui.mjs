import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { expect } from 'playwright/test';
import { launchApp, closeApp } from '../tests/support/desktop-app.mjs';
import { createLocalProvider, prepareRealPiFixture } from '../tests/support/local-provider.ts';
import { emptyRuntime } from '../shared/types.ts';

const provider = await createLocalProvider();
const fixture = await prepareRealPiFixture(provider.baseUrl, 'optimization-ui');
const first = fixture.store.session(fixture.sessionId);
first.title = '优化验收';
for (const [title, lastStatus] of [
  ['后台完成', 'completed'],
  ['后台失败', 'error'],
]) {
  const session = fixture.store.createSession(fixture.projectId);
  Object.assign(session, { title, lastStatus, unread: true });
}
fixture.store.selectSession(fixture.sessionId);
await fixture.store.save();
const errors = [];
let app, page;
const result = { checks: [], screenshots: [] };
const runtime = {
  ...emptyRuntime(),
  sessionId: fixture.sessionId,
  connected: true,
  status: 'idle',
  model: {
    provider: 'local-e2e',
    id: 'local-e2e',
    name: '本地测试模型',
    reasoning: true,
    contextWindow: 128000,
  },
};
const inject = async (value) => {
  Object.assign(runtime, value);
  await app.evaluate(({ BrowserWindow }, runtime) => {
    globalThis.optimizationRuntime = runtime;
    BrowserWindow.getAllWindows()[0].webContents.send('desktop:event', { type: 'runtime', runtime });
  }, runtime);
};
try {
  ({ app, page } = await launchApp({ dataDir: fixture.dataDir, errors }));
  await page.getByRole('textbox', { name: '任务输入' }).waitFor();
  await app.evaluate(({ ipcMain, BrowserWindow }, runtime) => {
    const original = ipcMain._invokeHandlers.get('desktop:invoke');
    globalThis.optimizationRuntime = runtime;
    globalThis.optimizationCalls = [];
    globalThis.optimizationCompleteOutput = 'BEGIN_FULL\n' + '\u001b[31mred\u001b[0m\n'.repeat(10000);
    globalThis.optimizationFailSettings = false;
    ipcMain.removeHandler('desktop:invoke');
    ipcMain.handle('desktop:invoke', async (event, method, args) => {
      globalThis.optimizationCalls.push({
        method,
        args: method === 'saveDraft' ? [args[0], args[1], args[4]?.length, args[5]?.length] : args,
      });
      if (method === 'readHistory' && args[0] === globalThis.optimizationRuntime.sessionId)
        return globalThis.optimizationRuntime.messages;
      if (method === 'cleanupEmptySessions' || method === 'installUpdate' || method === 'revokeApproval')
        return method === 'cleanupEmptySessions' ? null : undefined;
      if (method === 'getToolOutput') {
        const tool = globalThis.optimizationRuntime.tools.find((tool) => tool.id === args[1]);
        return tool?.status === 'running' ? tool.output : globalThis.optimizationCompleteOutput;
      }
      if (method === 'saveSettings' && globalThis.optimizationFailSettings)
        throw new Error('EACCES: settings write denied');
      if (method === 'editDraft') {
        const snapshot = await original(event, 'bootstrap', []);
        globalThis.optimizationEditedDraft = snapshot.state.sessions.find((s) => s.id === args[0])?.draft;
        return;
      }
      if (method === 'respond') {
        globalThis.optimizationRuntime = { ...globalThis.optimizationRuntime, dialogs: [], status: 'idle' };
        BrowserWindow.getAllWindows()[0].webContents.send('desktop:event', {
          type: 'runtime',
          runtime: globalThis.optimizationRuntime,
        });
        return;
      }
      const value = await original(event, method, args);
      return method === 'bootstrap' ? { ...value, runtime: globalThis.optimizationRuntime } : value;
    });
  }, runtime);
  await page.reload();
  const input = page.getByRole('textbox', { name: '任务输入' });
  await input.waitFor();
  await expect(page.locator('.unread.completed')).toHaveAttribute('aria-label', '已完成，未查看');
  await expect(page.locator('.session-row .unread.error')).toHaveAttribute('aria-label', '出错，未查看');
  await page.getByText('待处理 1', { exact: true }).click();
  await expect(page.getByRole('menuitem', { name: '后台失败 · 出错' })).toBeVisible();
  await page.getByText('待处理 1', { exact: true }).click();
  result.checks.push('后台结果和待处理列表');

  await input.fill('ready');
  await inject({ status: 'stopping' });
  await expect(page.locator('.send-button')).toHaveAttribute('title', '正在停止，稍等一下');
  await inject({ status: 'idle' });
  await input.fill('界'.repeat(350000));
  await expect(page.locator('.send-button')).toHaveAttribute('title', /内容超过 1 MiB/);
  await input.fill('');
  // `bootstrap` starts a detection without awaiting it; its late broadcast would replace the
  // injected Node error below. `detect` returns only after its own broadcast has been sent.
  const environment = await page.evaluate(() => window.desktop.invoke('detect'));
  await inject({ connected: false });
  await app.evaluate(
    ({ BrowserWindow }, environment) =>
      BrowserWindow.getAllWindows()[0].webContents.send('desktop:event', {
        type: 'environment',
        environment: {
          ...environment,
          supported: false,
          version: undefined,
          errors: ['Pi 需要 Node.js 22.19 或更高版本，请选择 Node。'],
        },
      }),
    environment,
  );
  await expect(page.locator('.send-button')).toHaveAttribute('title', 'Pi 还没准备好，先完成开始前检查');
  await expect(page.getByRole('region', { name: '开始前检查' })).toContainText('Node.js 22.19');
  await page.getByRole('button', { name: '选择 Node', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Node.js 入口' })).toBeFocused();
  await page.locator('.modal footer').getByRole('button', { name: '关闭', exact: true }).click();
  await page.reload();
  await input.waitFor();
  const bootstrap = await page.evaluate(() => window.desktop.invoke('bootstrap'));
  bootstrap.state.projects.find((project) => project.id === fixture.projectId).trusted = false;
  await app.evaluate(
    ({ BrowserWindow }, snapshot) =>
      BrowserWindow.getAllWindows()[0].webContents.send('desktop:event', {
        type: 'state',
        state: snapshot.state,
        revision: snapshot.revision + 1,
      }),
    bootstrap,
  );
  await expect(page.locator('.send-button')).toHaveAttribute('title', /这个项目还没启用/);
  await page.locator('.send-wrapper').click();
  await expect(page.getByRole('button', { name: '启用项目', exact: true })).toBeFocused();
  await expect(page.getByRole('combobox', { name: '新项目审批方式' })).toHaveValue('auto');
  await page.reload();
  await input.waitFor();
  result.checks.push('发送原因、项目焦点和 Node 入口');
  await app.evaluate(({ BrowserWindow }, storage) => {
    BrowserWindow.getAllWindows()[0].webContents.send('desktop:event', {
      type: 'storage',
      storage: { ...storage, writable: false, problem: '测试目录暂时不能保存' },
    });
  }, bootstrap.storage);
  await expect(page.locator('.send-button')).toHaveAttribute('title', /本地数据暂时无法保存/);
  await page.locator('.send-wrapper').click();
  await expect(page.getByRole('button', { name: '打开数据目录', exact: true })).toBeFocused();
  await app.evaluate(({ BrowserWindow }, storage) => {
    BrowserWindow.getAllWindows()[0].webContents.send('desktop:event', { type: 'storage', storage });
  }, bootstrap.storage);

  await inject({
    connected: true,
    status: 'waiting',
    messages: Array.from({ length: 100 }, (_, index) => ({
      role: index % 2 ? 'assistant' : 'user',
      content: `历史消息 ${index}\n\n${'line\n'.repeat(8)}`,
      timestamp: 1000 + index,
    })),
    dialogs: [
      {
        id: 'approval-ui',
        method: 'input',
        title: 'approval',
        approval: {
          toolName: 'bash',
          kind: 'shell',
          summary: 'echo hi',
          grant: { id: 'grant-ui', kind: 'shell-exact', toolName: 'bash', command: 'echo hi' },
        },
      },
    ],
  });
  await expect(page.getByText('等待批准', { exact: true })).toBeVisible();
  await page.locator('.thread').evaluate((node) => {
    node.scrollTop = 0;
    node.dispatchEvent(new Event('scroll'));
  });
  const jump = page.getByRole('button', { name: '有 1 项待审批', exact: true });
  await expect(jump).toBeVisible();
  await jump.click();
  await expect(page.locator('button[data-allow]')).toBeFocused();
  await page.locator('.approval-actions button').nth(1).click();
  await page.locator('.toast').getByRole('button', { name: '撤销', exact: true }).click();
  assert.equal(
    await app.evaluate(
      () => globalThis.optimizationCalls.filter((call) => call.method === 'revokeApproval').length,
    ),
    1,
  );
  await inject({
    status: 'waiting',
    dialogs: [
      {
        id: 'ask-ui',
        method: 'input',
        title: 'Pi 需要你决定',
        ask: {
          questions: [
            {
              id: 'choice',
              header: '选择',
              question: '继续哪一个？',
              options: [{ label: '第一项', recommended: true }, { label: '第二项' }],
            },
          ],
        },
      },
    ],
  });
  await expect(page.getByText('等待你回答', { exact: true })).toBeVisible();
  await inject({ status: 'idle', dialogs: [], messages: [] });
  result.checks.push('审批跳转、焦点、撤销放行和等待文案');
  await inject({
    connected: false,
    status: 'interrupted',
    crash: {
      at: Date.now(),
      code: 1,
      signal: null,
      log: ['synthetic diagnostic'],
      cleanup: 'unconfirmed',
      lastTool: { name: 'bash', target: 'echo hi', seconds: 2 },
    },
  });
  await expect(page.getByRole('button', { name: '重新连接并继续', exact: true })).toBeDisabled();
  await expect(page.locator('.send-button')).toHaveAttribute(
    'title',
    /上次的命令可能还在运行，结束它们并重启应用后才能继续/,
  );
  await page.locator('.send-wrapper').click();
  await expect(page.locator('.crash-card')).toBeFocused();
  await expect(page.getByText(/退出码：1/)).not.toBeVisible();
  await expect(page.getByRole('button', { name: '重新检查', exact: true })).toHaveCount(0);
  await expect(page.locator('.crash-card')).toContainText('仅重启应用不会结束这些命令');
  await page.locator('.crash-card .button-row > details > summary').click();
  await expect(
    page.locator('.crash-card').getByRole('button', { name: '重新连接', exact: true }),
  ).toBeDisabled();
  await expect(
    page.locator('.crash-card').getByRole('button', { name: '撤销本轮修改', exact: true }),
  ).toBeDisabled();
  await inject({ crash: undefined, connected: true, status: 'idle' });
  result.checks.push('残留命令未确认时仍禁止重连和撤销，无重新检查入口；提示手动结束后重启、发送原因及焦点');
  const full = 'BEGIN_FULL\n' + '\u001b[31mred\u001b[0m\n'.repeat(10000);
  await inject({
    messages: [
      { role: 'user', content: 'logs', timestamp: 1 },
      { role: 'toolResult', content: full, toolName: 'bash', toolCallId: 'huge-log', timestamp: 2 },
    ],
    tools: [
      {
        id: 'huge-log',
        name: 'bash',
        args: { command: 'echo logs' },
        status: 'done',
        startedAt: 2,
        output: full.slice(-65536),
      },
    ],
  });
  await page.locator('.tool-card > summary').click();
  await expect(page.locator('.tool-body')).not.toContainText('BEGIN_FULL');
  assert.ok((await page.locator('.ansi-output span').count()) < 1000);
  const commits = [];
  for (let index = 0; index < 18; index++) {
    const marker = `ANSI_UPDATE_${index}`;
    await page.evaluate((marker) => {
      window.ansiCommit = new Promise((resolve, reject) => {
        const start = performance.now();
        const root = document.querySelector('.ansi-output');
        const timer = setTimeout(() => {
          observer.disconnect();
          reject(new Error('ANSI update timed out'));
        }, 5000);
        const observer = new MutationObserver(() => {
          if (!root.textContent.includes(marker)) return;
          clearTimeout(timer);
          observer.disconnect();
          resolve(performance.now() - start);
        });
        observer.observe(root, { subtree: true, childList: true, characterData: true });
      });
    }, marker);
    await app.evaluate(({ BrowserWindow }, marker) => {
      const runtime = globalThis.optimizationRuntime;
      const tool = {
        ...runtime.tools[0],
        status: 'running',
        output: '\u001b[31mred\u001b[0m\n'.repeat(199) + marker,
      };
      runtime.tools = [tool];
      BrowserWindow.getAllWindows()[0].webContents.send('desktop:event', {
        type: 'runtimePatch',
        patch: {
          sessionId: runtime.sessionId,
          messagesFrom: runtime.messages.length,
          messages: [],
          messageCount: runtime.messages.length,
          toolsFrom: 0,
          tools: [tool],
          toolCount: 1,
        },
      });
    }, marker);
    const elapsed = await page.evaluate(() => window.ansiCommit);
    if (index >= 2) commits.push(elapsed);
    assert.ok((await page.locator('.ansi-output span').count()) < 1000);
  }
  commits.sort((a, b) => a - b);
  result.ansiUpdateP95Ms = commits[Math.floor(commits.length * 0.95)];
  assert.ok(result.ansiUpdateP95Ms < 16, JSON.stringify(commits));
  await inject({
    tools: [
      {
        id: 'huge-log',
        name: 'bash',
        args: { command: 'echo logs' },
        status: 'running',
        startedAt: 2,
        output: full.slice(-65536),
      },
    ],
  });
  await page.getByRole('button', { name: '显示全部', exact: true }).click();
  await expect(page.locator('.tool-body')).toContainText('命令仍在运行');
  await app.evaluate(() => {
    globalThis.optimizationCompleteOutput += '\nAFTER_SHOW_ALL';
  });
  await inject({ tools: [{ ...runtime.tools[0], output: runtime.tools[0].output + '\nAFTER_SHOW_ALL' }] });
  await expect(page.locator('.tool-body')).toContainText('AFTER_SHOW_ALL');
  await app.evaluate(() => {
    globalThis.optimizationCompleteOutput += '\nFINAL_OUTPUT';
  });
  await inject({
    tools: [{ ...runtime.tools[0], status: 'done', output: runtime.tools[0].output + '\nFINAL_OUTPUT' }],
  });
  await expect(page.locator('.tool-body')).toContainText('FINAL_OUTPUT');
  await expect(page.locator('.tool-body')).toContainText('BEGIN_FULL');
  await page.getByRole('button', { name: '复制输出', exact: true }).click();
  assert.ok(
    await app.evaluate(() =>
      globalThis.optimizationCalls.some(
        (call) =>
          call.method === 'copy' && call.args[0].startsWith('BEGIN_FULL') && call.args[0].length > 30000,
      ),
    ),
  );
  await inject({ messages: [], tools: [] });
  result.checks.push('日志渲染上限、显示全部和完整复制');
  const updateState = {
    ...bootstrap.update,
    state: 'ready',
    enabled: true,
    mode: 'auto',
    installation: 'nsis',
    version: '9.0.0',
    installing: false,
  };
  await app.evaluate(
    ({ BrowserWindow }, update) =>
      BrowserWindow.getAllWindows()[0].webContents.send('desktop:event', { type: 'update', update }),
    updateState,
  );
  await inject({ status: 'running' });
  await page.getByRole('button', { name: '重启以更新到 v9.0.0', exact: true }).click();
  const automatic = page.getByRole('checkbox', { name: '任务结束后自动重启', exact: true });
  await automatic.check();
  await expect(page.locator('.automatic-update')).not.toBeVisible();
  await inject({ status: 'idle' });
  await expect(page.locator('.automatic-update')).toBeVisible();
  await page.getByRole('button', { name: '取消重启', exact: true }).click();
  await expect(automatic).not.toBeChecked();
  await automatic.check();
  await expect(page.locator('.automatic-update')).not.toBeVisible();
  await page.waitForTimeout(5200);
  assert.equal(
    await app.evaluate(
      () => globalThis.optimizationCalls.filter((call) => call.method === 'installUpdate').length,
    ),
    0,
  );
  await inject({ status: 'running' });
  await expect(page.locator('.automatic-update')).not.toBeVisible();
  await inject({ status: 'idle' });
  await expect
    .poll(
      () =>
        app.evaluate(
          () => globalThis.optimizationCalls.filter((call) => call.method === 'installUpdate').length,
        ),
      { timeout: 10000 },
    )
    .toBe(1);
  await page.locator('.modal footer').getByRole('button', { name: '稍后', exact: true }).click();
  await app.evaluate(
    ({ BrowserWindow }, update) =>
      BrowserWindow.getAllWindows()[0].webContents.send('desktop:event', { type: 'update', update }),
    bootstrap.update,
  );
  result.checks.push('任务结束后的更新倒计时、取消和新任务保护');

  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '外观与编辑器', exact: true }).click();
  const notify = page.getByRole('checkbox', { name: /任务完成时发送系统通知/ });
  await notify.setChecked(!(await notify.isChecked()));
  await expect(page.locator('.settings-content')).toContainText('未保存');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(page.locator('.settings-footer-note')).toContainText('已保存');
  await expect(page.locator('.settings-footer-note')).not.toContainText('已保存', { timeout: 4000 });
  await app.evaluate(() => {
    globalThis.optimizationFailSettings = true;
  });
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(page.locator('.modal .error-banner')).toBeVisible();
  await expect(page.locator('.settings-footer-note')).not.toContainText('已保存');
  await app.evaluate(() => {
    globalThis.optimizationFailSettings = false;
  });
  await page.getByRole('button', { name: '关闭设置错误', exact: true }).click();
  await page.getByRole('button', { name: '诊断与数据', exact: true }).click();
  await page.getByRole('button', { name: '清理空会话', exact: true }).click();
  await expect(page.locator('.toast').filter({ hasText: '未清理会话' })).toHaveCount(0);
  await page.locator('.modal footer').getByRole('button', { name: '关闭', exact: true }).click();
  result.checks.push('设置未保存状态及取消清理');

  await input.fill('');
  await app.evaluate(() => {
    globalThis.optimizationCalls = [];
  });
  await input.focus();
  await input.evaluate((node) => {
    const data = new DataTransfer();
    data.setData('text/plain', 'paste '.repeat(17000));
    node.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await input.pressSequentially('a'.repeat(50), { delay: 5 });
  await expect(input).toHaveValue('a'.repeat(50));
  assert.equal(
    await input.evaluate((node) => node.selectionStart),
    50,
    'Paste must not move the caret after typing',
  );
  await page.waitForTimeout(600);
  const saves = await app.evaluate(() =>
    globalThis.optimizationCalls.filter((call) => call.method === 'saveDraft'),
  );
  assert.ok(saves.length <= 3, JSON.stringify(saves.map((save) => save.args)));
  await input.pressSequentially('before-switch');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+n' : 'Control+n');
  await expect(input).toHaveValue('');
  await page.locator(`[data-session-id="${fixture.sessionId}"] > button`).first().click();
  await expect(input).toHaveValue('a'.repeat(50) + 'before-switch');
  await input.pressSequentially('external-switch');
  await page.evaluate(() => window.desktop.invoke('newSession'));
  await expect(input).toHaveValue('');
  await page.locator(`[data-session-id="${fixture.sessionId}"] > button`).first().click();
  await expect(input).toHaveValue('a'.repeat(50) + 'before-switchexternal-switch');
  result.draftSavesDuring50Keys = saves.length;
  result.checks.push('100 KB 片段打字防抖和切换前立即保存');
  await page.evaluate(() => window.desktop.invoke('newSession'));
  await expect(input).toHaveValue('');
  const blank = (await page.evaluate(() => window.desktop.invoke('bootstrap'))).state.selectedSessionId;
  await input.fill('native menu first draft');
  await app.evaluate(({ Menu }) =>
    Menu.getApplicationMenu().getMenuItemById('file').submenu.items[0].click(),
  );
  await expect(input).toHaveValue('');
  await page.evaluate((id) => window.desktop.invoke('selectSession', id), blank);
  await expect(input).toHaveValue('native menu first draft');
  await page.locator(`[data-session-id="${fixture.sessionId}"] > button`).first().click();
  await expect(input).toHaveValue('a'.repeat(50) + 'before-switchexternal-switch');
  result.checks.push('原生菜单新建会话前保存尚未发出的首条草稿');
  await input.pressSequentially('external-editor-latest');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+g' : 'Control+g');
  await expect
    .poll(() => app.evaluate(() => globalThis.optimizationEditedDraft))
    .toMatch(/external-editor-latest$/);
  result.checks.push('外部编辑快捷键先保存尚未满 200 ms 的输入');
  await fs.mkdir('test-results', { recursive: true });
  for (const uiStyle of ['classic', 'codex', 'claude']) {
    await page.evaluate(
      (uiStyle) => window.desktop.invoke('saveSettings', { uiStyle, theme: 'light' }),
      uiStyle,
    );
    const screenshot = path.resolve(`test-results/optimizations-${uiStyle}.png`);
    await page.screenshot({ path: screenshot });
    result.screenshots.push(screenshot);
  }
  assert.deepEqual(errors, []);
  await input.pressSequentially('saved-on-close');
  await app.close();
  app = undefined;
  const saved = JSON.parse(await fs.readFile(path.join(fixture.dataDir, 'state.json'), 'utf8'));
  assert.ok(
    saved.sessions.find((session) => session.id === fixture.sessionId).draft.endsWith('saved-on-close'),
  );
  result.checks.push('关闭窗口前保存防抖中的草稿');
  await fs.writeFile('test-results/optimizations-ui.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} catch (error) {
  await fs.mkdir('test-results', { recursive: true });
  if (page) {
    await page.screenshot({ path: 'test-results/optimizations-failure.png' }).catch(() => {});
    console.error({
      errors,
      body: await page
        .locator('body')
        .innerText()
        .catch(() => ''),
      error: String(error),
    });
  }
  throw error;
} finally {
  if (app) await closeApp(app);
  await provider.close();
}
