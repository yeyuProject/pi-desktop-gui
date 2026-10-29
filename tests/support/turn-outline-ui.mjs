import { UI_STYLES, STYLE_META } from '../../shared/window-theme.ts';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { expect } from 'playwright/test';
import { emptyRuntime } from '../../shared/types.ts';

const imageData =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1S8AAAAASUVORK5CYII=';

function fixtureMessages() {
  const prompts = [
    '# 普通提问，没有文件修改',
    '只新增两行的修正',
    '<skill name="review" location="/fixture/SKILL.md">\nFollow the review instructions.\n</skill>\n\n# 检查变更\n\n> 重点关注边界',
    '<skill name="review" location="/fixture/SKILL.md">\nFollow the review instructions.\n</skill>',
    '读取失败的轮次',
    [{ type: 'image', mimeType: 'image/png', data: imageData }],
    '只删除一行的修正',
    '标题长度超过原来的三十六字限制，应该继续保留后面这些重要细节，而不是在显示之前就提前截断。',
    '模型失败的轮次',
    '多行提问\n\n  需要合并   连续空白',
    '- 最后一项检查前的提问',
    '正在运行状态的最后一轮',
  ];
  const messages = [];
  for (let index = 0; index < prompts.length; index++) {
    const timestamp = 1700000000000 + index * 100;
    messages.push({ role: 'user', content: prompts[index], timestamp });
    if (index === 1 || index === 6 || index === 4) {
      const failed = index === 4;
      const toolCallId = `outline-tool-${index}`;
      const toolName = failed ? 'read' : 'edit';
      messages.push({
        role: 'assistant',
        content: [{ type: 'toolCall', id: toolCallId, name: toolName, arguments: { path: 'fixture.txt' } }],
        timestamp: timestamp + 1,
      });
      messages.push({
        role: 'toolResult',
        toolCallId,
        toolName,
        content: failed ? 'File could not be read.' : 'Updated fixture.txt.',
        isError: failed,
        details: failed
          ? {}
          : { patch: index === 1 ? '@@ -1,0 +1,2 @@\n+first\n+second' : '@@ -1,1 +1,0 @@\n-removed' },
        timestamp: timestamp + 2,
      });
    }
    messages.push({
      role: 'assistant',
      content: `轮次 ${index + 1} 的本地展示数据。\n\n${'用于核对滚动位置和目录跳转。'.repeat(15)}`,
      timestamp: timestamp + 3,
      ...(index === 8 ? { stopReason: 'error', errorMessage: 'Local outline fixture failure.' } : {}),
    });
  }
  return messages;
}

