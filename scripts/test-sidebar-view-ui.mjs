import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'playwright/test';
import { DEFAULT_SIDEBAR_VIEW } from '../shared/sidebar-view.ts';
import { closeApp, launchApp } from '../tests/support/desktop-app.mjs';
import { prepareRealPiFixture } from '../tests/support/local-provider.ts';
import { createTeamProvider } from '../tests/support/team-provider.ts';

const output = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-sidebar-view-ui-'));
const provider = await createTeamProvider();
const errors = [];
const check = expect.configure({ timeout: 30000 });
let app, page, fixture;

const sidebar = () => page.getByRole('complementary', { name: '项目与会话' });
const trigger = () => sidebar().locator('.sidebar-view-trigger');
const group = (key) => sidebar().locator(`[data-sidebar-group="${key}"]`);
const dropTarget = (key) => sidebar().locator(`[data-drop-target="${key}"]`).first();
const row = (id) => sidebar().locator(`[data-session-id="${id}"]`);
const item = (name, role = 'menuitem') => page.getByRole(role, { name, exact: true });
const input = () => page.getByRole('textbox', { name: '任务输入' });
const invoke = (method, ...args) =>
  page.evaluate(({ method, args }) => window.desktop.invoke(method, ...args), { method, args });
const state = async () => (await invoke('bootstrap')).state;
const indexFile = () => path.join(fixture.dataDir, 'state.json');
const disk = async () => JSON.parse(await fs.readFile(indexFile(), 'utf8'));
const sessionOnDisk = async (id) => (await disk()).sessions.find((session) => session.id === id);
const sectionKey = async (name) =>
  `section:${(await disk()).sections.find((section) => section.name === name).id}`;
const inGroup = (id, key) => check(group(key).locator(`[data-session-id="${id}"]`)).toBeVisible();
const rowIds = (list) =>
  list.locator('[data-session-id]').evaluateAll((rows) => rows.map((node) => node.dataset.sessionId));
const nextRequest = async () => {
  await check.poll(() => provider.pending.length).toBe(1);
  return provider.pending[0];
};

async function open(dataDir, appRoot = process.cwd()) {
  ({ app, page } = await launchApp({
    dataDir,
    errors,
    args: [
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      path.resolve(appRoot),
    ],
  }));
  await input().waitFor();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 1000));
  await page.bringToFront();
}

async function close() {
  const current = app;
  app = undefined;
  await closeApp(current);
}

async function submenu(name) {
  await trigger().click();
  await item(new RegExp(`^${name}(?:\\s|$)`)).click();
}

async function choose(menu, choice) {
  await submenu(menu);
  await item(choice, 'menuitemradio').click();
  await check(page.getByRole('menu')).toHaveCount(0);
}

async function toggle(choice) {
  await submenu('显示');
  await item(choice, 'menuitemcheckbox').click();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
}

async function sessionMenu(id) {
  await row(id)
    .getByRole('button', { name: / 会话操作$/ })
    .click();
}

async function moveToSection(id, name) {
  await sessionMenu(id);
  await item('放入分区').click();
  await page.getByRole('menu').getByText(name, { exact: true }).click();
}

async function nameSection(title, name) {
  const dialog = page.getByRole('dialog', { name: title, exact: true });
  await dialog.getByRole('textbox', { name: '新名称' }).fill(name);
  await dialog.getByRole('button', { name: title === '新建分区' ? '创建' : '保存', exact: true }).click();
  return dialog;
}

async function createSection(name) {
  await trigger().click();
  await item('新建分区…').click();
  await check(await nameSection('新建分区', name)).toBeHidden();
  return sectionKey(name.trim());
}

async function drag(id, target, feedback) {
  const source = row(id).locator('button').first();
  await source.scrollIntoViewIfNeeded();
  const from = await source.boundingBox();
  await page.mouse.move(from.x + 18, from.y + from.height / 2);
  await page.mouse.down();
  try {
    await page.mouse.move(from.x + 26, from.y + from.height / 2);
    await page.locator('.session-drag-ghost').waitFor();
    const header = target.locator(':scope > .project-header, :scope > .section-heading').first();
    await header.scrollIntoViewIfNeeded();
    const to = await header.boundingBox();
    await page.mouse.move(to.x + 18, to.y + to.height / 2);
    if (feedback) await check(target.getByText(feedback, { exact: true }).first()).toBeVisible();
  } finally {
    await page.mouse.up();
  }
}

