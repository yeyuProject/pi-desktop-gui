import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { expect } from 'playwright/test';

export async function verifyQuoteSideChatUI({ app, page, fixture, provider, output }) {
  const session = await page.evaluate(() => window.desktop.invoke('newSession'));
  const input = page.getByRole('textbox', { name: '任务输入' });
  await expect(
    page.locator(`.session-row[data-session-id="${session.id}"] > button`).first(),
  ).toHaveAttribute('aria-current', 'page');
  const snapshot = () => page.evaluate(() => window.desktop.invoke('bootstrap'));
  const finish = () =>
    expect.poll(async () => (await snapshot()).runtime.status, { timeout: 30000 }).toBe('completed');
  for (const question of ['引用测试的第一问', '引用测试的第二问']) {
    await input.fill(question);
    await page.getByRole('button', { name: '发送任务', exact: true }).click();
    await finish();
  }
  const selectText = async (locator) => {
    await locator.scrollIntoViewIfNeeded();
    await page.locator('.thread').focus();
    return locator.evaluate(async (element) => {
      const started = performance.now();
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
      while (!document.querySelector('[aria-label="对话选区操作"]') && performance.now() - started < 500)
        await new Promise(requestAnimationFrame);
      return performance.now() - started;
    });
  };
  const replies = page.locator('.message.assistant .message-content > p');
  await input.fill('已有草稿');
  const menuLatencyMs = await selectText(replies.first());
  assert.ok(menuLatencyMs < 100, `selection menu took ${menuLatencyMs}ms`);
  const menu = page.getByRole('toolbar', { name: '对话选区操作' });
  await menu.getByRole('button', { name: '引用', exact: true }).click();
  await expect(page.locator('.draft-quotes > span')).toHaveCount(1);
  await expect(input).toHaveValue('已有草稿');
  await selectText(replies.first());
  await page.keyboard.press(process.platform === 'darwin' ? "Meta+'" : "Control+'");
  await expect(page.locator('.draft-quotes > span')).toHaveCount(1);
  await selectText(replies.nth(1));
  await menu.getByRole('button', { name: '引用', exact: true }).click();
  await expect(page.locator('.draft-quotes > span')).toHaveCount(2);
  await page.evaluate(() => window.desktop.invoke('flushDraft'));
  await page.reload();
  await input.waitFor();
  await expect(page.locator('.draft-quotes > span')).toHaveCount(2);
  await expect(input).toHaveValue('已有草稿');
  await input.fill('这两处冲突吗');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await finish();
  const sent = provider.requests.at(-1).messages.findLast((message) => message.role === 'user').content;
  const sentText = typeof sent === 'string' ? sent : sent.map((block) => block.text ?? '').join('');
  assert.match(sentText, /^> \[引用 第 1 轮 Pi 回复\]/);
  assert.match(sentText, /引用 第 2 轮 Pi 回复/);
  assert.ok(sentText.endsWith('这两处冲突吗'));
  const quoted = page.locator('.message.user').last();
  await expect(quoted.locator('.message-quote')).toHaveCount(2);
  await expect(quoted.locator('.user-message-text')).toHaveText('这两处冲突吗');
  await quoted
    .getByRole('button', { name: /引用原文|第 1 轮 Pi 回复/ })
    .first()
    .click();
  await expect
    .poll(() => page.evaluate(() => [...(CSS.highlights.get('conversation-quote') ?? [])][0]?.toString()))
    .toBe('OK');
  await quoted.getByRole('button', { name: '编辑后重新发送', exact: true }).click();
  await expect(input).toHaveValue('这两处冲突吗');
  await expect(page.locator('.draft-quotes > span')).toHaveCount(2);
  await page.screenshot({ path: path.join(output, 'chat-ui-quoted-draft.png') });

  // A real tool runs while the independent model request streams.
  await input.fill('E2E_STOP 主任务继续执行工具');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect
    .poll(
      async () => (await snapshot()).runtime.tools.some((tool) => tool.output.includes('WAITING_FOR_STOP')),
      { timeout: 30000 },
    )
    .toBe(true);
  await input.fill('主会话保留草稿');
  const before = await snapshot();
  const source = before.state.sessions.find((item) => item.id === session.id);
  const historyBefore = await fs.readFile(source.file, 'utf8');
  const mainCount = before.runtime.messages.length;
  const mainTokens = before.runtime.stats?.tokens;
  const requestsBefore = provider.requests.length;
  await page
    .locator('.message.assistant')
    .first()
    .getByRole('button', { name: '侧边提问', exact: true })
    .click();
  const panel = page.getByRole('complementary', { name: '侧边对话' });
  await expect(panel).toBeVisible();
  const resize = page.getByRole('separator', { name: '侧边对话宽度' });
  const sideWidth = (before.state.settings.sideChatWidth ?? 360) + 10;
  await resize.press('ArrowLeft');
  await expect.poll(async () => (await snapshot()).state.settings.sideChatWidth).toBe(sideWidth);
  assert.equal((await snapshot()).state.settings.inspectorWidth, before.state.settings.inspectorWidth);
  await expect(panel.getByRole('combobox', { name: '侧边上下文范围' })).toHaveValue('reply');
  const question = panel.getByRole('textbox', { name: '侧边问题' });
  await question.fill('E2E_USAGE_SIDE 为什么这样处理');
  await page.evaluate(() => {
    window.sideFirstDeltaMs = undefined;
    let started;
    window.stopSideTiming = window.desktop.onEvent((event) => {
      if (event.type === 'sideChat' && event.chat.running && started === undefined)
        started = performance.now();
      if (event.type === 'sideChatDelta' && started !== undefined && window.sideFirstDeltaMs === undefined)
        window.sideFirstDeltaMs = performance.now() - started;
    });
  });
  await panel.getByRole('button', { name: '发送侧边问题', exact: true }).click();
  await expect(panel.locator('.side-message.assistant').last()).toContainText('侧边回答');
  const firstDeltaMs = await page.evaluate(() => {
    window.stopSideTiming();
    return window.sideFirstDeltaMs;
  });
  assert.ok(firstDeltaMs < 3000, `side chat first delta took ${firstDeltaMs}ms`);
  await panel.getByRole('button', { name: '引用到主输入框', exact: true }).last().waitFor();
  const sideRequest = provider.requests.at(-1);
  assert.equal(provider.requests.length, requestsBefore + 1);
  assert.equal(sideRequest.tools?.length ?? 0, 0);
  const requestText = (message) =>
    typeof message.content === 'string'
      ? message.content
      : (message.content ?? []).map((block) => block.text ?? '').join('');
  assert.ok(
    sideRequest.messages.some((message) => message.role === 'assistant' && requestText(message) === 'OK'),
    'reply scope must send the selected main reply in the actual provider request',
  );
  assert.ok(
    sideRequest.messages.some(
      (message) => message.role === 'user' && requestText(message).includes('引用测试的第一问'),
    ),
  );
  assert.ok(
    !sideRequest.messages.some(
      (message) => message.role === 'user' && requestText(message).includes('引用测试的第二问'),
    ),
  );
  const after = await snapshot();
  assert.equal(after.runtime.messages.length, mainCount);
  assert.equal(after.runtime.stats?.tokens, mainTokens);
  assert.ok(['running', 'waiting'].includes(after.runtime.status));
  assert.equal(
    await fs.readFile(source.file, 'utf8'),
    historyBefore,
    'side requests cannot append main Pi session entries',
  );
  assert.equal(after.state.sessions.find((item) => item.id === session.id).sideUsage.tokens, 120);
  await panel.getByRole('button', { name: '引用到主输入框', exact: true }).last().click();
  await expect(input).toHaveValue('主会话保留草稿');
  await expect(page.locator('.draft-quotes')).toContainText('侧边对话');
  await question.fill('E2E_SIDE_HOLD 仅停止侧边回答');
  await panel.getByRole('button', { name: '发送侧边问题', exact: true }).click();
  await expect(panel.locator('.side-message.assistant').last()).toContainText('开始流式回复');
  const stopping = Date.now();
  await panel.getByRole('button', { name: '停止侧边回答', exact: true }).click();
  await expect(panel.locator('.side-message.assistant').last()).toContainText('已停止');
  assert.ok(Date.now() - stopping < 1000, 'side request abort should finish within a second');
  assert.ok(['running', 'waiting'].includes((await snapshot()).runtime.status));
  await question.focus();
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  assert.ok(['running', 'waiting'].includes((await snapshot()).runtime.status));
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+l' : 'Control+l');
  await expect(panel.locator('.side-message')).toHaveCount(4);
  await page.evaluate((id) => window.desktop.invoke('stop', id), session.id);
  await expect.poll(async () => (await snapshot()).runtime.status).toBe('stopped');
  const saved = await page.evaluate((id) => window.desktop.invoke('sideChatRead', id), session.id);
  assert.equal(saved.messages.length, 4);
  assert.equal(saved.messages.at(-1).aborted, true);
  await page.screenshot({ path: path.join(output, 'chat-ui-side-chat.png') });
  await panel.getByRole('button', { name: '关闭侧边对话' }).click();
  await page.reload();
  await input.waitFor();
  await expect(page.locator('.draft-quotes')).toContainText('侧边对话');
  await page.getByRole('button', { name: '侧边对话', exact: true }).click();
  await expect(panel.locator('.side-message')).toHaveCount(4);
  await expect(resize).toHaveAttribute('aria-valuenow', String(sideWidth));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(840, 900));
  const drawer = page.getByRole('dialog', { name: '侧边对话' });
  await expect(drawer).toHaveClass(/drawer/);
  await drawer.getByRole('textbox', { name: '侧边问题' }).focus();
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 1100));
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+l' : 'Control+l');
  await expect(panel.locator('.side-message')).toHaveCount(4);
  const summary = await page.evaluate(() => window.desktop.invoke('usageSummary'));
  assert.ok(summary.all.sideChat.tokens >= 120);
  const count = provider.requests.length;
  await panel.getByRole('button', { name: '作为新会话继续', exact: true }).first().click();
  await expect.poll(() => input.inputValue()).toMatch(/原问题：[\s\S]*侧边回答/);
  assert.equal(provider.requests.length, count, 'continuing in a new chat must only prepare a draft');
  const continued = (await snapshot()).state.selectedSessionId;
  assert.notEqual(continued, session.id);
  assert.equal(
    (await snapshot()).state.sessions.find((item) => item.id === continued).projectId,
    source.projectId,
  );
  await page.getByRole('button', { name: '侧边对话', exact: true }).click();
  await expect(panel.getByRole('textbox', { name: '侧边问题' })).toBeDisabled();
  await expect(panel).toContainText('请先连接主会话');
  await expect(panel.locator('.side-message')).toHaveCount(0);
  await panel.getByRole('button', { name: '连接主会话', exact: true }).click();
  await expect(panel.getByRole('textbox', { name: '侧边问题' })).toBeEnabled();
  await panel.getByRole('textbox', { name: '侧边问题' }).fill('连接后继续侧边提问');
  await panel.getByRole('button', { name: '发送侧边问题', exact: true }).click();
  await expect(panel.locator('.side-message.assistant').last()).toContainText('OK');
  await panel.getByRole('button', { name: '引用到主输入框', exact: true }).waitFor();
  assert.equal((await snapshot()).runtime.messages.length, 0);
  await panel.getByRole('textbox', { name: '侧边问题' }).fill('E2E_SIDE_HOLD 仅侧边回答时退出');
  await panel.getByRole('button', { name: '发送侧边问题', exact: true }).click();
  await expect(panel.locator('.side-message.assistant').last()).toContainText('开始流式回复');
  await page.evaluate(() => {
    void window.desktop.invoke('quit');
  });
  const quit = page.getByRole('dialog', { name: '侧边对话正在回答，将被停止', exact: true });
  await expect(quit).toBeVisible();
  await quit.getByRole('button', { name: '留在窗口', exact: true }).click();
  await expect(panel.getByRole('button', { name: '停止侧边回答', exact: true })).toBeVisible();
  await page.evaluate((id) => {
    void window.desktop.invoke('deleteSession', id);
  }, continued);
  const remove = page.getByRole('dialog', { name: /删除会话/ });
  await expect(remove).toBeVisible({ timeout: 5000 });
  const aborted = JSON.parse(
    await fs.readFile(path.join(fixture.dataDir, 'side-chats', continued + '.json'), 'utf8'),
  );
  assert.equal(
    aborted.messages.at(-1).aborted,
    true,
    'side abort must finish before the delete confirmation opens',
  );
  await remove.getByRole('button', { name: '取消', exact: true }).click();
  await panel.getByRole('button', { name: '关闭侧边对话' }).click();
  await page.evaluate((id) => window.desktop.invoke('sideChatClear', id), session.id);
  await assert.rejects(fs.stat(path.join(fixture.dataDir, 'side-chats', session.id + '.json')), {
    code: 'ENOENT',
  });
  assert.ok(
    (await page.evaluate(() => window.desktop.invoke('usageSummary'))).all.sideChat.tokens >= 120,
    'clearing history cannot erase spent usage',
  );
  console.log(
    'PASS C1 quotes, source jumps, draft/edit recovery; C2 parallel streaming, isolated history, abort, usage and drawer',
  );
  return { menuLatencyMs, firstDeltaMs, mainCount, sideMessages: saved.messages.length, continued };
}