/** Synthetic transcript through the existing Electron IPC boundary; no provider request. */
export async function verifyTurnOutlineUI({ app, page, output }) {
  const { state } = await page.evaluate(() => window.desktop.invoke('bootstrap'));
  const runtime = {
    ...emptyRuntime(),
    sessionId: state.selectedSessionId,
    connected: false,
    status: 'completed',
    messages: fixtureMessages(),
  };
  await app.evaluate(({ ipcMain, BrowserWindow }, runtime) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setSize(1440, 1100);
    globalThis.outlineUiRuntime = runtime;
    // A connected real Pi can publish after rendererReady; keep this fixture's transcript deterministic.
    const send = window.webContents.send.bind(window.webContents);
    window.webContents.send = (channel, event, ...args) => {
      const sessionId = event?.runtime?.sessionId ?? event?.patch?.sessionId;
      if (
        channel === 'desktop:event' &&
        ['runtime', 'runtimePatch'].includes(event?.type) &&
        sessionId === globalThis.outlineUiRuntime.sessionId
      )
        return send(channel, { type: 'runtime', runtime: globalThis.outlineUiRuntime });
      return send(channel, event, ...args);
    };
    const original = ipcMain._invokeHandlers.get('desktop:invoke');
    ipcMain.removeHandler('desktop:invoke');
    ipcMain.handle('desktop:invoke', async (event, method, args) => {
      if (method === 'readHistory') return globalThis.outlineUiRuntime.messages;
      const result = await original(event, method, args);
      return method === 'bootstrap' ? { ...result, runtime: globalThis.outlineUiRuntime } : result;
    });
  }, runtime);
  await page.reload();
  await page.bringToFront();
  await page.getByRole('textbox', { name: '任务输入' }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  const outline = page.getByRole('navigation', { name: '对话轮次' });
  const rows = outline.locator('button[data-outline-index]');
  const row = (turn) => outline.locator(`[data-turn-number="${turn}"]`);
  const thread = page.locator('.thread');
  const outside = async () => {
    const rect = await thread.boundingBox();
    await page.mouse.move(rect.x + 30, rect.y + 30);
  };
  const tickPositions = () =>
    rows.evaluateAll((elements) =>
      elements.map((element) => {
        const rect = element.querySelector('.turn-tick').getBoundingClientRect();
        return { turn: element.dataset.turnNumber, x: rect.x, y: rect.y, right: rect.right };
      }),
    );
  await expect(rows).toHaveCount(12);
  await outside();
  await expect(outline).not.toHaveClass(/expanded/);
  const tick = row(12).locator('.turn-tick');
  const target = await tick.boundingBox();
  const before = await tickPositions();
  await page.mouse.move(target.x + target.width / 2, target.y + 1);
  await outside();
  await page.waitForTimeout(150);
  await expect(outline).not.toHaveClass(/expanded/);
  await tick.hover();
  await expect(outline).toHaveClass(/expanded/);
  const after = await tickPositions();
  assert.ok(Math.max(...after.map((item) => item.right)) - Math.min(...after.map((item) => item.right)) <= 1);
  for (const previous of before) {
    const next = after.find((item) => item.turn === previous.turn);
    assert.ok(
      Math.abs(previous.x - next.x) <= 1 && Math.abs(previous.y - next.y) <= 1,
      `turn ${previous.turn} moved on expansion`,
    );
  }
  await row(8).locator('.turn-title').hover();
  await page.waitForTimeout(300);
  await expect(outline).toHaveClass(/expanded/);
  await outside();
  await page.waitForTimeout(120);
  await expect(outline).toHaveClass(/expanded/);
  await tick.hover();
  await page.waitForTimeout(180);
  await expect(outline).toHaveClass(/expanded/);
  await outside();
  await expect(outline).not.toHaveClass(/expanded/);
  await tick.hover();
  await expect(outline).toHaveClass(/expanded/);

  assert.equal((await row(1).locator('.turn-statistics').allTextContents()).join('').trim(), '');
  await expect(row(2).locator('.turn-added')).toHaveText('+2');
  await expect(row(2).locator('.turn-removed')).toHaveCount(0);
  await expect(row(7).locator('.turn-removed')).toHaveText('−1');
  await expect(row(7).locator('.turn-added')).toHaveCount(0);
  await expect(row(5).locator('.turn-failed-label')).toHaveText('失败');
  for (const [selector, variable] of [
    ['.turn-added', '--success'],
    ['.turn-removed', '--red'],
    ['.turn-failed-label', '--red'],
  ]) {
    const colors = await outline
      .locator(selector)
      .first()
      .evaluate((element, variable) => {
        const probe = document.createElement('span');
        probe.style.color = `var(${variable})`;
        element.append(probe);
        const result = { actual: getComputedStyle(element).color, expected: getComputedStyle(probe).color };
        probe.remove();
        return result;
      }, variable);
    assert.equal(colors.actual, colors.expected, selector);
  }
  await expect(row(3).locator('.turn-skill')).toHaveText('review');
  await expect(row(3).locator('.turn-title-text')).toHaveText('检查变更 重点关注边界');
  await expect(row(4).locator('.turn-title-text')).toHaveText('使用技能 review');
  await expect(row(6).locator('.turn-title-text')).toHaveText('[图片 ×1]');
  await expect(row(10).locator('.turn-title-text')).toHaveText('多行提问 需要合并 连续空白');
  assert.ok((await row(8).locator('.turn-title-text').textContent()).length > 36);
  assert.equal((await outline.textContent()).includes('<skill'), false);
  assert.match(await row(2).getAttribute('aria-label'), /第 2 轮.*新增 2 行/);
  assert.doesNotMatch(await row(2).getAttribute('aria-label'), /删除 0|新增 0/);

  const input = page.getByRole('textbox', { name: '任务输入' });
  await input.fill('');
  await row(6).click();
  const jumpedMessage = thread.locator('[data-turn="6"]');
  await expect(jumpedMessage).toHaveClass(/turn-jump-highlight/);
  await input.focus();
  await page.waitForTimeout(300);
  await expect(outline).toHaveClass(/expanded/);
  // Do not wait for intermediate scrolling/current-row updates: these are rapid real key presses.
  await page.keyboard.press('Alt+ArrowUp');
  await page.keyboard.press('Alt+ArrowUp');
  await page.keyboard.press('Alt+ArrowDown');
  await expect(row(5)).toHaveAttribute('aria-current', 'step');
  await page.keyboard.press('Alt+ArrowDown');
  await expect(row(6)).toHaveAttribute('aria-current', 'step');
  await expect(jumpedMessage).toHaveClass(/turn-jump-highlight/);
  await expect(outline).toHaveClass(/expanded/);
  await expect(row(6)).toHaveClass(/current/);
  const highlighted = await row(6).evaluate((element) => ({
    background: getComputedStyle(element).backgroundColor,
    weight: getComputedStyle(element.querySelector('.turn-title-text')).fontWeight,
  }));
  assert.notEqual(highlighted.background, 'rgba(0, 0, 0, 0)');
  assert.ok(Number(highlighted.weight) >= 600);
  await row(6).focus();
  await page.keyboard.press('Escape');
  await expect(outline).not.toHaveClass(/expanded/);
  await expect(thread).toBeFocused();
  await page.waitForTimeout(1100);
  await expect(jumpedMessage).not.toHaveClass(/turn-jump-highlight/);
  await input.fill('');
  await input.press('Alt+ArrowUp');
  await expect(row(5)).toHaveAttribute('aria-current', 'step');
  await input.press('Alt+ArrowDown');
  await expect(row(6)).toHaveAttribute('aria-current', 'step');
  await input.fill('保留用户尚未发送的多行内容\n第二段');
  const intercepted = await input.evaluate((element) => {
    const event = new KeyboardEvent('keydown', {
      key: 'ArrowUp',
      code: 'ArrowUp',
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  });
  assert.equal(intercepted, false, 'Alt+Arrow must preserve native cursor movement in a nonempty editor');
  await expect(row(6)).toHaveAttribute('aria-current', 'step');
  await input.fill('');

  await row(6).locator('.turn-tick').hover();
  await expect(outline).toHaveClass(/expanded/);
  const modified = outline.getByRole('button', { name: '修改 2', exact: true });
  const failed = outline.getByRole('button', { name: '失败 2', exact: true });
  await modified.click();
  await expect(rows).toHaveCount(2);
  assert.deepEqual(
    await rows.evaluateAll((elements) => elements.map((element) => element.dataset.turnNumber)),
    ['2', '7'],
  );
  await expect(outline.locator('[aria-current="step"]')).toHaveCount(0);
  await rows.first().focus();
  await page.keyboard.press('End');
  await expect(row(7)).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(row(2)).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(row(7)).toBeFocused();
  await page.keyboard.press('Home');
  await expect(row(2)).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(row(2)).toHaveAttribute('aria-current', 'step');
  await modified.click();
  await expect(rows).toHaveCount(12);
  await failed.click();
  assert.deepEqual(
    await rows.evaluateAll((elements) => elements.map((element) => element.dataset.turnNumber)),
    ['5', '9'],
  );
  await rows.first().focus();
  await page.keyboard.press('End');
  await expect(row(9)).toBeFocused();
  await failed.click();
  await expect(rows).toHaveCount(12);

  const contrast = {},
    screenshots = [];
  for (const [uiStyle, theme] of [
    ...['light', 'dark', 'sepia', 'green', 'navy'].map((theme) => ['classic', theme]),
    ...UI_STYLES.filter((style) => STYLE_META[style].basicThemesOnly).flatMap((style) =>
      ['light', 'dark'].map((theme) => [style, theme]),
    ),
  ]) {
    const key = uiStyle === 'classic' ? theme : `${uiStyle}-${theme}`;
    await page.evaluate((appearance) => window.desktop.invoke('saveSettings', appearance), {
      theme,
      uiStyle,
    });
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.style)).toBe(uiStyle);
    await row(2).locator('.turn-tick').hover();
    await expect(outline).toHaveClass(/expanded/);
    await page.waitForTimeout(150);
    contrast[key] = await outline.evaluate((nav) => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      const color = (css) => {
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = css;
        context.fillRect(0, 0, 1, 1);
        return [...context.getImageData(0, 0, 1, 1).data].map((value, index) =>
          index === 3 ? value / 255 : value,
        );
      };
      const over = (front, back) =>
        [0, 1, 2].map((index) => front[index] * front[3] + back[index] * (1 - front[3]));
      const luminance = (channels) =>
        channels
          .map((value) => value / 255)
          .map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4))
          .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
      const samples = [];
      const walker = document.createTreeWalker(nav, NodeFilter.SHOW_TEXT);
      for (let text = walker.nextNode(); text; text = walker.nextNode()) {
        if (!text.textContent.trim()) continue;
        const element = text.parentElement;
        if (!element.getBoundingClientRect().width) continue;
        const ancestors = [];
        for (let current = element; current; current = current.parentElement) ancestors.unshift(current);
        let background = [255, 255, 255];
        for (const ancestor of ancestors) {
          background = over(color(getComputedStyle(ancestor).backgroundColor), background);
          if (ancestor === nav) {
            // The floating panel paints its surface in ::before, behind the row backgrounds.
            const panel = getComputedStyle(nav, '::before');
            const surface = color(panel.backgroundColor);
            surface[3] *= Number(panel.opacity);
            background = over(surface, background);
          }
        }
        const foreground = over(color(getComputedStyle(element).color), background);
        const a = luminance(foreground),
          b = luminance(background);
        samples.push({
          text: text.textContent.trim(),
          ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
        });
      }
      return samples;
    });
    assert.ok(
      contrast[key].length > 20,
      'contrast measurement must include titles, counters, badges and filter text',
    );
    for (const sample of contrast[key])
      assert.ok(sample.ratio >= 4.5, `${key}: ${sample.text} contrast ${sample.ratio}`);
    const screenshot = `turn-outline-${key}.png`;
    await page.screenshot({ path: path.join(output, screenshot), animations: 'disabled' });
    screenshots.push(screenshot);
  }
  await page.evaluate(() => window.desktop.invoke('saveSettings', { theme: 'light', uiStyle: 'classic' }));
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('light');
  for (const status of ['running', 'completed']) {
    await app.evaluate(({ BrowserWindow }, status) => {
      globalThis.outlineUiRuntime.status = status;
      BrowserWindow.getAllWindows()[0].webContents.send('desktop:event', {
        type: 'runtime',
        runtime: globalThis.outlineUiRuntime,
      });
    }, status);
    if (status === 'running') {
      await expect(row(12)).toHaveClass(/running/);
      const colors = await row(12)
        .locator('.turn-tick')
        .evaluate((element) => {
          const probe = document.createElement('i');
          probe.style.backgroundColor = 'var(--warning)';
          document.documentElement.append(probe);
          const values = {
            actual: getComputedStyle(element).backgroundColor,
            expected: getComputedStyle(probe).backgroundColor,
          };
          probe.remove();
          return values;
        });
      assert.equal(colors.actual, colors.expected);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await expect
        .poll(() =>
          row(12)
            .locator('.turn-tick')
            .evaluate((element) => getComputedStyle(element).animationName),
        )
        .toBe('none');
      await page.emulateMedia({ reducedMotion: 'no-preference' });
    } else await expect(row(12)).not.toHaveClass(/running/);
  }
  // The final short turn cannot align to the top: its navigation request must still finish.
  await app.evaluate(({ BrowserWindow }) => {
    globalThis.outlineUiRuntime.messages.at(-1).content = '简短回复。';
    BrowserWindow.getAllWindows()[0].webContents.send('desktop:event', {
      type: 'runtime',
      runtime: globalThis.outlineUiRuntime,
    });
  });
  await row(1).focus();
  await row(1).click();
  await expect.poll(() => thread.evaluate((element) => element.scrollTop)).toBeLessThan(100);
  await row(12).click();
  await expect
    .poll(() => thread.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop))
    .toBeLessThan(2);
  await app.evaluate(({ BrowserWindow }) => {
    globalThis.outlineUiRuntime.messages.push(
      { role: 'user', content: '末尾跳转后继续提问', timestamp: 1700000001300 },
      { role: 'assistant', content: '新轮次继续输出。\n\n'.repeat(50), timestamp: 1700000001301 },
    );
    BrowserWindow.getAllWindows()[0].webContents.send('desktop:event', {
      type: 'runtime',
      runtime: globalThis.outlineUiRuntime,
    });
  });
  await expect(row(13)).toHaveAttribute('aria-current', 'step');
  await app.evaluate(({ BrowserWindow }) => {
    const messages = globalThis.outlineUiRuntime.messages;
    for (let turn = 14; turn <= 123; turn++)
      messages.push({ role: 'user', content: `第 ${turn} 轮未回复`, timestamp: 1700000000000 + turn * 100 });
    BrowserWindow.getAllWindows()[0].webContents.send('desktop:event', {
      type: 'runtime',
      runtime: globalThis.outlineUiRuntime,
    });
  });
  await outline.hover();
  await outline.locator('.turn-outline-list').evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(row(123)).toBeVisible();
  const number = await row(123)
    .locator('.turn-number')
    .evaluate((element) => ({
      text: element.textContent,
      width: element.clientWidth,
      scroll: element.scrollWidth,
    }));
  assert.equal(number.text, '#123');
  assert.ok(number.width >= number.scroll, 'three-digit turn numbers must not clip');
  await outside();
  await input.focus();
  console.log(
    'PASS UI6 fixed ticks, hover delays, cleaned titles, filtered keyboard navigation and all style text contrast',
  );
  return { contrast, screenshots };
}

