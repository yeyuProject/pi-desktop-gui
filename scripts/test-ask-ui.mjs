import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { expect } from 'playwright/test';
import { launchApp, closeApp } from '../tests/support/desktop-app.mjs';
import { prepareRealPiFixture } from '../tests/support/local-provider.ts';
import { createAskProvider, singleQuestion, multipleQuestions } from '../tests/support/ask-provider.ts';

const provider = await createAskProvider();
const fixture = await prepareRealPiFixture(provider.baseUrl, path.join(os.tmpdir(), 'pi-desktop-ask-ui'));
const id = fixture.sessionId;
fixture.store.session(id).title = '选择本地项目的数据库';
fixture.store.session(id).approvalMode = 'readonly';
fixture.store.state.settings.notifyOnApproval = true;
await fixture.store.save();
const output = path.resolve('test-results');
await fs.mkdir(output, { recursive: true });
let app, page, clipboardBefore;
const errors = [];
const invoke = (method, ...args) =>
  page.evaluate(({ method, args }) => window.desktop.invoke(method, ...args), { method, args });
const snapshot = () => invoke('bootstrap');
const ready = () => expect.poll(() => provider.waiting, { timeout: 30000 }).toBe(1);
const idle = () =>
  expect
    .poll(async () => (await snapshot()).runtime.status, { timeout: 30000 })
    .toMatch(/^(idle|completed|stopped)$/);
const panel = () => page.getByRole('region', { name: 'Pi 需要你决定', exact: true });
const input = () => page.getByRole('textbox', { name: '任务输入' });
const start = async (request, text = '请先确定方案，再继续当前任务') => {
  provider.respond({ tool: 'desktop_ask_user', args: request });
  await invoke('send', id, text, [], 'steer');
  await expect(panel()).toBeVisible();
};
const finish = async () => {
  await ready();
  provider.respond('已收到回答，继续完成原任务。');
  await idle();
  await expect(panel()).toHaveCount(0);
};
const lastAsk = async () =>
  (await snapshot()).runtime.messages.findLast((message) => message.toolName === 'desktop_ask_user')?.details;
