import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { emptyRuntime } from '../shared/types.ts';
import { createLocalProvider, prepareRealPiFixture } from '../tests/support/local-provider.ts';

const provider = await createLocalProvider();
const f = await prepareRealPiFixture(provider.baseUrl, 'polish-ui');
const menuHistory = path.join(f.dir, 'menu-session.jsonl');
await fs.writeFile(
  menuHistory,
  JSON.stringify({
    type: 'session',
    version: 3,
    id: 'menu-session',
    timestamp: new Date().toISOString(),
    cwd: f.projectDir,
  }) + '\n',
);
// Seed protected records before launch; use only the fixture's isolated app-data directory.
const protectedFields = [
  { title: '自定义名称', file: menuHistory },
  { draft: ' ' },
  { attachments: ['输入 文件.txt'] },
  { draftSnippets: [{ id: 'snippet', offset: 0, text: '长草稿' }] },
  {
    images: [
      {
        id: 'image',
        name: 'icon.png',
        mimeType: 'image/png',
        data: (await fs.readFile('build/icon.png')).toString('base64'),
      },
    ],
  },
  { model: { provider: 'local-e2e', id: 'local-e2e' } },
  { thinking: 'off' },
  { approvalMode: 'confirm' },
  { pinned: true },
  { unread: true },
];
const protectedSessions = protectedFields.map((fields) => Object.assign(f.store.createSession(), fields));
// These model already-persisted empty rows from older releases, not new transient placeholders.
const cleanupRace = f.store.createSession();
const cleanupLegacy = f.store.createSession();
await f.store.save();
const output = path.resolve('test-results/polish');
await fs.mkdir(output, { recursive: true });
let app, page;
try {
  app = await electron.launch({
    args: [path.resolve('.')],
    env: { ...process.env, PI_DESKTOP_DATA_DIR: f.dataDir, PI_OFFLINE: '1' },
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  await page.getByRole('textbox', { name: '任务输入' }).waitFor();
  const originalViewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  await page.setViewportSize({ width: 1100, height: 450 });
  const projectList = page.locator('.project-list');
  const assertMenuReachable = async () => {
    const menu = page.locator('.context-menu');
    await menu.evaluate((element) => Promise.all(element.getAnimations().map((a) => a.finished)));
    const reachable = await menu.locator('button').evaluateAll((buttons) =>
      buttons.every((button) => {
        const rect = button.getBoundingClientRect();
        return (
          rect.top >= 0 &&
          rect.bottom <= innerHeight &&
          rect.left >= 0 &&
          rect.right <= innerWidth &&
          button.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2))
        );
      }),
    );
    assert.equal(reachable, true, 'Every sidebar menu action must be visible and receive pointer input');
    await menu.locator('button').last().click({ trial: true });
  };
  const lastSession = page.locator('.session-row').last();
  await lastSession.evaluate((element) => element.scrollIntoView({ block: 'end' }));
  await page.evaluate(() => new Promise(requestAnimationFrame));
  const scrollHeight = await projectList.evaluate((element) => element.scrollHeight);
  await lastSession.locator('.icon-button').click();
  assert.equal(await page.getByRole('menuitem', { name: '导出 HTML', exact: true }).count(), 1);
  await assertMenuReachable();
  assert.equal(await projectList.evaluate((element) => element.scrollHeight), scrollHeight);
  await page.screenshot({ path: path.join(output, 'sidebar-menu.png') });
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.context-menu').count(), 0);
  await lastSession.click({ button: 'right' });
  await assertMenuReachable();
  await projectList.evaluate((element) => {
    element.scrollTop = element.scrollTop ? 0 : element.scrollHeight;
  });
  await page.locator('.context-menu').waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'Pi GUI 验收项目 项目操作', exact: true }).click();
  await assertMenuReachable();
  await page.setViewportSize(originalViewport);
  await page.locator('.context-menu').waitFor({ state: 'detached' });
  console.log(
    'PASS session and project menus remain clickable at the list bottom; scroll, resize and Escape close them',
  );
  const result = await page.evaluate(async () => {
    const api = window.desktop;
    const first = await api.invoke('newSession');
    const second = await api.invoke('newSession');
    await api.invoke('saveDraft', first.id, '保留草稿', [], [], []);
    const third = await api.invoke('newSession');
    const snap = await api.invoke('bootstrap');
    return { first, second, third, snap };
  });
  assert.equal(result.first.id, result.second.id);
  assert.notEqual(result.first.id, result.third.id);
  assert.equal(result.snap.state.sessions.find((s) => s.id === result.first.id).draft, '保留草稿');
  assert.equal(result.snap.runtime.connected, false);
  assert.equal(provider.requests.length, 0);
  const concurrent = await page.evaluate(async (projectId) => {
    const api = window.desktop;
    const [standalone, project] = await Promise.all([
      Promise.all(Array.from({ length: 8 }, () => api.invoke('newSession'))),
      Promise.all(Array.from({ length: 8 }, () => api.invoke('newSession', projectId))),
    ]);
    // Autosave and another new-session request can overlap; contents must survive either ordering.
    await Promise.all([
      api.invoke('saveDraft', standalone[0].id, '并发草稿', ['输入 文件.txt'], [], []),
      api.invoke('newSession'),
    ]);
    return { standalone, project, state: (await api.invoke('bootstrap')).state };
  }, f.projectId);
  assert.equal(new Set(concurrent.standalone.map((s) => s.id)).size, 1);
  assert.equal(new Set(concurrent.project.map((s) => s.id)).size, 1);
  assert.notEqual(concurrent.project[0].id, concurrent.standalone[0].id);
  const savedConcurrent = concurrent.state.sessions.find((s) => s.id === concurrent.standalone[0].id);
  assert.equal(savedConcurrent.draft, '并发草稿');
  assert.deepEqual(savedConcurrent.attachments, ['输入 文件.txt']);
  for (let index = 0; index < protectedSessions.length; index++) {
    const saved = concurrent.state.sessions.find((s) => s.id === protectedSessions[index].id);
    assert.ok(saved);
    for (const [key, value] of Object.entries(protectedFields[index])) assert.deepEqual(saved[key], value);
  }
  const raceId = cleanupRace.id;
  assert.ok(concurrent.state.sessions.some((s) => s.id === raceId));
  await page.evaluate(() => {
    window.polishCleanup = window.desktop.invoke('cleanupEmptySessions');
  });
  const confirmation = page.getByRole('dialog', { name: /清理 .* 个空会话/ });
  await confirmation.waitFor();
  await page.evaluate(
    (id) => window.desktop.invoke('saveDraft', id, '确认期间到达的草稿', ['输入 文件.txt'], [], []),
    raceId,
  );
  await confirmation.getByRole('button', { name: '清理空会话', exact: true }).click();
  const removed = await page.evaluate(() => window.polishCleanup);
  assert.ok(removed > 0);
  const afterCleanup = await page.evaluate(async () => (await window.desktop.invoke('bootstrap')).state);
  assert.equal(afterCleanup.sessions.find((s) => s.id === raceId).draft, '确认期间到达的草稿');
  assert.equal(
    afterCleanup.sessions.some((s) => s.id === cleanupLegacy.id),
    false,
  );
  for (let index = 0; index < protectedSessions.length; index++) {
    const saved = afterCleanup.sessions.find((s) => s.id === protectedSessions[index].id);
    assert.ok(saved);
    for (const [key, value] of Object.entries(protectedFields[index])) assert.deepEqual(saved[key], value);
  }
  console.log('PASS confirmed cleanup rechecks an arriving draft and preserves every protected record');
  await page.evaluate((id) => window.desktop.invoke('selectSession', id), result.third.id);
  console.log(
    'PASS concurrent requests reuse one placeholder per scope and preserve autosaves and all protected metadata',
  );

  console.log('PASS real IPC reuses untouched placeholder, protects draft, and keeps Pi disconnected');

  const runtime = {
    ...emptyRuntime(),
    sessionId: result.third.id,
    status: 'completed',
    connected: true,
    messages: [
      { role: 'user', content: '第一轮', timestamp: 1000 },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'SHARED_NEEDLE FIRST 中文思考' },
          { type: 'text', text: '中间说明' },
        ],
      },
      { role: 'toolResult', toolCallId: 'read', toolName: 'read', content: 'read output' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'SHARED_NEEDLE SECOND_NEEDLE 完整保留' },
          { type: 'text', text: '最终结论' },
        ],
      },
      { role: 'user', content: '第二轮', timestamp: 2000 },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'THIRD 独立轮次' },
          { type: 'text', text: '第二轮结论' },
        ],
      },
    ],
    tools: [
      {
        id: 'read',
        name: 'read',
        args: { path: 'hello.txt' },
        status: 'done',
        output: '\x1b[32mread output\x1b[0m',
        startedAt: 1,
      },
    ],
  };
  await app.evaluate(({ ipcMain }, runtime) => {
    const handler = ipcMain._invokeHandlers.get('desktop:invoke');
    globalThis.polishRuntime = runtime;
    globalThis.polishActions = [];
    ipcMain.removeHandler('desktop:invoke');
    ipcMain.handle('desktop:invoke', async (event, method, args) => {
      if (method === 'readHistory') return globalThis.polishRuntime.messages;
      if (['messageAction', 'stop'].includes(method) && args[0] === globalThis.polishRuntime.sessionId) {
        globalThis.polishActions.push({ method, args });
        return;
      }
      if (method === 'copy' && globalThis.polishFailCopy) throw new Error('Fixture clipboard unavailable');
      const value = await handler(event, method, args);
      return method === 'bootstrap' ? { ...value, runtime: globalThis.polishRuntime } : value;
    });
  }, runtime);
  await page.reload();
  await page.getByRole('textbox', { name: '任务输入' }).waitFor();
  await page.waitForFunction(() => document.querySelectorAll('.thinking').length === 2);
  assert.equal(await page.locator('.thinking[open]').count(), 0);
  await page.locator('.thinking summary').first().click();
  assert.equal(
    await page.locator('.thinking pre').first().textContent(),
    'SHARED_NEEDLE FIRST 中文思考\n\nSHARED_NEEDLE SECOND_NEEDLE 完整保留',
  );
  assert.ok(await page.getByText('最终结论', { exact: true }).isVisible());
  await page.getByRole('button', { name: '收起所有思考过程', exact: true }).click();
  assert.equal(await page.locator('.thinking[open]').count(), 0);
  await page.evaluate(() => window.dispatchEvent(new Event('pi:find')));
  await page.getByRole('textbox', { name: '查找当前会话' }).fill('SECOND_NEEDLE');
  await page.locator('.thinking .search-current').waitFor();
  assert.equal(await page.locator('.thinking .search-current').textContent(), 'SECOND_NEEDLE');
  assert.equal(await page.locator('.thinking[open]').count(), 1);
  await page.getByRole('textbox', { name: '查找当前会话' }).fill('SHARED_NEEDLE');
  await page.waitForFunction(() =>
    document.querySelector('.thinking pre')?.firstElementChild?.classList.contains('search-current'),
  );
  await page.locator('.thinking summary').first().click();
  assert.equal(
    await page
      .locator('.thinking')
      .first()
      .evaluate((el) => el.open),
    false,
  );
  await page.getByRole('button', { name: '下一个匹配', exact: true }).click();
  await page.waitForFunction(() =>
    document.querySelector('.thinking pre')?.lastElementChild?.classList.contains('search-current'),
  );
  assert.equal(
    await page
      .locator('.thinking')
      .first()
      .evaluate((el) => el.open),
    true,
  );
  assert.ok(await page.locator('.thinking .search-current').isVisible());
  console.log('PASS the next assistant thinking search match reopens a manually collapsed turn');
  await page.getByRole('button', { name: '关闭会话查找' }).click();
  console.log(
    'PASS one thinking region per turn, ordered content, collapsed history, batch collapse and search',
  );

  // Publish actual IPC runtime events to exercise the same mounted thinking block during streaming.
  const publish = async (patch) =>
    app.evaluate(({ BrowserWindow }, patch) => {
      Object.assign(globalThis.polishRuntime, patch);
      BrowserWindow.getAllWindows()[0].webContents.send('desktop:event', {
        type: 'runtime',
        runtime: globalThis.polishRuntime,
      });
    }, patch);
  await publish({ status: 'running' });
  await page.locator('.thinking summary').last().click();
  await page.waitForFunction(() => document.querySelectorAll('.thinking[open]').length === 1);
  const appended = structuredClone(runtime.messages);
  appended[appended.length - 1].content[0].thinking += '\nSTREAM_APPEND';
  await publish({ messages: appended });
  // webContents.send acknowledges IPC dispatch, not React's committed DOM.
  await page.waitForFunction(
    (expected) => [...document.querySelectorAll('.thinking pre')].at(-1)?.textContent === expected,
    appended.at(-1).content[0].thinking,
  );
  assert.equal(await page.locator('.thinking').count(), 2);
  assert.ok((await page.locator('.thinking pre').last().textContent()).includes('STREAM_APPEND'));
  await publish({ status: 'completed' });
  await page.waitForFunction(() => document.querySelectorAll('.thinking[open]').length === 0);
  const longTurn = [
    runtime.messages[0],
    ...Array.from({ length: 100 }, (_, i) => ({
      role: 'assistant',
      content: [{ type: 'thinking', thinking: `PAGE_${i}` }],
      timestamp: 10000 + i,
    })),
  ];
  await publish({ messages: longTurn });
  await page.waitForFunction(() => document.querySelectorAll('.thinking').length === 1);
  await page.locator('.thinking summary').click();
  assert.ok((await page.locator('.thinking pre').textContent()).startsWith('PAGE_0\n\nPAGE_1'));
  assert.ok((await page.locator('.thinking pre').textContent()).endsWith('PAGE_99'));
  await publish({ messages: runtime.messages });
  await page.waitForFunction(() => document.querySelectorAll('.thinking').length === 2);
  console.log(
    'PASS streaming append retains one region, completion collapses it, and pagination retains complete thinking',
  );

  await page.locator('.tool-card summary').click();
  const copy = page.getByRole('button', { name: '复制输出', exact: true });
  assert.equal(await copy.textContent(), '');
  await copy.click();
  await page.getByRole('status').filter({ hasText: '已复制' }).waitFor();
  assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), 'read output');
  const font = await page
    .locator('.thinking pre')
    .first()
    .evaluate((el) => ({ size: getComputedStyle(el).fontSize, family: getComputedStyle(el).fontFamily }));
  assert.equal(font.size, '13px');
  assert.ok(!font.family.includes('Consolas'));
  assert.equal(
    await page
      .locator('.tool-body pre')
      .first()
      .evaluate((el) => getComputedStyle(el).fontSize),
    '13px',
  );
  assert.equal(
    await page.locator('.sidebar-footer').getByRole('button', { name: '打开项目', exact: true }).count(),
    0,
  );
  const add = await page.getByRole('button', { name: '添加项目', exact: true }).boundingBox();
  const last = await page.locator('.project-actions .icon-button').last().boundingBox();
  assert.ok(Math.abs(add.x + add.width / 2 - last.x - last.width / 2) < 1);
  const sessionMenu = await page
    .locator(`[data-session-id="${result.third.id}"] > .icon-button`)
    .boundingBox();
  assert.ok(Math.abs(add.x + add.width / 2 - sessionMenu.x - sessionMenu.width / 2) < 1);
  await copy.evaluate((button) => button.focus());
  await page.keyboard.press('Enter');
  await page.getByRole('status').filter({ hasText: '已复制' }).waitFor();
  await app.evaluate(() => {
    globalThis.polishFailCopy = true;
  });
  await copy.click();
  await page.getByRole('status').filter({ hasText: '复制失败' }).waitFor();
  assert.equal(await copy.locator('.lucide-check').count(), 0);
  await app.evaluate(() => {
    globalThis.polishFailCopy = false;
  });
  await copy.click();
  await page.getByRole('status').filter({ hasText: '已复制' }).waitFor();
  await page.locator('.thinking summary').first().click();
  await page.locator('.thread').evaluate((el) => {
    el.scrollTop = 0;
  });
  await page.screenshot({ path: path.join(output, 'light.png') });
  await page.evaluate(async () => {
    const { state } = await window.desktop.invoke('bootstrap');
    await window.desktop.invoke('saveSettings', { ...state.settings, theme: 'dark' });
  });
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await page.screenshot({ path: path.join(output, 'dark.png') });
  console.log('PASS clipboard feedback, readable fonts, project entry and alignment; light/dark screenshots');

  const thinkingOnly = (stopReason, timestamp, marker) => ({
    role: 'assistant',
    timestamp,
    stopReason,
    content: [{ type: 'thinking', thinking: marker }],
    model: 'thinking-model',
    provider: 'local-test',
    usage: { totalTokens: 130, input: 100, output: 30, cost: { total: 0.05 } },
  });
  const completed = thinkingOnly('stop', 3100, 'ONLY_THINKING_COMPLETED');
  const user = { role: 'user', content: '只有思考的回复', timestamp: 3000 };
  const assertTerminal = async (marker) => {
    await page.waitForFunction(() => document.querySelectorAll('.reply-meta').length === 1);
    assert.equal(await page.locator('.message.assistant').count(), 1);
    const meta = page.locator('.reply-meta');
    assert.match(await meta.textContent(), /thinking-model.*130 tokens.*\$0\.05/);
    assert.equal(await page.getByRole('button', { name: '重新生成这条回复', exact: true }).count(), 1);
    assert.ok(await page.getByRole('button', { name: '重新生成这条回复', exact: true }).isEnabled());
    assert.equal(await page.locator('.thinking').count(), 1);
    await page.locator('.thinking summary').click();
    assert.equal(await page.locator('.thinking pre').textContent(), marker);
    assert.ok(!(await page.locator('.message.assistant').textContent()).includes(marker));
  };
  await publish({ status: 'completed', tools: [], messages: [user, completed] });
  await assertTerminal('ONLY_THINKING_COMPLETED');
  await page.getByRole('button', { name: '重新生成这条回复', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('[aria-label="重新生成这条回复"]')?.disabled);
  assert.deepEqual(await app.evaluate(() => globalThis.polishActions), [
    { method: 'messageAction', args: [result.third.id, 'regenerate', 'assistant', 3100] },
  ]);
  const streaming = thinkingOnly(undefined, 3101, 'ONLY_THINKING_CANCELLED');
  await publish({ status: 'running', messages: [user, streaming] });
  await page.getByRole('button', { name: '停止任务', exact: true }).click();
  assert.deepEqual(await app.evaluate(() => globalThis.polishActions.at(-1)), {
    method: 'stop',
    args: [result.third.id],
  });
  const cancelled = { ...streaming, stopReason: 'aborted' };
  await publish({ status: 'stopped', messages: [user, cancelled] });
  await page.waitForFunction(() => document.querySelectorAll('.thinking[open]').length === 0);
  await assertTerminal('ONLY_THINKING_CANCELLED');
  await page.getByRole('button', { name: '重新生成这条回复', exact: true }).click();
  assert.deepEqual(await app.evaluate(() => globalThis.polishActions.at(-1)), {
    method: 'messageAction',
    args: [result.third.id, 'regenerate', 'assistant', 3101],
  });
  await publish({
    status: 'completed',
    messages: [user, thinkingOnly('stop', 3102, 'ONLY_THINKING_REGENERATED')],
  });
  await page.waitForFunction(
    () => document.querySelector('.thinking pre')?.textContent === 'ONLY_THINKING_REGENERATED',
  );
  assert.equal(await page.locator('.reply-meta').count(), 1);
  assert.equal(await page.locator('.message.assistant').count(), 1);
  assert.equal(await page.getByRole('button', { name: '重新生成这条回复', exact: true }).count(), 1);
  await page.screenshot({ path: path.join(output, 'thinking-terminal.png') });
  await publish({ messages: [user, completed, { ...user, timestamp: 4000 }, cancelled] });
  await page.waitForFunction(() => document.querySelectorAll('.reply-meta').length === 2);
  assert.equal(await page.locator('.thinking').count(), 2);
  assert.equal(await page.getByRole('button', { name: '重新生成这条回复', exact: true }).count(), 1);
  console.log(
    'PASS thinking-only completion, cancellation, history metadata and regenerate IPC retain one copy of content and actions',
  );
} catch (error) {
  await page?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await app?.close();
  await provider.close();
}