/** Exercise the real Pi edit/resend path against the local fixture provider. */
export async function verifyNativeSkillUI({ app, page, fixture, provider }) {
  const directory = path.join(fixture.agentDir, 'skills', 'ui7');
  const file = path.join(directory, 'SKILL.md');
  await fs.mkdir(directory, { recursive: true });
  const source = (version) => `---\nname: ui7\ndescription: Local UI acceptance skill\n---\n\n${version}\n`;
  await fs.writeFile(file, source('UI7_SKILL_VERSION_ONE'));
  const session = await page.evaluate(() => window.desktop.invoke('newSession'));
  const input = page.getByRole('textbox', { name: '任务输入' });
  await expect(
    page.locator(`.session-row[data-session-id="${session.id}"] > button`).first(),
  ).toHaveAttribute('aria-current', 'page');
  await input.fill('/skill:ui7 帮我看看');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await page.locator('.run-meta .status.completed').waitFor({ timeout: 30000 });
  const user = page.locator('.message.user').last();
  await expect(user.locator('.user-message-text')).toHaveText('帮我看看');
  await expect(user.locator('.skill-toggle')).toHaveAttribute('aria-expanded', 'false');
  const clipboard = () => app.evaluate(({ clipboard }) => clipboard.readText());
  await user.getByRole('button', { name: '复制消息', exact: true }).click();
  await expect.poll(clipboard).toBe('/skill:ui7 帮我看看');
  await user.getByRole('button', { name: '更多消息操作', exact: true }).click();
  await user.getByRole('menuitem', { name: '复制完整内容' }).click();
  await expect.poll(clipboard).toMatch(/^<skill name="ui7"[\s\S]*UI7_SKILL_VERSION_ONE[\s\S]*帮我看看$/);
  const requests = provider.requests.length;
  await user.getByRole('button', { name: '编辑后重新发送', exact: true }).click();
  await expect(input).toHaveValue('/skill:ui7 帮我看看');
  assert.equal(provider.requests.length, requests, 'editing must not send a prompt');
  await fs.writeFile(file, source('UI7_SKILL_VERSION_TWO'));
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await page.locator('.run-meta .status.completed').waitFor({ timeout: 30000 });
  await expect(page.locator('.message.user .skill-toggle').last()).toBeVisible();
  const history = await page.evaluate((id) => window.desktop.invoke('readHistory', id), session.id);
  const message = history.findLast((message) => message.role === 'user');
  const text =
    typeof message.content === 'string'
      ? message.content
      : message.content
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('\n');
  assert.match(text, /UI7_SKILL_VERSION_TWO/);
  assert.doesNotMatch(text, /UI7_SKILL_VERSION_ONE/);
  console.log('PASS native skill copy, full-content menu and edit/resend reload the current skill file');
  return { sessionId: session.id, latestSkillReloaded: true };
}