const setDraft = async (text, attachments = [], images = [], snippets = [], quotes = []) => {
  await invoke('saveDraft', id, text, attachments, images, snippets, quotes);
  // Saving an injected fixture must not overwrite a live editor. Reload to read the saved draft.
  await page.reload();
  await expect(input()).toHaveValue(text);
};
const appearance = async (style, theme = 'light') => {
  await invoke('saveSettings', { uiStyle: style, theme });
  await page.waitForFunction(
    ({ style, theme }) =>
      document.documentElement.dataset.style === style && document.documentElement.dataset.theme === theme,
    { style, theme },
  );
};
const screenshot = (name) => page.screenshot({ path: path.join(output, name) });
try {
  ({ app, page } = await launchApp({
    dataDir: fixture.dataDir,
    executablePath: process.env.PI_DESKTOP_EXE,
    errors,
  }));
  await input().waitFor();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 960));
  await page.bringToFront();
  clipboardBefore = await app.evaluate(({ clipboard }) => clipboard.readText());
  await app.evaluate(({ clipboard }) => {
    globalThis.askCopyWrites = [];
    const write = clipboard.writeText.bind(clipboard);
    clipboard.writeText = async (value) => {
      await write(value);
      globalThis.askCopyWrites.push({ question: value.includes('数据库'), answer: value.includes('SQLite') });
    };
  });
  const notificationsSupported = await app.evaluate(({ Notification }) => {
    globalThis.askNotifications = [];
    Notification.prototype.show = function () {
      globalThis.askNotifications.push({ title: this.title, body: this.body });
    };
    return Notification.isSupported();
  });

  provider.respond({
    tool: 'desktop_plan',
    args: { steps: [{ text: '确定数据库并继续实现', status: 'in_progress' }] },
  });
  await invoke('send', id, '先列出计划，再确定数据库', [], 'steer');
  await ready();
  await expect(page.getByRole('region', { name: '任务计划', exact: true })).toBeVisible();
  const plan = (await snapshot()).runtime.plan;
  await input().fill('保留我写到一半的消息');
  provider.respond({ tool: 'desktop_ask_user', args: singleQuestion });
  await expect(panel()).toBeVisible();
  await expect(input()).toBeFocused();
  await expect(input()).toHaveAttribute('placeholder', '也可以直接输入回答…');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('region', { name: '任务计划', exact: true })).toHaveCount(0);
  await expect(panel().getByRole('radio', { name: /SQLite/ })).not.toBeChecked();
  await expect(panel().getByRole('button', { name: '提交回答' })).toBeDisabled();
  const userCount = (await snapshot()).runtime.messages.filter((message) => message.role === 'user').length;
  await screenshot('ask-single-classic.png');
  await panel()
    .getByRole('radio', { name: /SQLite/ })
    .click();
  await finish();
  assert.equal(
    (await snapshot()).runtime.messages.filter((message) => message.role === 'user').length,
    userCount,
  );
  assert.deepEqual((await snapshot()).runtime.plan, plan);
  await expect(input()).toHaveValue('保留我写到一半的消息');
  await expect(page.locator('.ask-card').last()).toContainText('数据库：SQLite');
  await page.getByRole('button', { name: '复制问答' }).last().click();
  // Native clipboard round-trips remain covered by the existing chat/theme suites.
  await expect
    .poll(() => app.evaluate(() => globalThis.askCopyWrites))
    .toEqual([{ question: true, answer: true }]);
  await setDraft('');
  console.log('PASS non-modal question, typing focus, single-click answer, same turn and plan, history copy');

  await start(multipleQuestions, '同时确认数据库与验证方式');
  let first = panel().locator('fieldset').nth(0);
  let second = panel().locator('fieldset').nth(1);
  await first.getByRole('radio', { name: /SQLite/ }).focus();
  await page.keyboard.press('ArrowDown');
  await expect(first.getByRole('radio', { name: /PostgreSQL/ })).toBeFocused();
  await expect(first.getByRole('radio', { name: /PostgreSQL/ })).not.toBeChecked();
  await page.keyboard.press('2');
  await expect(first.getByRole('radio', { name: /PostgreSQL/ })).toBeChecked();
  await expect(panel()).toBeVisible();
  await expect(panel().getByRole('button', { name: '提交回答' })).toBeDisabled();
  await page.keyboard.press('Tab');
  await expect(second.getByRole('checkbox', { name: /单元测试/ })).toBeFocused();
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Space');
  await expect(second.getByRole('checkbox', { name: /单元测试/ })).toBeChecked();
  await expect(second.getByRole('checkbox', { name: /界面测试/ })).toBeChecked();
  await second.getByRole('checkbox', { name: '其他…', exact: true }).click();
  await panel().getByRole('textbox', { name: '验证方式：其他回答' }).fill('运行一次数据迁移');
  await panel().getByRole('button', { name: '添加说明' }).click();
  await panel().getByRole('textbox', { name: '补充说明' }).fill('仍需保留离线能力');
  const otherSession = await invoke('newSession', fixture.projectId);
  await expect(panel()).toHaveCount(0);
  await invoke('selectSession', id);
  await expect(panel()).toBeVisible();
  second = panel().locator('fieldset').nth(1);
  await expect(second.getByRole('checkbox', { name: /单元测试/ })).toBeChecked();
  await expect(second.getByRole('checkbox', { name: /界面测试/ })).toBeChecked();
  await expect(panel().getByRole('textbox', { name: '补充说明' })).toHaveValue('仍需保留离线能力');
  await expect(panel().getByRole('textbox', { name: '验证方式：其他回答' })).toHaveValue('运行一次数据迁移');
  await panel().getByRole('textbox', { name: '验证方式：其他回答' }).focus();
  await page.keyboard.press('Escape');
  await expect(panel().getByRole('textbox', { name: '验证方式：其他回答' })).toHaveCount(0);
  await expect(second.getByRole('checkbox', { name: /单元测试/ })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: '跳过这些问题？' })).toBeVisible();
  assert.equal((await snapshot()).runtime.status, 'waiting');
  await page.getByRole('button', { name: '继续回答' }).click();
  await panel().getByRole('button', { name: '提交回答' }).focus();
  await screenshot('ask-multi-classic.png');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
  await finish();
  assert.deepEqual((await lastAsk()).answers.checks, {
    selected: ['单元测试', '界面测试'],
    other: '运行一次数据迁移',
  });
  assert.equal((await lastAsk()).note, '仍需保留离线能力');
  console.log('PASS keyboard choices, multi-select, other/note, session draft restoration and scoped Escape');

  await start(multipleQuestions, '允许从输入框回答');
  const images = [
    {
      id: 'ask-test-image',
      name: 'pixel.png',
      mimeType: 'image/png',
      data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=',
    },
  ];
  const snippets = [{ id: 'ask-test-snippet', text: '保留的片段', offset: 0 }];
  const quotes = [
    {
      id: 'ask-test-quote',
      text: '保留的引用',
      role: 'assistant',
      turn: 1,
      messageTimestamp: 1,
      section: 'text',
    },
  ];
  for (const material of [{ attachments: ['输入 文件.txt'] }, { images }, { snippets }, { quotes }]) {
    const text = '这次先回答 ' + Object.keys(material)[0];
    await setDraft(
      text,
      material.attachments ?? [],
      material.images ?? [],
      material.snippets ?? [],
      material.quotes ?? [],
    );
    await page.getByRole('button', { name: '发送回答', exact: true }).click();
    await expect(
      page.getByText('回答问题时只能发送文字，附件请在问题回答后再发送。', { exact: true }),
    ).toBeVisible();
    await expect(panel()).toBeVisible();
    await expect(input()).toHaveValue(text);
  }
  await setDraft('');
  await input().fill('采用内存数据库，不需要额外服务');
  const beforeText = (await snapshot()).runtime.messages.filter((message) => message.role === 'user').length;
  await page.getByRole('button', { name: '发送回答', exact: true }).click();
  await finish();
  assert.equal(
    (await snapshot()).runtime.messages.filter((message) => message.role === 'user').length,
    beforeText,
  );
  assert.deepEqual((await lastAsk()).answers, {
    database: { selected: [], other: '采用内存数据库，不需要额外服务' },
  });
  await expect(input()).toHaveValue('');
  await expect(page.locator('.ask-card').last()).toContainText('验证方式：已跳过');
  console.log(
    'PASS composer answer, skipped remaining questions, and attachment/image/snippet/quote rejection without losing drafts',
  );
  for (const text of ['/goal', '@输入']) {
    await start(singleQuestion, '请用输入框直接回答');
    await input().fill(text);
    await expect(page.getByRole('listbox', { name: 'Pi 命令' })).toHaveCount(0);
    await expect(page.locator('.file-picker')).toHaveCount(0);
    await input().press('Enter');
    await finish();
    assert.deepEqual((await lastAsk()).answers, { database: { selected: [], other: text } });
  }
  console.log('PASS slash commands and @ text stay literal while answering');

  await start(singleQuestion, '可以跳过这次提问');
  await panel().getByRole('button', { name: '跳过', exact: true }).click();
  await page.getByRole('button', { name: '跳过问题', exact: true }).click();
  await finish();
  assert.equal((await lastAsk()).status, 'skipped');
  await start(singleQuestion, '停止等待中的问题');
  await input().focus();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await idle();
  await expect(panel()).toHaveCount(0);
  assert.equal((await lastAsk()).status, 'cancelled');
  await expect(page.locator('.ask-card').last()).toContainText('已取消');
  console.log('PASS skip confirmation and double Escape outside panel stops and cancels');

  if (notificationsSupported) {
    await invoke('selectSession', otherSession.id);
    provider.respond({ tool: 'desktop_ask_user', args: singleQuestion });
    await invoke('send', id, '后台会话需要确认', [], 'steer');
    await expect
      .poll(() => app.evaluate(() => globalThis.askNotifications))
      .toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            title: 'Pi 需要你决定 · 选择本地项目的数据库',
            body: expect.stringContaining('数据库：本地项目应使用哪种数据库'),
          }),
        ]),
      );
    await invoke('selectSession', id);
    await expect(panel()).toBeVisible();
    await panel()
      .getByRole('radio', { name: /SQLite/ })
      .click();
    await finish();
    console.log('PASS background-session notification title and question summary');
    const notificationCount = await app.evaluate(() => globalThis.askNotifications.length);
    await invoke('saveSettings', { notifyOnApproval: false });
    await invoke('selectSession', otherSession.id);
    provider.respond({ tool: 'desktop_ask_user', args: singleQuestion });
    await invoke('send', id, '关闭系统通知后继续提问', [], 'steer');
    await expect
      .poll(async () => (await snapshot()).state.sessions.find((session) => session.id === id).lastStatus)
      .toBe('waiting');
    assert.equal(await app.evaluate(() => globalThis.askNotifications.length), notificationCount);
    await invoke('selectSession', id);
    await panel()
      .getByRole('radio', { name: /SQLite/ })
      .click();
    await finish();
    await invoke('saveSettings', { notifyOnApproval: true });
  }

  for (const style of ['classic', 'codex', 'claude']) {
    await appearance(style);
    await page.getByRole('region', { name: '对话内容', exact: true }).evaluate((element) => {
      element.scrollTop = 0;
      element.dispatchEvent(new Event('scroll'));
    });
    await start(singleQuestion, '为本地历史记录选择数据库，并继续实现');
    const latest = page.getByRole('button', { name: '回到最新', exact: true });
    await expect(latest).toBeVisible();
    await expect
      .poll(async () => {
        const button = await latest.boundingBox(),
          question = await panel().boundingBox();
        return button.y + button.height <= question.y;
      })
      .toBe(true);
    await latest.click();
    await expect(latest).toHaveCount(0);
    await screenshot(`ask-single-${style}.png`);
    if (style === 'classic')
      await page.screenshot({ path: path.resolve('docs/assets/screenshots/ask-panel.png') });
    await panel()
      .getByRole('radio', { name: /SQLite/ })
      .click();
    await finish();
    await start(multipleQuestions, '确认数据库方案和验证范围，再继续实现');
    for (const theme of ['light', 'dark']) {
      await appearance(style, theme);
      await expect(panel().getByRole('button', { name: '提交回答' })).toBeVisible();
      const bounds = await panel().evaluate((element) => ({
        panel: element.getBoundingClientRect().height,
        area: element.closest('.conversation').getBoundingClientRect().height,
        overflow: element.scrollWidth > element.clientWidth + 1,
      }));
      assert.ok(bounds.panel <= bounds.area / 2 + 1);
      assert.equal(bounds.overflow, false);
      await screenshot(`ask-multi-${style}${theme === 'light' ? '' : '-dark'}.png`);
    }
    await panel()
      .locator('fieldset')
      .nth(0)
      .getByRole('radio', { name: /SQLite/ })
      .click();
    await panel()
      .locator('fieldset')
      .nth(1)
      .getByRole('checkbox', { name: /单元测试/ })
      .click();
    await panel().getByRole('button', { name: '提交回答' }).click();
    await finish();
    await page.locator('.ask-card').last().locator('summary').click();
    await screenshot(`ask-history-${style}.png`);
  }
  await appearance('classic');
  await invoke('selectSession', otherSession.id);
  await invoke('selectSession', id);
  await expect(page.locator('.ask-card')).not.toHaveCount(0);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+f' : 'Control+f');
  const find = page.getByRole('textbox', { name: '查找当前会话' });
  await find.fill('仍需保留离线能力');
  await expect(page.locator('.ask-card').filter({ hasText: '仍需保留离线能力' })).toBeVisible();
  await expect(page.locator('.ask-card mark').filter({ hasText: '仍需保留离线能力' })).not.toHaveCount(0);
  await find.fill('本地项目应使用哪种数据库');
  await expect(page.locator('.ask-card mark').first()).toBeVisible();
  await page.keyboard.press('Escape');
  provider.respond({ tool: 'desktop_ask_user', args: singleQuestion });
  await invoke('send', id, '/goal 确定方案后继续实现本地历史记录', [], 'steer');
  await expect(panel()).toBeVisible();
  await expect(panel()).toContainText(/\d+:\d{2} 后按推荐继续/);
  const goalCard = page.locator('.goal-card').first();
  await expect(goalCard).toBeVisible();
  assert.ok((await goalCard.boundingBox()).y < (await panel().boundingBox()).y);
  await screenshot('ask-goal.png');
  const revision = (await snapshot()).runtime.goal.revision;
  await goalCard.getByRole('button', { name: '编辑目标', exact: true }).first().click();
  await input().fill('明确数据库方案后继续实现离线历史记录');
  await page.getByRole('button', { name: '保存修改', exact: true }).click();
  await expect.poll(async () => (await snapshot()).runtime.goal.revision).toBe(revision + 1);
  await expect(panel()).toBeVisible();
  assert.equal(provider.waiting, 0, 'editing a Goal must not answer its pending question');
  await panel()
    .getByRole('radio', { name: /SQLite/ })
    .click();
  await ready();
  assert.equal((await snapshot()).runtime.goal.status, 'active');
  await invoke('stop', id);
  await idle();
  console.log('PASS active Goal stays above questions, shows timeout countdown and continues after answer');
  const longQuestions = {
    questions: Array.from({ length: 3 }, (_, index) => ({
      id: `long-${index}`,
      header: `问题 ${index + 1}`,
      question: '请核对以下要求与配置路径。'.repeat(100),
      options: Array.from({ length: 6 }, (_, option) => ({
        label: `方案 ${option + 1}：${'详细选项'.repeat(10)}`,
        description: '说明文字需要在较窄窗口中完整换行。'.repeat(8),
        recommended: option === 0,
      })),
    })),
  };
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setSize(1000, 800);
    window.webContents.setZoomFactor(1.5);
  });
  await start(longQuestions, '验证长问题与窄窗口');
  const layout = await panel().evaluate((element) => {
    const box = element.getBoundingClientRect(),
      area = element.closest('.conversation').getBoundingClientRect();
    const footer = element.querySelector('.ask-footer').getBoundingClientRect();
    const questions = element.querySelector('.ask-questions');
    return {
      panelHeight: box.height,
      areaHeight: area.height,
      footerBottom: footer.bottom,
      panelBottom: box.bottom,
      horizontalOverflow: element.scrollWidth > element.clientWidth + 1,
      scrolls: questions.scrollHeight > questions.clientHeight,
    };
  });
  assert.ok(layout.panelHeight <= layout.areaHeight / 2 + 1);
  assert.ok(layout.footerBottom <= layout.panelBottom + 1);
  assert.equal(layout.horizontalOverflow, false);
  assert.equal(layout.scrolls, true);
  for (let index = 0; index < 3; index++)
    await panel().locator('fieldset').nth(index).getByRole('radio').first().click();
  await panel().getByRole('button', { name: '提交回答' }).click();
  await finish();
  console.log(
    'PASS three long questions, internal scroll, visible submit action, narrow window and 150% zoom',
  );
  assert.deepEqual(errors, []);
  console.log(
    'PASS classic/Codex/Claude light and dark appearance, panel height, history navigation position, restored cards and question/answer search',
  );
} catch (error) {
  if (page && !page.isClosed())
    await page.screenshot({ path: path.join(output, 'ask-failure.png') }).catch(() => {});
  throw error;
} finally {
  if (app && clipboardBefore !== undefined)
    await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), clipboardBefore).catch(() => {});
  if (page && !page.isClosed()) await invoke('stop', id).catch(() => {});
  await closeApp(app);
  await provider.close();
}