async function datedFile(title, when) {
  const id = randomUUID();
  const timestamp = new Date(when).toISOString();
  const file = path.join(output, `${timestamp.replace(/[:.]/g, '-')}_${id}.jsonl`);
  await fs.writeFile(
    file,
    [
      { type: 'session', version: 3, id, timestamp, cwd: fixture.projectDir },
      { type: 'session_info', id: 'name', parentId: null, timestamp, name: title },
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n') + '\n',
  );
  return file;
}

/**
 * 1. 从点击时刻计时，等目标列表提交到 DOM 后读下一帧。
 * 2. 同一份 500 会话数据分别跑新版和基线的真实 Pi 流式请求。
 */
async function measureSidebar() {
  const baselineRoot = process.env.PI_SIDEBAR_BASELINE_APP_ROOT;
  const bench = await prepareRealPiFixture(provider.baseUrl, path.join(output, 'performance'));
  const { store, sessionId, dataDir } = bench;
  const stamp = Date.now();
  for (let i = 1; i < 30; i++) {
    const folder = path.join(bench.dir, `project-${i}`);
    await fs.mkdir(folder);
    store.state.projects.push({
      id: `project-${i}`,
      name: `性能项目 ${i}`,
      path: folder,
      createdAt: stamp,
      trusted: true,
    });
  }
  Object.assign(store.session(sessionId), { title: '侧栏流式样本', updatedAt: stamp });
  for (let i = 1; i < 500; i++) {
    store.state.sessions.push({
      id: `bench-${i}`,
      projectId: store.state.projects[i % 30].id,
      title: `${500 - i} 性能会话`,
      updatedAt: stamp - i * 10,
      draft: '',
      attachments: [],
      lastStatus: 'idle',
    });
  }
  await store.save();
  const baselineDataDir = path.join(bench.dir, 'baseline-data');
  if (baselineRoot) await fs.cp(dataDir, baselineDataDir, { recursive: true });
  await open(dataDir);
  const projectLayout = () =>
    sidebar()
      .locator('.project-list')
      .evaluate((list) =>
        Array.from(list.children, (group) => ({
          type: group.className,
          text: group.textContent,
          sessions: Array.from(group.querySelectorAll('[data-session-id]'), (row) => row.dataset.sessionId),
        })),
      );
  const defaultLayout = await projectLayout();
  const timings = {};
  // 1. 在渲染进程内测量，排除 Playwright 往返和打开菜单耗时。
  for (const [menu, choice, key, first] of [
    ['分组', '时间', 'time:today', sessionId],
    ['分组', '不分组', 'none:all', sessionId],
    ['排序', '名称', 'none:all', 'bench-499'],
  ]) {
    await submenu(menu);
    timings[choice] = await item(choice, 'menuitemradio').evaluate(
      (button, { key, first }) =>
        new Promise((resolve, reject) => {
          const sidebar = document.querySelector('#project-sidebar');
          const started = performance.now();
          const observer = new MutationObserver(() => {
            const rows = sidebar.querySelectorAll(`[data-sidebar-group="${key}"] [data-session-id]`);
            if (rows.length !== 500 || rows[0].dataset.sessionId !== first) return;
            observer.disconnect();
            window.clearTimeout(timer);
            requestAnimationFrame(() => resolve(performance.now() - started));
          });
          const timer = window.setTimeout(() => {
            observer.disconnect();
            reject(new Error(`500 rows did not commit in ${key}`));
          }, 5000);
          observer.observe(sidebar, { childList: true, subtree: true });
          button.click();
        }),
      { key, first },
    );
  }
  await choose('分组', '状态');

  // 2. 与 test-performance-ui 同样计数，跳过 memo 复用的 Fiber。每段文字都等真实 UI 显示。
  async function streamRenders() {
    await page.addInitScript(() => {
      let previous = new WeakSet();
      globalThis.sidebarRenderCount = 0;
      globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
        supportsFiber: true,
        inject: () => 1,
        onCommitFiberUnmount() {},
        onCommitFiberRoot(_id, root) {
          const current = new WeakSet();
          function visit(fiber) {
            current.add(fiber);
            if (
              !previous.has(fiber) &&
              fiber.flags & 1 &&
              fiber.memoizedProps?.updateBadge &&
              (fiber.memoizedProps.activities || fiber.memoizedProps.sidebarActivities)
            )
              globalThis.sidebarRenderCount++;
            if (fiber.child) visit(fiber.child);
            if (fiber.sibling) visit(fiber.sibling);
          }
          visit(root.current);
          previous = current;
        },
      };
    });
    await page.reload();
    await input().waitFor();
    await check.poll(async () => (await invoke('bootstrap')).environment?.supported).toBe(true);
    const count = () => page.evaluate(() => globalThis.sidebarRenderCount);
    await check.poll(count).toBeGreaterThan(0);
    await input().fill('侧栏流式计数');
    await input().press('Enter');
    const request = await nextRequest();
    const thread = page.locator('.thread');
    provider.stream(request, '流式开始。');
    await check(thread).toContainText('流式开始。');
    const initial = await count();
    for (let i = 0; i < 12; i++) {
      const chunk = `第 ${i} 段。`;
      provider.stream(request, chunk);
      await check(thread).toContainText(chunk);
    }
    const renders = (await count()) - initial;
    provider.reply(request, '流式结束。');
    await check(thread).toContainText('流式结束。');
    await check(page.locator('.stop-button')).toHaveCount(0);
    return renders;
  }

  const currentRenders = await streamRenders();
  const result = { timings, currentRenders };
  if (baselineRoot) {
    await close();
    await open(baselineDataDir, baselineRoot);
    assert.deepEqual(await projectLayout(), defaultLayout, 'The default project list matches v0.14.84');
    result.baselineRenders = await streamRenders();
  }
  await fs.writeFile(path.join(output, 'performance.json'), JSON.stringify(result, null, 2));
  console.log('UI17 15 performance:', JSON.stringify(result));
  for (const [choice, elapsed] of Object.entries(timings))
    assert.ok(elapsed <= 100, `${choice} took ${elapsed.toFixed(1)} ms (limit 100 ms)`);
  assert.ok(
    currentRenders <= (result.baselineRenders ?? 0),
    'Token-only updates must not increase sidebar renders',
  );
}

