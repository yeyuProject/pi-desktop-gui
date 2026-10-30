import { launchApp, closeApp } from './desktop-app.mjs';
import { expect } from 'playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { prepareRealPiFixture } from './local-provider.ts';
import { createPlanProvider, planSteps, nextPlanSteps } from './plan-provider.ts';

export async function verifyPlanUI({ output = path.resolve('test-results') } = {}) {
  const provider = await createPlanProvider();
  const fixture = await prepareRealPiFixture(provider.baseUrl, 'plan-ui');
  const id = fixture.sessionId;
  fixture.store.session(id).approvalMode = 'confirm';
  await fixture.store.save();
  await fs.mkdir(output, { recursive: true });
  let app, page;
  const errors = [];
  const launch = async () => {
    ({ app, page } = await launchApp({
      executablePath: process.env.PI_DESKTOP_EXE,
      dataDir: fixture.dataDir,
      pageTimeout: 15000,
      errors: errors,
    }));

    await page.getByRole('textbox', { name: '任务输入' }).waitFor();
    await page.bringToFront();
  };
  const snapshot = () => page.evaluate(() => window.desktop.invoke('bootstrap'));
  const send = (text) =>
    page.evaluate(({ id, text }) => window.desktop.invoke('send', id, text, [], 'steer'), { id, text });
  const ready = () => expect.poll(() => provider.waiting, { timeout: 30000 }).toBe(1);
  const idle = () =>
    expect
      .poll(async () => (await snapshot()).runtime.status, { timeout: 30000 })
      .toMatch(/^(idle|completed|stopped)$/);
  const contrast = {};
  try {
    await launch();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 960));
    let card = page.getByRole('region', { name: '任务计划', exact: true });
    await expect(card).toHaveCount(0);
    provider.respond(planSteps);
    await send('检查登录输入，修复校验，运行回归测试，再核对提交');
    await expect(card).toContainText('步骤 1 / 4 · 检查登录输入与现有测试');
    await ready();
    await expect(card.locator('.spin')).toHaveCount(1);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await card.getByRole('button', { name: '展开任务计划' }).click();
    await expect(card.locator('li')).toHaveCount(4);
    await expect(card.locator('li').first()).toContainText('● 进行中');
    await expect(card.locator('li').nth(1)).toContainText('○ 待开始');
    await page.keyboard.press('Escape');
    await expect(card.locator('li')).toHaveCount(0);
    await card.getByRole('button', { name: '展开任务计划' }).click();
    await card.getByRole('button', { name: '收起任务计划' }).click();
    await expect(card.locator('li')).toHaveCount(0);
    const turnId = (await snapshot()).runtime.plan.turnId;
    await card.getByRole('button', { name: '关闭任务计划' }).click();
    await expect(card).toHaveCount(0);
    provider.respond(planSteps); // Identical data still counts as a new model update.
    await expect(card).toBeVisible();
    await ready();
    await send('补充：同时检查空输入');
    assert.equal((await snapshot()).runtime.plan.turnId, turnId);
    provider.respond(nextPlanSteps);
    await expect(card).toContainText('步骤 2 / 4 · 修复登录校验');
    await ready();
    provider.respond('本轮已结束，后续验证步骤尚未完成。');
    await idle();
    await expect(card).toContainText('本轮已结束 · 剩余 3 步');
    await expect(card.locator('.spin')).toHaveCount(0);
    await card.getByRole('button', { name: '展开任务计划' }).click();
    await expect(card.locator('li').first()).toContainText('✓ 已完成');
    await expect(card.locator('li').nth(1)).toContainText('● 未完成');
    await expect(page.getByRole('region', { name: '对话内容', exact: true })).not.toContainText(
      'desktop_plan',
    );
    await expect(page.getByRole('region', { name: '对话内容', exact: true })).not.toContainText(
      '检查登录输入与现有测试',
    );
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+f' : 'Control+f');
    const find = page.getByRole('textbox', { name: '查找当前会话', exact: true });
    {
      await expect(find).toBeVisible();
      await find.fill('检查登录输入与现有测试');
      await expect(page.getByRole('search', { name: '会话内查找' })).toContainText('0');
      await page.getByRole('button', { name: '关闭会话查找' }).click();
    }
    const file = (await snapshot()).state.sessions.find((session) => session.id === id).file;
    const entries = (await fs.readFile(file, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const original = entries.find(
      (entry) => entry.customType === 'desktop-plan' && entry.data?.steps[0].status === 'in_progress',
    );
    const empty = entries.find((entry) => entry.type === 'message' && entry.message.role === 'user');
    const latest = entries.at(-1);
    await page.evaluate(() => window.desktop.invoke('newSession'));
    await expect(card).toHaveCount(0);
    await page.evaluate((id) => window.desktop.invoke('selectSession', id), id);
    await expect(card.locator('li')).toHaveCount(4);
    await page.evaluate(() => window.desktop.invoke('flushDraft'));
    await app.close();
    await launch();
    card = page.getByRole('region', { name: '任务计划', exact: true });
    await expect(card).toContainText('步骤 2 / 4');
    await expect(card.locator('li')).toHaveCount(4);
    assert.equal((await snapshot()).runtime.connected, false, 'offline restoration needs no Pi connection');
    await page.evaluate((id) => window.desktop.invoke('connect', id), id);
    for (const [entryId, text] of [
      [original.id, '步骤 1 / 4'],
      [empty.id, null],
      [latest.id, '步骤 2 / 4'],
    ]) {
      await page.evaluate(
        ({ id, entryId }) => window.desktop.invoke('branchSession', id, 'navigate', entryId),
        { id, entryId },
      );
      if (text) await expect(card).toContainText(text);
      else await expect(card).toHaveCount(0);
    }
    console.log(
      'PASS plan UI updates, accessible steps, expand/Esc, dismissal, steering, unfinished state, session/restart/branch restoration',
    );

    await send('新任务：确认所有步骤完成后的收起行为');
    await ready();
    await expect(card).toHaveCount(0);
    provider.respond(planSteps.map((step) => ({ ...step, status: 'completed' })));
    await expect(card).toContainText('步骤 4 / 4 · 全部完成');
    await ready();
    await expect(card.locator('li')).toHaveCount(0);
    // Completion while Pi is still running must not start the 8-second timer.
    await page.mouse.move(20, 100);
    await page.waitForTimeout(8200);
    await expect(card).toBeVisible();
    provider.respond('全部步骤已经完成。');
    await idle();
    const dot = page.getByRole('button', { name: '查看已完成的任务计划', exact: true });
    await expect(dot).toBeVisible({ timeout: 10000 });
    await dot.click();
    await expect(card.locator('li')).toHaveCount(4);
    await expect(card.locator('.spin')).toHaveCount(0);
    console.log('PASS completed plans minimize only after settling, and reopen from their dot');

    await send('新任务：验证最长计划的显示');
    await ready();
    const longSteps = Array.from({ length: 12 }, (_, index) => ({
      text: `${index + 1}：` + '超长计划文字ABC'.repeat(500).slice(0, 4000 - `${index + 1}：`.length),
      status: index === 0 ? 'completed' : index === 1 ? 'in_progress' : 'pending',
    }));
    provider.respond(longSteps);
    await expect(card).toContainText('步骤 2 / 12');
    await ready();
    provider.respond('计划显示压力测试完成，保留未完成步骤。');
    await idle();
    await card.getByRole('button', { name: '展开任务计划' }).click();
    await expect(card.locator('li')).toHaveCount(12);
    const screenshots = [];
    for (const uiStyle of ['classic', 'codex', 'claude'])
      for (const theme of ['light', 'dark']) {
        await page.evaluate((settings) => window.desktop.invoke('saveSettings', settings), {
          uiStyle,
          theme,
        });
        await expect.poll(() => page.evaluate(() => document.documentElement.dataset.style)).toBe(uiStyle);
        await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
        await page.evaluate(() => document.fonts.ready);
        const result = await card.evaluate((card) => {
          const details = card.querySelector('.goal-details');
          const summary = card.querySelector('.plan-summary');
          const list = document.querySelector('.thread');
          const canvas = document.createElement('canvas');
          canvas.width = canvas.height = 1;
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          const color = (css) => {
            ctx.clearRect(0, 0, 1, 1);
            ctx.fillStyle = css;
            ctx.fillRect(0, 0, 1, 1);
            return [...ctx.getImageData(0, 0, 1, 1).data].map((v, i) => (i === 3 ? v / 255 : v));
          };
          const over = (a, b) => [0, 1, 2].map((i) => a[i] * a[3] + b[i] * (1 - a[3]));
          const luminance = (rgb) =>
            rgb
              .map((v) => v / 255)
              .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
              .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
          const samples = [];
          const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            if (!node.textContent.trim()) continue;
            const element = node.parentElement;
            const ancestors = [];
            for (let el = element; el; el = el.parentElement) ancestors.unshift(el);
            let bg = [255, 255, 255];
            for (const el of ancestors) bg = over(color(getComputedStyle(el).backgroundColor), bg);
            const fg = over(color(getComputedStyle(element).color), bg);
            const a = luminance(bg),
              b = luminance(fg);
            samples.push({
              text: node.textContent.slice(0, 35),
              ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
            });
          }
          return {
            samples,
            height: details.getBoundingClientRect().height,
            max: innerHeight * 0.4,
            scroll: details.scrollHeight > details.clientHeight,
            ellipsis:
              getComputedStyle(summary).textOverflow === 'ellipsis' &&
              summary.scrollWidth > summary.clientWidth,
            title: summary.title,
            overflow: list.scrollWidth > list.clientWidth + 1,
            cardOverflow: card.scrollWidth > card.clientWidth + 1,
          };
        });
        assert.ok(
          result.height <= result.max + 1 && result.scroll,
          `${uiStyle}/${theme}: details bounded to 40vh`,
        );
        assert.ok(result.ellipsis && result.title.includes(longSteps[1].text));
        assert.ok(!result.overflow && !result.cardOverflow, `${uiStyle}/${theme}: horizontal overflow`);
        assert.ok(result.samples.length > 30);
        assert.ok(
          result.samples.every((sample) => sample.ratio >= 4.5),
          JSON.stringify({ uiStyle, theme, failed: result.samples.filter((sample) => sample.ratio < 4.5) }),
        );
        contrast[`${uiStyle}-${theme}`] = result.samples;
        const screenshot = path.join(output, `plan-${uiStyle}-${theme}.png`);
        await page.screenshot({ path: screenshot });
        screenshots.push(screenshot);
      }
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 760));
    await page.evaluate(() => window.desktop.invoke('saveSettings', { fontScale: 1.3 }));
    assert.ok(await card.evaluate((el) => el.scrollWidth <= el.clientWidth + 1));
    assert.ok(
      await card.locator('.goal-details').evaluate((el) => parseFloat(getComputedStyle(el).fontSize) > 12),
    );
    // Use a fresh conversation for the release image, without the stress-test history.
    await page.evaluate(() =>
      window.desktop.invoke('saveSettings', { fontScale: 1, uiStyle: 'claude', theme: 'light' }),
    );
    const preview = await page.evaluate(
      (projectId) => window.desktop.invoke('newSession', projectId),
      fixture.projectId,
    );
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1200, 900));
    provider.respond(nextPlanSteps);
    await page.evaluate(
      (id) =>
        window.desktop.invoke(
          'send',
          id,
          '检查登录校验，修复空输入问题，再运行回归测试并核对提交。',
          [],
          'steer',
        ),
      preview.id,
    );
    await expect(card).toContainText('步骤 2 / 4');
    await ready();
    await card.getByRole('button', { name: '展开任务计划' }).click();
    await page.mouse.move(20, 100);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: path.join(output, 'plan-release.png') });
    await page.evaluate((id) => window.desktop.invoke('stop', id), preview.id);
    assert.deepEqual(errors, []);
    await fs.writeFile(
      path.join(output, 'plan-ui-result.json'),
      JSON.stringify({ screenshots, contrast, errors }, null, 2),
    );
    console.log(
      'PASS 12 × 4000-character plans, six style/theme contrasts, 40vh scroll, ellipsis, font scaling and narrow layout',
    );
    return { screenshots, contrast };
  } catch (error) {
    const state = await snapshot().catch(() => null);
    await fs.writeFile(path.join(output, 'plan-ui-failure.json'), JSON.stringify(state, null, 2));
    await page?.screenshot({ path: path.join(output, 'plan-ui-failure.png') }).catch(() => {});
    throw error;
  } finally {
    await closeApp(app).catch(() => {});
    await provider.close();
  }
}
