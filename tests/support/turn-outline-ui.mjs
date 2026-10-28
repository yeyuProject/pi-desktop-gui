import assert from 'node:assert/strict';
import path from 'node:path';
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
    BrowserWindow.getAllWindows()[0].setSize(1440, 1100);
    globalThis.outlineUiRuntime = runtime;
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
    ['.turn-added', '--accent'],
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
  for (const theme of ['light', 'dark', 'sepia', 'green', 'navy']) {
    await page.evaluate((theme) => window.desktop.invoke('saveSettings', { theme }), theme);
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
    await row(2).locator('.turn-tick').hover();
    await expect(outline).toHaveClass(/expanded/);
    await page.waitForTimeout(150);
    contrast[theme] = await outline.evaluate((nav) => {
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
      contrast[theme].length > 20,
      'contrast measurement must include titles, counters, badges and filter text',
    );
    for (const sample of contrast[theme])
      assert.ok(sample.ratio >= 4.5, `${theme}: ${sample.text} contrast ${sample.ratio}`);
    const screenshot = `turn-outline-${theme}.png`;
    await page.screenshot({ path: path.join(output, screenshot), animations: 'disabled' });
    screenshots.push(screenshot);
  }
  await page.evaluate(() => window.desktop.invoke('saveSettings', { theme: 'light' }));
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
          element.append(probe);
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
  await outside();
  await input.focus();
  console.log(
    'PASS UI6 fixed ticks, hover delays, cleaned titles, filtered keyboard navigation and five-theme text contrast',
  );
  return { contrast, screenshots };
}
