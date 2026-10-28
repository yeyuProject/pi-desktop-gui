import { _electron as electron } from 'playwright';
import { expect } from 'playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { prepareRealPiFixture } from '../tests/support/local-provider.ts';
import { createGoalProvider } from '../tests/support/goal-provider.ts';

const provider = await createGoalProvider();
const fixture = await prepareRealPiFixture(provider.baseUrl, 'goal-ui');
const output = path.resolve('test-results');
await fs.mkdir(output, { recursive: true });
let app, page;
const errors = [];
try {
  app = await electron.launch({
    args: [path.resolve('.')],
    env: { ...process.env, PI_DESKTOP_DATA_DIR: fixture.dataDir, PI_OFFLINE: '1' },
    timeout: 30000,
  });
  page = await app.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  const input = page.getByRole('textbox', { name: '任务输入' });
  await input.waitFor();
  const goalButton = page.getByRole('button', { name: 'Goal 目标管理', exact: true });
  const card = page.getByRole('region', { name: 'Goal 状态' });
  const snapshot = () => page.evaluate(() => window.desktop.invoke('bootstrap'));
  const idle = () =>
    expect
      .poll(async () => (await snapshot()).runtime.status, { timeout: 60000 })
      .toMatch(/^(completed|stopped|idle)$/);
  const createGoal = async (objective, budget) => {
    await goalButton.click();
    const dialog = page.getByRole('dialog', { name: '新建 Goal', exact: true });
    assert.equal(await dialog.locator('details').getAttribute('open'), null);
    await dialog.getByRole('textbox', { name: 'Goal 目标' }).fill(objective);
    if (budget) {
      await dialog.locator('summary').click();
      await dialog.getByRole('combobox', { name: 'Goal 用量上限' }).selectOption(budget);
    }
    await dialog.getByRole('button', { name: '开始 Goal', exact: true }).click();
    await expect(dialog).toHaveCount(0);
  };
  const clear = async () => {
    await card.getByRole('button', { name: '清除 Goal', exact: true }).click();
    await expect(card).toHaveCount(0);
    await expect.poll(async () => (await snapshot()).runtime.goal).toBe(null);
  };
  await input.fill('/goal');
  await goalButton.click();
  await page
    .getByRole('dialog', { name: '新建 Goal', exact: true })
    .getByRole('button', { name: '取消', exact: true })
    .click();
  await idle();
  assert.equal(provider.count, 0);
  assert.equal(await input.inputValue(), '/goal');
  const preservedDraft = '这段草稿先保留，不要作为 Goal 发送';
  await input.fill(preservedDraft);
  provider.reset('continue');
  await createGoal('核对登录校验的修改和测试结果，并提交完成证据');
  await expect(card).toHaveClass(/completed/, { timeout: 60000 });
  await idle();
  assert.equal(provider.count, 2);
  await expect(page.locator('.extension-widget')).toHaveCount(0);
  assert.equal(await page.locator('.message').filter({ hasText: 'goal_id:' }).count(), 0);
  await expect(card).toContainText('Goal 已完成');
  assert.ok(!((await page.locator('.composer-bottom').textContent()) ?? '').includes('Goal：已完成'));
  await page.mouse.move(1, 1);
  await expect(card).toHaveCount(0, { timeout: 11000 });
  await expect(goalButton.locator('.goal-completed-dot')).toHaveCount(1);
  await goalButton.click();
  await expect(card.locator('.goal-details')).toBeVisible();
  const dimensions = await card.evaluate((element) => {
    const details = element.querySelector('.goal-details'),
      evidence = element.querySelector('.goal-evidence');
    return {
      bar: element.querySelector('.goal-bar').getBoundingClientRect().height,
      details: details.getBoundingClientRect().height,
      max: window.innerHeight * 0.4,
      evidence: evidence.getBoundingClientRect().height,
      six: parseFloat(getComputedStyle(evidence).lineHeight) * 6,
    };
  });
  assert.ok(
    dimensions.bar <= 36 &&
      dimensions.details <= dimensions.max + 1 &&
      dimensions.evidence <= dimensions.six + 1,
  );
  await card.getByRole('button', { name: '展开全部证据' }).click();
  assert.ok(
    await card.locator('.goal-details').evaluate((element) => element.scrollHeight > element.clientHeight),
  );
  await card.getByRole('button', { name: '跳到结果' }).click();
  await expect(page.locator('.thread .turn-jump-highlight')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(card.locator('.goal-details')).toHaveCount(0);
  await page.screenshot({ path: path.join(output, 'goal-completed.png'), animations: 'disabled' });
  await goalButton.click();
  await page.reload();
  await input.waitFor();
  await expect(goalButton.locator('.goal-completed-dot')).toHaveCount(1);
  await expect(card).toHaveCount(0);
  await goalButton.click();
  await clear();
  provider.reset('hold');
  await createGoal('检查修改并保留验证结果，等待进一步确认');
  await page.getByText('GOAL_WAITING_FOR_CANCELLATION', { exact: true }).waitFor({ timeout: 60000 });
  await expect(card).toHaveClass(/active/);
  await expect(card.locator('.goal-bar')).toContainText('第 0 / 25 次续跑');
  await expect(card.locator('.goal-bar')).not.toContainText(/tokens|Token/);
  assert.ok((await card.locator('.goal-bar').boundingBox()).height <= 36);
  await page.screenshot({ path: path.join(output, 'goal-running.png'), animations: 'disabled' });
  await card.getByRole('button', { name: '暂停', exact: true }).click();
  await idle();
  await expect(card).toHaveClass(/paused/);
  await card.getByRole('button', { name: '清除 Goal', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: '清除 Goal？', exact: true });
  await expect(confirm).toContainText('清除后不再自动继续，已完成的修改保留');
  await confirm.getByRole('button', { name: '取消', exact: true }).click();
  provider.reset('complete');
  await card.getByRole('button', { name: '继续', exact: true }).click();
  await expect(card).toHaveClass(/completed/, { timeout: 60000 });
  await idle();
  await clear();
  provider.reset('blocked');
  await createGoal('保留阻碍与检查证据');
  await expect(card).toHaveClass(/blocked/, { timeout: 60000 });
  await idle();
  provider.reset('complete');
  await card.getByRole('button', { name: '继续', exact: true }).click();
  await expect(card).toHaveClass(/completed/, { timeout: 60000 });
  await idle();
  await clear();
  provider.reset('budget-ui');
  await createGoal('达到上限后暂停，调整上限再继续', '500k');
  await expect(card).toHaveClass(/paused/, { timeout: 60000 });
  await idle();
  await card.getByRole('button', { name: '调整上限并继续', exact: true }).click();
  const budget = page.getByRole('dialog', { name: '调整上限并继续', exact: true });
  await expect(budget.locator('details')).toHaveAttribute('open', '');
  await expect(budget).toContainText('平均每次请求约');
  await budget.getByRole('combobox', { name: 'Goal 用量上限' }).selectOption('2m');
  provider.reset('complete');
  await budget.getByRole('button', { name: '调整并继续', exact: true }).click();
  await expect(card).toHaveClass(/completed/, { timeout: 60000 });
  await idle();
  assert.equal((await snapshot()).runtime.goal.tokenBudget, 2000000);
  assert.equal(await input.inputValue(), preservedDraft);
  assert.deepEqual(provider.errors, []);
  assert.deepEqual(errors, []);
  const oldSession = (await snapshot()).state.selectedSessionId;
  await page.evaluate(() => window.desktop.invoke('newSession'));
  await page.evaluate((id) => window.desktop.invoke('selectSession', id), oldSession);
  await expect(goalButton.locator('.goal-completed-dot')).toHaveCount(1);
  await expect(card).toHaveCount(0);
  const requestCount = provider.requests.length;
  await app.close();
  app = await electron.launch({
    args: [path.resolve('.')],
    env: { ...process.env, PI_DESKTOP_DATA_DIR: fixture.dataDir, PI_OFFLINE: '1' },
    timeout: 30000,
  });
  page = await app.firstWindow();
  const restoredGoalButton = page.getByRole('button', { name: 'Goal 目标管理', exact: true });
  await expect(restoredGoalButton.locator('.goal-completed-dot')).toHaveCount(1);
  await expect(page.getByRole('region', { name: 'Goal 状态' })).toHaveCount(0);
  assert.equal((await page.evaluate(() => window.desktop.invoke('bootstrap'))).runtime.connected, false);
  await restoredGoalButton.click();
  await page
    .getByRole('region', { name: 'Goal 状态' })
    .getByRole('button', { name: '清除 Goal', exact: true })
    .click();
  await expect(page.getByRole('region', { name: 'Goal 状态' })).toHaveCount(0);
  assert.equal(
    provider.requests.length,
    requestCount,
    'restoring, viewing and clearing a completed Goal must not request the model',
  );
  console.log(
    'PASS G1 states, compact bar, eight-second collapse, restored dot, bounded Markdown details, result jump, clear confirmation and optional budget resume with real Pi',
  );
} catch (error) {
  await page?.screenshot({ path: path.join(output, 'goal-failure.png'), animations: 'disabled' });
  throw error;
} finally {
  await provider.close();
  await app?.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await app?.close().catch(() => {});
}