export async function verifyMessageContentUI({ app, page, output }) {
  const skillBody = Array.from(
    { length: 300 },
    (_, index) => `- ${index === 294 ? 'SKILL_FIND_END' : '技能步骤'} ${index + 1}`,
  ).join('\n');
  const longPrompt = Array.from(
    { length: 200 },
    (_, index) => `第 ${index + 1} 行：${index === 195 ? 'PROMPT_FIND_END' : '检查粘贴内容并保留顺序'}`,
  ).join('\n');
  const messages = [];
  const finalIndices = new Map();
  for (let turn = 1; turn <= 20; turn++) {
    const timestamp = 1800000000000 + turn * 100;
    const content =
      turn === 1 || turn === 2
        ? `<skill name="x" location="/fixture/SKILL.md">\n${skillBody}\n</skill>${turn === 1 ? '\n\n帮我看看' : ''}`
        : turn === 5
          ? longPrompt
          : turn === 6
            ? '长'.repeat(1201)
            : `第 ${turn} 轮提问`;
    messages.push({ role: 'user', content, timestamp });
    if (turn !== 4) {
      messages.push(
        { role: 'assistant', content: `第 ${turn} 轮的中间说明`, timestamp: timestamp + 1 },
        {
          role: 'assistant',
          content: [{ type: 'toolCall', id: `ui7-${turn}`, name: 'read' }],
          timestamp: timestamp + 2,
        },
        {
          role: 'toolResult',
          toolCallId: `ui7-${turn}`,
          toolName: 'read',
          content: '不应复制的工具输出',
          timestamp: timestamp + 3,
        },
      );
      finalIndices.set(turn, messages.length);
      messages.push({
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '不应复制的思考' },
          { type: 'text', text: `第 ${turn} 轮最终回复\n\n已经完成检查。` },
        ],
        timestamp: timestamp + 4,
      });
    }
    messages.push({
      role: 'assistant',
      content: [{ type: 'thinking', thinking: '后续只有思考' }],
      timestamp: timestamp + 5,
    });
  }
  await app.evaluate(({ BrowserWindow }, messages) => {
    globalThis.outlineUiRuntime = { ...globalThis.outlineUiRuntime, messages, status: 'completed' };
    BrowserWindow.getAllWindows()[0].webContents.send('desktop:event', {
      type: 'runtime',
      runtime: globalThis.outlineUiRuntime,
    });
  }, messages);
  const outline = page.getByRole('navigation', { name: '对话轮次' });
  const row = (turn) => outline.locator(`button[data-turn-number="${turn}"]`);
  const thread = page.locator('.thread');
  const user = (turn) => thread.locator(`[data-turn="${turn}"] .message.user`);
  const clipboard = () => app.evaluate(({ clipboard }) => clipboard.readText());
  const jump = async (turn) => {
    await row(turn).focus();
    await row(turn).press('Enter');
    await expect(row(turn)).toHaveAttribute('aria-current', 'step');
    await expect
      .poll(() =>
        user(turn).evaluate((element) => {
          const container = document.querySelector('.thread');
          const bounds = element.getBoundingClientRect();
          const offset =
            bounds.height > container.clientHeight * 0.4
              ? bounds.bottom - container.getBoundingClientRect().top - container.clientHeight * 0.4
              : bounds.top - container.getBoundingClientRect().top;
          const target = Math.max(
            0,
            Math.min(container.scrollHeight - container.clientHeight, container.scrollTop + offset),
          );
          return Math.abs(container.scrollTop - target) <= 2;
        }),
      )
      .toBe(true);
  };
  const savedExpansion = async (key) =>
    page.evaluate(async (key) => {
      const { state } = await window.desktop.invoke('bootstrap');
      return (
        state.sessions
          .find((session) => session.id === state.selectedSessionId)
          ?.expandedTools?.includes(key) ?? false
      );
    }, key);
  await jump(1);
  const skill = user(1).locator('.skill-toggle');
  await expect(skill).toHaveText('技能 · x · 300 行');
  await expect(skill).toHaveAttribute('aria-expanded', 'false');
  await expect(user(1).locator('.skill-content')).toHaveCount(0);
  await expect(user(1).locator('.user-message-text')).toHaveText('帮我看看');
  const bubble = await user(1)
    .locator('.message-content')
    .evaluate((element) => ({
      height: element.getBoundingClientRect().height,
      line: parseFloat(getComputedStyle(element).lineHeight),
      parts: [...element.children].map((node) => ({
        className: node.className,
        height: node.getBoundingClientRect().height,
        margin: getComputedStyle(node).margin,
        padding: getComputedStyle(node).padding,
      })),
    }));
  assert.ok(
    bubble.height <= bubble.line * 3 + 1,
    `collapsed skill and prompt should fit within three lines: ${JSON.stringify(bubble)}`,
  );
  await skill.click();
  await expect(user(1).locator('.skill-content li')).toHaveCount(300);
  await expect.poll(() => savedExpansion('skill:1800000000100')).toBe(true);
  await user(1).getByRole('button', { name: '复制技能正文' }).click();
  await expect.poll(clipboard).toBe(skillBody);
  await page.reload();
  await page.getByRole('textbox', { name: '任务输入' }).waitFor();
  await jump(1);
  await expect(skill).toHaveAttribute('aria-expanded', 'true');
  await skill.click();
  await expect.poll(() => savedExpansion('skill:1800000000100')).toBe(false);
  await jump(2);
  await expect(user(2).locator('.user-message-text')).toHaveText('使用技能 x');
  await user(2).getByRole('button', { name: '复制消息', exact: true }).click();
  await expect.poll(clipboard).toBe('/skill:x');

  const find = async (query) => {
    await page.evaluate(() => window.dispatchEvent(new Event('pi:find')));
    await page.getByRole('textbox', { name: '查找当前会话' }).fill(query);
  };
  await find('SKILL_FIND_END');
  await expect(user(1).locator('.skill-toggle')).toHaveAttribute('aria-expanded', 'true');
  await expect
    .poll(() =>
      page.evaluate(() => {
        const range = [...(CSS.highlights.get('session-find') ?? [])][0];
        const content = range?.startContainer.parentElement?.closest('.skill-content');
        if (!range || !content) return false;
        const hit = range.getBoundingClientRect(),
          box = content.getBoundingClientRect();
        return range.toString() === 'SKILL_FIND_END' && hit.top >= box.top && hit.bottom <= box.bottom;
      }),
    )
    .toBe(true);
  await page.getByRole('button', { name: '关闭会话查找' }).click();
  await expect(skill).toHaveAttribute('aria-expanded', 'false');
  await expect.poll(() => savedExpansion('skill:1800000000100')).toBe(false);
  await jump(5);
  const expand = user(5).getByRole('button', { name: '展开全文（共 200 行）' });
  await expect(expand).toBeVisible();
  const collapsed = await user(5)
    .locator('.user-message-text')
    .evaluate((element) => ({
      height: element.clientHeight,
      line: parseFloat(getComputedStyle(element).lineHeight),
      scrollHeight: element.scrollHeight,
    }));
  assert.ok(collapsed.height <= collapsed.line * 12 + 1 && collapsed.scrollHeight > collapsed.height);
  await expand.click();
  await expect.poll(() => savedExpansion('prompt:1800000000500')).toBe(true);
  await jump(5);
  await expect
    .poll(() =>
      user(5).evaluate((element) => {
        const viewport = document.querySelector('.thread').getBoundingClientRect();
        const question = element.getBoundingClientRect();
        const reply = element.closest('[data-message-index]').nextElementSibling.getBoundingClientRect();
        return (
          Math.abs(question.bottom - (viewport.top + viewport.height * 0.4)) < 4 &&
          reply.top < viewport.bottom
        );
      }),
    )
    .toBe(true);
  await page.screenshot({ path: path.join(output, 'chat-ui-long-prompt-jump.png') });
  await user(5).getByRole('button', { name: '收起', exact: true }).click();
  await expect.poll(() => savedExpansion('prompt:1800000000500')).toBe(false);
  await find('PROMPT_FIND_END');
  await expect(user(5).getByRole('button', { name: '收起', exact: true })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const range = [...(CSS.highlights.get('session-find') ?? [])][0];
        return (
          range?.toString() === 'PROMPT_FIND_END' &&
          Boolean(range.startContainer.parentElement.closest('.user-message-text'))
        );
      }),
    )
    .toBe(true);
  await page.getByRole('button', { name: '关闭会话查找' }).click();
  await expect.poll(() => savedExpansion('prompt:1800000000500')).toBe(false);
  await page.reload();
  await page.getByRole('textbox', { name: '任务输入' }).waitFor();
  await jump(5);
  await expect(user(5).getByRole('button', { name: /^展开全文/ })).toBeVisible();
  await user(5)
    .getByRole('button', { name: /^展开全文/ })
    .click();
  await jump(1);
  await expect(skill).toHaveAttribute('aria-expanded', 'false');
  await skill.click();
  await expect.poll(() => savedExpansion('skill:1800000000100')).toBe(true);
  const { state } = await page.evaluate(() => window.desktop.invoke('bootstrap'));
  const currentSession = state.selectedSessionId;
  const otherSession = state.sessions.find((session) => session.id !== currentSession);
  assert.ok(otherSession);
  const select = async (id) => {
    const button = page.locator(`.session-row[data-session-id="${id}"] > button`).first();
    await button.click();
    await expect(button).toHaveAttribute('aria-current', 'page');
  };
  await select(otherSession.id);
  await select(currentSession);
  await jump(1);
  await expect(skill).toHaveAttribute('aria-expanded', 'true');
  await jump(5);
  await expect(user(5).getByRole('button', { name: '收起', exact: true })).toBeVisible();
  await jump(6);
  await expect(user(6).getByRole('button', { name: '展开全文（共 1 行）' })).toBeVisible();
  await jump(1);
  // Collapsed rows expose only their tick; expand before targeting the row actions.
  await row(5).locator('.turn-tick').hover();
  await expect(outline).toHaveClass(/expanded/);
  await row(5).hover();
  const before = await thread.evaluate((element) => element.scrollTop);
  await outline.getByRole('button', { name: '复制第 5 轮回复', exact: true }).click();
  await expect.poll(clipboard).toBe('第 5 轮最终回复\n\n已经完成检查。');
  assert.equal(
    await thread.evaluate((element) => element.scrollTop),
    before,
    'copy must not jump the conversation',
  );
  await row(5).focus();
  await app.evaluate(({ clipboard }) => clipboard.writeText('UI7_KEYBOARD_COPY_SENTINEL'));
  await page.keyboard.press('c');
  await expect.poll(clipboard).toBe('第 5 轮最终回复\n\n已经完成检查。');
  const intercepted = await row(5).evaluate((element) => {
    const event = new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true, cancelable: true });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  });
  assert.equal(intercepted, false, 'Ctrl+C keeps system text copying');
  await row(4).locator('.turn-tick').hover();
  await expect(outline).toHaveClass(/expanded/);
  await row(4).hover();
  const missing = outline.getByRole('button', { name: '复制第 4 轮回复', exact: true });
  await expect(missing).toBeDisabled();
  await expect(missing).toHaveAttribute('title', '本轮没有可复制的回复');
  await row(4).focus();
  await page.keyboard.press('c');
  await expect(page.getByText('本轮没有可复制的回复', { exact: true })).toBeVisible();
  await jump(5);
  const final = thread.locator(`[data-message-index="${finalIndices.get(5)}"]`);
  await expect(final.getByRole('button', { name: '复制回复', exact: true })).toBeVisible();
  await final.getByRole('button', { name: '复制回复', exact: true }).click();
  await expect.poll(clipboard).toBe('第 5 轮最终回复\n\n已经完成检查。');
  await expect(thread.locator(`[data-message-index="${finalIndices.get(5) - 3}"] .reply-copy`)).toHaveCount(
    0,
  );
  await app.evaluate(({ BrowserWindow }) => {
    globalThis.outlineUiRuntime.status = 'running';
    BrowserWindow.getAllWindows()[0].webContents.send('desktop:event', {
      type: 'runtime',
      runtime: globalThis.outlineUiRuntime,
    });
  });
  await jump(20);
  await expect(thread.locator(`[data-message-index="${finalIndices.get(20)}"] .reply-copy`)).toHaveCount(0);
  await app.evaluate(({ BrowserWindow }) => {
    globalThis.outlineUiRuntime.status = 'completed';
    BrowserWindow.getAllWindows()[0].webContents.send('desktop:event', {
      type: 'runtime',
      runtime: globalThis.outlineUiRuntime,
    });
  });
  await expect(thread.locator(`[data-message-index="${finalIndices.get(20)}"] .reply-copy`)).toHaveCount(1);
  assert.ok((await outline.locator('button').count()) <= 60);
  await app.evaluate(({ BrowserWindow }) => {
    const messages = globalThis.outlineUiRuntime.messages;
    messages[2].content[0].arguments = { path: 'fixture.ts' };
    messages[4].content.find((block) => block.type === 'text').text += '\n\n```ts\nconst quoted = 1;\n```';
    messages[5].content[0].thinking = '不应复制的思考，后续只有思考';
    BrowserWindow.getAllWindows()[0].webContents.send('desktop:event', {
      type: 'runtime',
      runtime: globalThis.outlineUiRuntime,
    });
  });
  await jump(1);
  const tool = thread.locator('[data-message-index="3"]');
  await tool.locator('summary').click();
  const choose = async (locator, text) => {
    await locator.scrollIntoViewIfNeeded();
    await thread.focus();
    await locator.evaluate((element, text) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      if (text) {
        const node = element.firstChild;
        const start = node.textContent.lastIndexOf(text);
        assertSelectionStart(start);
        range.setStart(node, start);
        range.setEnd(node, start + text.length);
      }
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
      function assertSelectionStart(start) {
        if (start < 0) throw new Error('The expected thinking fragment is missing');
      }
    }, text);
  };
  const selectionMenu = page.getByRole('toolbar', { name: '对话选区操作' });
  await choose(tool.locator('.ansi-output'));
  await selectionMenu.getByRole('button', { name: '引用', exact: true }).click();
  await expect(page.locator('.draft-quotes')).toContainText('工具输出');
  const code = thread.locator('[data-message-index="4"] .code-block > pre');
  await choose(code);
  await selectionMenu.getByRole('button', { name: '引用', exact: true }).click();
  await expect(page.locator('.draft-quotes')).toContainText('代码');
  const thinking = thread.locator('[data-quote-thinking-owner="4"] .thinking');
  await thinking.locator('summary').click();
  await choose(thinking.locator('pre'), '后续只有思考');
  await selectionMenu.getByRole('button', { name: '引用', exact: true }).click();
  const quotes = () =>
    page.evaluate(async () => {
      await window.desktop.invoke('flushDraft');
      const { state } = await window.desktop.invoke('bootstrap');
      return state.sessions.find((session) => session.id === state.selectedSessionId).draftQuotes;
    });
  await expect.poll(async () => (await quotes()).at(-1).messageTimestamp).toBe(1800000000105);
  await page.locator('.draft-quotes > span').last().locator('button').first().click();
  await expect
    .poll(() => page.evaluate(() => [...(CSS.highlights.get('conversation-quote') ?? [])][0]?.toString()))
    .toBe('后续只有思考');
  await choose(thinking.locator('pre'), '不应复制的思考');
  await selectionMenu.getByRole('button', { name: '引用', exact: true }).click();
  await expect.poll(async () => (await quotes()).at(-1).messageTimestamp).toBe(1800000000105);
  await page.locator('.draft-quotes > span').last().locator('button').first().click();
  await expect
    .poll(() => page.evaluate(() => [...(CSS.highlights.get('conversation-quote') ?? [])][0]?.startOffset))
    .toBeGreaterThan(0);
  await choose(thinking.locator('pre'));
  await selectionMenu.getByRole('button', { name: '引用', exact: true }).click();
  await expect.poll(async () => (await quotes()).at(-1).text).toBe('不应复制的思考');
  assert.equal((await quotes()).at(-1).messageTimestamp, 1800000000104);
  await choose(code);
  await page.keyboard.press('Escape');
  await expect(selectionMenu).toHaveCount(0);
  await choose(tool.locator('.arguments'));
  await expect(selectionMenu).toHaveCount(0);
  await thread.locator('[data-message-index="1"] .message-content').scrollIntoViewIfNeeded();
  await thread.focus();
  await thread.evaluate((element) => {
    const first = element.querySelector('[data-message-index="1"] .message-content');
    const end = element.querySelector('[data-turn="2"] .user-message-text');
    const range = document.createRange();
    range.setStart(first, 0);
    range.setEnd(end, end.childNodes.length);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    first.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  });
  await selectionMenu.getByRole('button', { name: '引用', exact: true }).click();
  await expect(page.getByText('选区跨过多条消息，只引用了第一条消息内的内容', { exact: true })).toBeVisible();
  await choose(code);
  await selectionMenu.getByRole('button', { name: '侧边提问', exact: true }).click();
  const side = page.getByRole('complementary', { name: '侧边对话' });
  await expect(side.locator('.side-draft-quotes')).toContainText('代码');
  await side.getByRole('button', { name: '关闭侧边对话' }).click();
  await app.evaluate(({ BrowserWindow }) => {
    globalThis.outlineUiRuntime.messages[3].details = {
      patch: '--- a/fixture.ts\n+++ b/fixture.ts\n@@ -1 +1 @@\n-old line\n+new line\n',
    };
    BrowserWindow.getAllWindows()[0].webContents.send('desktop:event', {
      type: 'runtime',
      runtime: globalThis.outlineUiRuntime,
    });
  });
  await choose(tool.locator('.diff-row.added code'));
  await selectionMenu.getByRole('button', { name: '引用', exact: true }).click();
  await expect.poll(async () => (await quotes()).at(-1).text).toBe('new line');
  // A shell message and live activity do not have a saved toolResult wrapper yet.
  await app.evaluate(({ BrowserWindow }) => {
    globalThis.outlineUiRuntime.messages.push({
      role: 'bashExecution',
      command: 'echo F1_SHELL_OUTPUT',
      output: 'F1_SHELL_OUTPUT',
      exitCode: 0,
      content: '',
      timestamp: 1800000003000,
    });
    globalThis.outlineUiRuntime.tools = [
      {
        id: 'f1-live',
        name: 'bash',
        args: { command: 'echo F1_LIVE_OUTPUT' },
        output: 'F1_LIVE_OUTPUT',
        status: 'running',
        startedAt: 1800000003001,
      },
    ];
    BrowserWindow.getAllWindows()[0].webContents.send('desktop:event', {
      type: 'runtime',
      runtime: globalThis.outlineUiRuntime,
    });
  });
  await jump(20);
  await choose(thread.locator('.bash-message .ansi-output'));
  await selectionMenu.getByRole('button', { name: '引用', exact: true }).click();
  assert.equal((await quotes()).at(-1).section, 'tool');
  assert.equal((await quotes()).at(-1).text, 'F1_SHELL_OUTPUT');
  const live = thread.locator('[data-quote-tool-id="f1-live"]');
  await choose(live.locator('.ansi-output'));
  await selectionMenu.getByRole('button', { name: '引用', exact: true }).click();
  assert.equal((await quotes()).at(-1).section, 'tool');
  assert.equal((await quotes()).at(-1).text, 'F1_LIVE_OUTPUT');
  assert.equal((await quotes()).at(-1).toolCallId, 'f1-live');
  // Put a one-line selection just below the thread's top edge.
  await jump(1);
  await code.evaluate((element) => {
    const thread = element.closest('.thread');
    thread.scrollTop += element.getBoundingClientRect().top - thread.getBoundingClientRect().top - 14;
  });
  await choose(code);
  const placement = await selectionMenu.evaluate((element) => ({
    top: element.getBoundingClientRect().top,
    selectionBottom: window.getSelection().getRangeAt(0).getBoundingClientRect().bottom,
  }));
  assert.ok(placement.top >= placement.selectionBottom, 'a selection near the top needs its menu below it');
  await page.keyboard.press('Escape');
  const longQuote = {
    id: 'f1-long-paragraph',
    role: 'assistant',
    turn: 1,
    messageTimestamp: 1800000000101,
    section: 'text',
    text: '这是一段没有换行但会在气泡里自动换行的长引用。'.repeat(80),
  };
  await app.evaluate(({ BrowserWindow }, quote) => {
    const { text, ...source } = quote;
    globalThis.outlineUiRuntime.messages.push({
      role: 'user',
      content: `> [引用 第 1 轮 Pi 回复](pi-quote:${encodeURIComponent(JSON.stringify(source))})\n> ${text}\n\n检查长段引用`,
      timestamp: 1800000003002,
    });
    BrowserWindow.getAllWindows()[0].webContents.send('desktop:event', {
      type: 'runtime',
      runtime: globalThis.outlineUiRuntime,
    });
  }, longQuote);
  await jump(21);
  const longCard = thread.locator('.message-quote').last();
  await expect(longCard.getByRole('button', { name: '展开引用', exact: true })).toBeVisible();
  assert.ok(
    await longCard
      .locator('.quote-text')
      .evaluate(
        (element) => element.clientHeight <= parseFloat(getComputedStyle(element).lineHeight) * 4 + 1,
      ),
  );
  await app.evaluate(({ BrowserWindow }) => {
    globalThis.outlineUiRuntime.model = {
      id: 'preview',
      provider: 'fixture',
      name: 'Context preview',
      contextWindow: 1000,
    };
    BrowserWindow.getAllWindows()[0].webContents.send('desktop:event', {
      type: 'runtime',
      runtime: globalThis.outlineUiRuntime,
    });
  });
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('pi:side', { detail: { show: true } })));
  const previewPanel = page.getByRole('complementary', { name: '侧边对话' });
  await previewPanel.getByRole('combobox', { name: '侧边上下文范围' }).selectOption('all');
  await expect(previewPanel.getByRole('status')).toContainText(/已省略前 \d+ 轮/);
  await previewPanel.getByRole('button', { name: '关闭侧边对话' }).click();
  await app.evaluate(({ BrowserWindow }) => {
    globalThis.outlineUiRuntime.messages = [
      {
        role: 'bashExecution',
        command: 'echo FIRST_SHELL_OUTPUT',
        output: 'FIRST_SHELL_OUTPUT',
        content: '',
        timestamp: 1800000004000,
        exitCode: 0,
      },
    ];
    globalThis.outlineUiRuntime.tools = [];
    BrowserWindow.getAllWindows()[0].webContents.send('desktop:event', {
      type: 'runtime',
      runtime: globalThis.outlineUiRuntime,
    });
  });
  await choose(thread.locator('.bash-message .ansi-output'));
  await selectionMenu.getByRole('button', { name: '引用', exact: true }).click();
  assert.equal((await quotes()).at(-1).turn, 0);
  await expect(page.locator('.draft-quotes')).toContainText('工具输出 · FIRST_SHELL_OUTPUT');
  console.log(
    'PASS UI7 folding, saved views, section search and turn copying; C1 code/tool/thinking selection, source jumps, cross-message clipping and side entry',
  );
  return { turns: 20, skillLines: 300, promptLines: 200 };
}