try {
  fixture = await prepareRealPiFixture(provider.baseUrl, output);
  const { store, projectId, sessionId } = fixture;
  const project = store.project(projectId);
  const other = {
    ...project,
    id: randomUUID(),
    name: '带有很长很长名称的另一个验收项目',
    path: path.join(fixture.dir, 'other'),
  };
  await fs.mkdir(other.path);
  store.state.projects.push(other);
  Object.assign(store.session(sessionId), {
    title: '侧栏审批会话',
    approvalMode: 'confirm',
    teamEnabled: true,
  });
  const now = new Date();
  now.setHours(23, 55, 0, 0);
  const day = (offset, hour = 23) =>
    new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset, hour).getTime();
  const seed = (title, updatedAt = +now, fields = {}) => {
    const session = {
      id: randomUUID(),
      title,
      updatedAt,
      draft: '',
      attachments: [],
      lastStatus: 'idle',
      ...fields,
    };
    store.state.sessions.push(session);
    return session.id;
  };
  const dated = [
    ['time:today', '今日会话', +now],
    ['time:yesterday', '昨夜会话', day(1)],
    ['time:week', '三天前会话', day(3)],
    ['time:month', '二十天前会话', day(20)],
    ['time:older', '六十天前会话', day(60)],
  ].map(([key, title, updatedAt]) => [key, seed(title, updatedAt)]);
  const titles = new Map(
    ['任务 10', 'b', '阿里', 'A', '任务 2', '1 号'].map((title) => [title, seed(title)]),
  );
  const projectPin = seed('项目置顶', +now, { projectId, pinned: true });
  const otherPin = seed('另一个项目置顶', +now, { projectId: other.id, pinned: true });
  const soloPin = seed('独立置顶', +now, { pinned: true });
  const unread = seed('未查看结果', +now, { unread: true, lastStatus: 'completed' });
  const legacy = seed('旧索引文件时间', +now, {
    projectId,
    file: await datedFile('旧索引文件时间', day(40)),
  });
  const importFile = await datedFile('导入文件时间', day(10));
  await store.save();
  // 直接写旧索引，确保损坏字段经过 Electron 启动读档，避免用 Store 预先修正夹具。
  const raw = await disk();
  raw.settings.sidebarView = { ...DEFAULT_SIDEBAR_VIEW, groupBy: 'foo', teamMembers: false };
  raw.sessions.find((session) => session.id === unread).sectionId = 'missing-section';
  delete raw.sessions.find((session) => session.id === legacy).createdAt;
  await fs.writeFile(indexFile(), JSON.stringify(raw));

  await open(fixture.dataDir);
  assert.deepEqual((await state()).settings.sidebarView, { ...DEFAULT_SIDEBAR_VIEW, teamMembers: false });
  assert.equal((await state()).sessions.find((session) => session.id === unread).sectionId, undefined);
  await check(trigger()).toHaveAttribute('aria-haspopup', 'menu');
  await trigger().press('Enter');
  await check(item(/^分组/)).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await check(item(/^排序/)).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowRight');
  await check(item('项目', 'menuitemradio')).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await check(item(/^分组/)).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Escape');
  await check(item(/^分组/)).toBeFocused();
  await page.keyboard.press('Escape');
  await check(trigger()).toBeFocused();
  await trigger().press('Enter');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await check(item(/^显示/)).toBeFocused();
  await page.keyboard.press('ArrowRight');
  const option = item('收起 7 天前的会话', 'menuitemcheckbox');
  await page.keyboard.press('ArrowDown');
  await check(option).toBeFocused();
  await page.keyboard.press('Enter');
  await check(option).toHaveAttribute('aria-checked', 'false');
  await check(option).toBeVisible();
  await page.keyboard.press('Escape');
  await check(item(/^显示/)).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowDown');
  await check(item('时间', 'menuitemradio')).toBeFocused();
  await page.clock.install({ time: now });
  await page.keyboard.press('Enter');
  await check(page.getByRole('menu')).toHaveCount(0);
  for (const [key, id] of dated) await inGroup(id, key);
  await submenu('显示');
  await check(option).toBeDisabled();
  await check(option).toHaveAttribute('title', '按时间分组时已按日期划分');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.clock.fastForward(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5) - now);
  await inGroup(dated[0][1], 'time:yesterday');
  await check(group('time:today')).toHaveCount(0);
  await page.clock.setSystemTime(Date.now());
  console.log('PASS UI17 2–3, 14: keyboard menus, local midnight, and repaired settings');

  await choose('分组', '不分组');
  const flat = group('none:all');
  await check(row(dated[4][1])).toBeVisible();
  await check(row(otherPin).locator('.sidebar-session-project')).toHaveText(other.name);
  await check(row(otherPin).locator('.sidebar-session-project')).toBeVisible();
  await check(row(otherPin).locator('button').first()).toHaveAttribute(
    'title',
    `另一个项目置顶 · ${other.name}`,
  );
  await check(row(soloPin).locator('.sidebar-session-project')).toHaveCount(0);
  await choose('排序', '名称');
  assert.deepEqual(
    (await rowIds(flat)).filter((id) => [...titles.values()].includes(id)),
    ['1 号', 'A', 'b', '阿里', '任务 2', '任务 10'].map((title) => titles.get(title)),
  );
  await dropTarget(projectId)
    .getByRole('button', { name: `在 ${project.name} 中新建会话` })
    .click();
  await check.poll(async () => (await state()).selectedSessionId).not.toBe(sessionId);
  const created = (await state()).selectedSessionId;
  assert.equal((await state()).sessions.find((session) => session.id === created).projectId, projectId);
  await inGroup(created, 'none:all');
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, importFile);
  await dropTarget(projectId)
    .getByRole('button', { name: `${project.name} 项目操作` })
    .click();
  await page.getByRole('button', { name: '导入 Pi 会话', exact: true }).click();
  await check
    .poll(async () => (await disk()).sessions.find((session) => session.file === importFile)?.createdAt)
    .toBe(day(10));
  const imported = (await disk()).sessions.find((session) => session.file === importFile).id;
  assert.equal((await sessionOnDisk(legacy)).createdAt, day(40));
  await choose('排序', '创建时间');
  const createdOrder = await rowIds(flat);
  assert.ok(
    createdOrder.indexOf(imported) >= 0 && createdOrder.indexOf(imported) < createdOrder.indexOf(legacy),
  );
  await drag(titles.get('A'), dropTarget(other.id));
  const confirmation = page.getByRole('dialog', { name: /^把「.+」移到「.+」？$/ });
  await confirmation.getByRole('button', { name: '取消', exact: true }).click();
  await check(confirmation).toBeHidden();
  assert.equal((await sessionOnDisk(titles.get('A'))).projectId, undefined);
  console.log(
    'PASS UI17 4, 6, 8: project actions, real import, title and creation order, old rows, and move confirmation',
  );

  const emptyText = '把会话拖到这里，或在会话菜单中选择“放入分区”';
  const section = await createSection('  Inbox  ');
  await check(group(section).getByText(emptyText)).toBeVisible();
  // 分区菜单和会话菜单一样可以全程用键盘操作。
  const sectionActions = group(section).getByRole('button', { name: 'Inbox 分区操作' });
  await sectionActions.click();
  await check(item(/重命名/)).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await check(item(/删除分区/)).toBeFocused();
  await page.keyboard.press('Escape');
  await check(item(/删除分区/)).toHaveCount(0);
  await check(sectionActions).toBeFocused();
  await sectionActions.click();
  await item(/重命名/).click();
  await check(await nameSection('重命名分区', 'Sorted')).toBeHidden();
  await trigger().click();
  await item('新建分区…').click();
  const duplicate = await nameSection('新建分区', 'sorted');
  await check(page.getByText('已有同名分区', { exact: true })).toBeVisible();
  await duplicate.getByRole('button', { name: '取消', exact: true }).click();

  await toggle('置顶单独一组');
  for (const id of [projectPin, otherPin, soloPin]) {
    await inGroup(id, 'pinned');
    await check(row(id)).toHaveCount(1);
  }
  await check(row(projectPin).locator('.sidebar-session-project')).toHaveText(project.name);
  const pivot = await createSection('X');
  await drag(projectPin, dropTarget(pivot), '放进分区');
  await check(page.getByText('已放进分区“X”，置顶期间显示在置顶组', { exact: true })).toBeVisible();
  await inGroup(projectPin, 'pinned');
  await check(group(pivot).getByText('1', { exact: true })).toBeVisible();
  await check(group(pivot).getByText('另有 1 个置顶会话显示在置顶组')).toBeVisible();
  await check(group(pivot).getByText(emptyText)).toHaveCount(0);
  await sessionMenu(projectPin);
  await item('取消置顶').click();
  await inGroup(projectPin, pivot);
  await check(group(pivot).getByText(/另有.+置顶会话/)).toHaveCount(0);
  await moveToSection(otherPin, 'X');
  await inGroup(otherPin, 'pinned');
  await check(group(pivot).getByText('另有 1 个置顶会话显示在置顶组')).toBeVisible();
  await sessionMenu(projectPin);
  await item('置顶').click();
  await toggle('置顶单独一组');
  await inGroup(projectPin, pivot);
  await check(group('pinned')).toHaveCount(0);
  await moveToSection(projectPin, 'Sorted');
  await moveToSection(unread, 'Sorted');
  assert.equal((await rowIds(group(section)))[0], projectPin);
  await sessionMenu(unread);
  await item('移出分区').click();
  await inGroup(unread, 'none:all');
  console.log('PASS UI17 7, 10–11: section naming, menu filing, and global pinned precedence');

  await choose('分组', '状态');
  await inGroup(unread, 'status:unread');
  await row(unread).locator('button').first().click();
  await check(row(unread).locator('.unread')).toHaveCount(0);
  await inGroup(unread, 'status:unread');
  await row(sessionId).locator('button').first().click();
  await inGroup(unread, 'status:other');

  // 真实 Pi 由本地服务卡住每一步，拖动前后核对连接记录，工具只写隔离项目。
  await app.evaluate(({ ipcMain, shell }) => {
    globalThis.sidebarTestCalls = [];
    const invoke = ipcMain._invokeHandlers.get('desktop:invoke');
    ipcMain.removeHandler('desktop:invoke');
    ipcMain.handle('desktop:invoke', (event, method, args) => {
      if (['connect', 'sessionMoveStatus', 'moveSession'].includes(method))
        globalThis.sidebarTestCalls.push(method);
      if (method === 'setSidebarView' && globalThis.failNextSidebarView) {
        globalThis.failNextSidebarView = false;
        return new Promise((_, reject) => {
          globalThis.rejectSidebarWrite = () => reject(new Error('UI17 测试写入失败'));
        });
      }
      return invoke(event, method, args);
    });
    shell.trashItem = async (file) => {
      globalThis.sidebarTestTrashed = file;
    };
  });
  const connection = async () => JSON.parse(await invoke('diagnostics')).sessionSwitch;
  const noCrossProjectCall = async () => {
    assert.deepEqual(await app.evaluate(() => globalThis.sidebarTestCalls), []);
    await check(confirmation).toBeHidden();
  };
  await input().fill('侧栏运行与审批验收');
  await input().press('Enter');
  const running = await nextRequest();
  await inGroup(sessionId, 'status:running');
  const before = await connection();
  assert.ok(Number.isInteger(before.pid) && before.pid > 0);
  await drag(sessionId, dropTarget(section), '放进分区');
  await inGroup(sessionId, section);
  await noCrossProjectCall();
  assert.deepEqual(await connection(), before);
  provider.reply(running, { name: 'write', args: { path: 'sidebar-approval.txt', content: 'approved\n' } });
  const approval = page.getByRole('region', { name: '等待批准：write', exact: true });
  await check(approval).toBeVisible();
  await drag(sessionId, dropTarget(projectId));
  await inGroup(sessionId, 'status:pending');
  await drag(sessionId, dropTarget(section), '放进分区');
  await inGroup(sessionId, section);
  await noCrossProjectCall();
  assert.deepEqual(await connection(), before);
  await approval.getByRole('button', { name: '允许', exact: true }).click();
  provider.reply(await nextRequest(), '侧栏审批后继续完成');
  await check(page.locator('.thread')).toContainText('侧栏审批后继续完成');
  await check.poll(async () => (await sessionOnDisk(sessionId)).lastStatus).toBe('completed');
  assert.equal(
    await fs.readFile(path.join(fixture.projectDir, 'sidebar-approval.txt'), 'utf8'),
    'approved\n',
  );

  await drag(sessionId, dropTarget(projectId));
  await inGroup(sessionId, 'status:other');
  await noCrossProjectCall();
  await input().fill('成员状态验收');
  await input().press('Enter');
  provider.reply(await nextRequest(), {
    name: 'desktop_team_dispatch',
    args: { members: [{ name: '侧栏执行成员', task: '写入成员验收文件' }] },
  });
  const memberWork = await nextRequest();
  const member = (await state()).sessions.find((session) => session.team?.leadId === sessionId);
  await inGroup(sessionId, 'status:running');
  await check(row(sessionId).locator('.spin')).toBeVisible();
  await check(row(member.id)).toHaveCount(0);
  await check(sidebar().locator('.team-sidebar-toggle')).toHaveCount(0);
  provider.reply(memberWork, { name: 'write', args: { path: 'sidebar-member.txt', content: 'member\n' } });
  await inGroup(sessionId, 'status:pending');
  await check(row(sessionId).getByText('待确认', { exact: true })).toBeVisible();
  await check(row(member.id)).toHaveCount(0);
  await invoke('selectSession', member.id);
  await inGroup(member.id, 'status:pending');
  await sessionMenu(member.id);
  await check(item('放入分区')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await check(approval).toBeVisible();
  await approval.getByRole('button', { name: '允许', exact: true }).click();
  provider.reply(await nextRequest(), '成员完成');
  provider.reply(await nextRequest(), '负责人完成');
  await inGroup(sessionId, 'status:unread');
  await row(sessionId).locator('button').first().click();
  await check(page.locator('.thread')).toContainText('负责人完成');
  await inGroup(sessionId, 'status:unread');
  console.log(
    'PASS UI17 5, 9–10: deferred unread, real Pi/member approvals, and uninterrupted section drags',
  );

  await row(projectPin).locator('button').first().click();
  await inGroup(sessionId, 'status:other');
  await input().fill('跨项目保留真实历史');
  await input().press('Enter');
  provider.reply(await nextRequest(), '原项目历史');
  await check.poll(async () => (await sessionOnDisk(projectPin)).lastStatus).toBe('completed');
  const saved = await sessionOnDisk(projectPin);
  assert.ok(saved.file && saved.createdAt && saved.sectionId);
  await drag(projectPin, dropTarget(other.id));
  await confirmation.getByRole('button', { name: '取消', exact: true }).click();
  await check(confirmation).toBeHidden();
  assert.equal((await sessionOnDisk(projectPin)).sectionId, saved.sectionId);
  await drag(projectPin, dropTarget(other.id));
  await confirmation.getByRole('button', { name: '移动', exact: true }).click();
  await inGroup(projectPin, 'status:other');
  const moved = await sessionOnDisk(projectPin);
  assert.equal(moved.projectId, other.id);
  assert.equal(moved.sectionId, undefined);
  assert.equal(moved.createdAt, saved.createdAt);
  assert.notEqual(moved.file, saved.file);
  const [header] = (await fs.readFile(moved.file, 'utf8')).split('\n');
  assert.equal(path.resolve(JSON.parse(header).cwd), path.resolve(other.path));
  await check.poll(() => app.evaluate(() => globalThis.sidebarTestTrashed)).toBe(saved.file);
  // 带分区走「移动到…」，仍使用 UI14 的预览并保留分区归属。
  await moveToSection(projectPin, 'Sorted');
  await inGroup(projectPin, section);
  await sessionMenu(projectPin);
  await item('移动到…').click();
  const moveDialog = page.getByRole('dialog', { name: '移动会话', exact: true });
  await moveDialog.getByRole('radio', { name: new RegExp(project.name) }).check();
  await moveDialog.getByRole('button', { name: '移动', exact: true }).click();
  await check(moveDialog).toBeHidden();
  await inGroup(projectPin, section);
  assert.equal((await sessionOnDisk(projectPin)).projectId, projectId);
  assert.equal((await sessionOnDisk(projectPin)).sectionId, saved.sectionId);

  await sessionMenu(unread);
  await item('放入分区').click();
  await item('新建分区…').click();
  await check(await nameSection('新建分区', '临时分区')).toBeHidden();
  const disposable = await sectionKey('临时分区');
  await inGroup(unread, disposable);
  await group(disposable).getByRole('button', { name: '临时分区 分区操作' }).click();
  await item('删除分区').click();
  await check(page.getByText('已删除分区“临时分区”，1 个会话回到原来的分组')).toBeVisible();
  await inGroup(unread, 'status:other');
  await check(group(disposable)).toHaveCount(0);

  await app.evaluate(() => {
    globalThis.failNextSidebarView = true;
  });
  await submenu('显示');
  await item('置顶单独一组', 'menuitemcheckbox').click();
  await item('收起 7 天前的会话', 'menuitemcheckbox').click();
  await check(item('置顶单独一组', 'menuitemcheckbox')).toHaveAttribute('aria-checked', 'true');
  await check(item('收起 7 天前的会话', 'menuitemcheckbox')).toHaveAttribute('aria-checked', 'true');
  await app.evaluate(() => globalThis.rejectSidebarWrite());
  await check(page.getByText(/没能保存侧栏显示方式/)).toBeVisible();
  await check(item('置顶单独一组', 'menuitemcheckbox')).toHaveAttribute('aria-checked', 'false');
  await check
    .poll(async () => (await disk()).settings.sidebarView)
    .toEqual({
      groupBy: 'status',
      sortBy: 'created',
      foldOlder: true,
      pinnedGroup: false,
      teamMembers: false,
    });
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await check(row(dated[4][1])).toHaveCount(0);
  await trigger().click();
  await item('全部展开').click();
  const collapsibles = sidebar().locator('[data-sidebar-group] :is(.project-row, .older-sessions-toggle)');
  await check(collapsibles).toHaveCount(4);
  await check(
    sidebar().locator('[data-sidebar-group] button[aria-expanded="false"]:not(.icon-button)'),
  ).toHaveCount(0);
  await check(row(dated[4][1])).toBeVisible();
  await trigger().click();
  await item('全部收起').click();
  await check(row(projectPin)).toHaveCount(0);
  await check(row(sessionId)).toHaveCount(0);
  await trigger().click();
  await item('全部展开').click();
  await inGroup(projectPin, section);
  await inGroup(sessionId, 'status:other');

  console.log('PASS UI17 10–14 before restart: moves, section deletion, collapse all, and save rollback');
  await close();
  await open(fixture.dataDir);
  await inGroup(projectPin, section);
  await inGroup(otherPin, pivot);
  await inGroup(unread, 'status:other');
  await check(trigger()).toHaveAttribute('title', '侧栏显示方式（已调整）');
  await check(trigger().locator('.sidebar-view-dot')).toBeVisible();
  await trigger().click();
  await item('恢复默认').click();
  await check(trigger().locator('.sidebar-view-dot')).toHaveCount(0);
  await check.poll(async () => (await disk()).settings.sidebarView).toEqual(DEFAULT_SIDEBAR_VIEW);
  await check(dropTarget('standalone')).toContainText('对话');
  await inGroup(projectPin, section);
  // 项目的会话都显示在分区里时，展开项目仍给出新建入口，而不是一片空白。
  assert.deepEqual(
    (await state()).sessions.filter((s) => s.projectId === other.id && !s.sectionId).map((s) => s.title),
    [],
  );
  const otherRow = dropTarget(other.id).locator('.project-row');
  if ((await otherRow.getAttribute('aria-expanded')) !== 'true') await otherRow.click();
  await check(dropTarget(other.id).getByRole('button', { name: '新建项目会话' })).toBeVisible();
  await trigger().click();
  await check(item('恢复默认')).toBeDisabled();
  await page.keyboard.press('Escape');
  console.log('PASS UI17 10, 12: persistence across app restart, then restore defaults');

  await choose('分组', '不分组');
  for (const uiStyle of ['classic', 'codex', 'claude']) {
    for (const theme of ['light', 'dark']) {
      await invoke('saveSettings', { uiStyle, theme, sidebarWidth: 180 });
      await check(page.locator('html')).toHaveAttribute('data-style', uiStyle);
      await check(page.locator('html')).toHaveAttribute('data-theme', theme);
      await check.poll(async () => Math.round((await sidebar().boundingBox()).width)).toBe(180);
      await submenu('分组');
      const overflow = await page.evaluate(() => {
        const contains = (outer, inner, horizontalOnly) => {
          const a = outer.getBoundingClientRect();
          const b = inner.getBoundingClientRect();
          return (
            b.left >= a.left - 1 &&
            b.right <= a.right + 1 &&
            (horizontalOnly || (b.top >= a.top - 1 && b.bottom <= a.bottom + 1))
          );
        };
        const side = document.querySelector('#project-sidebar');
        const nodes = [
          [document.documentElement, '.sidebar-view-menu, .sidebar-submenu'],
          [
            side,
            '.sidebar-view-trigger, .sidebar-session-project, [data-sidebar-group^="section:"] .project-header',
            true,
          ],
          [side.querySelector('.sidebar-view-trigger'), '.sidebar-view-dot'],
        ];
        return nodes.flatMap(([parent, selector, horizontalOnly]) => {
          const matches = [...document.querySelectorAll(selector)];
          return matches.length && matches.every((node) => contains(parent, node, horizontalOnly))
            ? []
            : [selector];
        });
      });
      assert.deepEqual(overflow, [], `Overflow at 180 px in ${uiStyle}/${theme}`);
      // 标题优先于项目标签：标题被截断时，宽度不能比标签还窄。
      const squeezed = await page.evaluate(() =>
        [...document.querySelectorAll('#project-sidebar .sidebar-session-project')].flatMap((tag) => {
          const title = tag.previousElementSibling;
          return title.scrollWidth > title.clientWidth && title.clientWidth < tag.clientWidth
            ? [title.textContent]
            : [];
        }),
      );
      assert.deepEqual(squeezed, [], `Titles squeezed by project names at 180 px in ${uiStyle}/${theme}`);
      // 180 px 时只留标题，项目名仍在悬停提示里。
      await check(row(otherPin).locator('.sidebar-session-project')).toBeHidden();
      await page.screenshot({ path: path.join(output, `${uiStyle}-${theme}.png`), animations: 'disabled' });
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
    }
  }
  console.log('PASS UI17 16: 180 px sidebar in all six appearances');
  await close();
  await measureSidebar();
  assert.deepEqual(errors, []);
  await close();
  console.log(`PASS UI17 sidebar view (artifacts: ${output})`);
} catch (error) {
  console.error(`UI17 failure (artifacts: ${output})\n${error.stack}`);
  if (page && !page.isClosed())
    await page
      .screenshot({ path: path.join(output, 'failure.png'), timeout: 5000, animations: 'disabled' })
      .catch(() => {});
  process.exitCode = 1;
} finally {
  try {
    await close();
  } finally {
    await provider.close();
  }
}
