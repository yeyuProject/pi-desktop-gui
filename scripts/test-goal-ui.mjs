import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { prepareRealPiFixture } from '../tests/support/local-provider.ts';
import { createGoalProvider } from '../tests/support/goal-provider.ts';

const provider = await createGoalProvider();
const fixture = await prepareRealPiFixture(provider.baseUrl, 'goal-ui');
const output = path.resolve('test-results');
await fs.mkdir(output, { recursive: true });
let app;
let page;
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
  const createGoal = async (objective, budget = '') => {
    await goalButton.click();
    const editor = page.getByRole('dialog', { name: '新建 Goal', exact: true });
    await editor.getByRole('textbox', { name: '回复内容' }).fill(objective);
    await editor.getByRole('button', { name: '提交回复', exact: true }).click();
    const budgetDialog = page.getByRole('dialog', { name: 'Token 预算（可选）', exact: true });
    await budgetDialog.getByRole('textbox', { name: '回复内容' }).fill(budget);
    await budgetDialog.getByRole('button', { name: '提交回复', exact: true }).click();
  };
  const manageGoal = async (action) => {
    await goalButton.click();
    const menu = page.getByRole('dialog', { name: 'Goal 管理', exact: true });
    await menu.getByRole('radio', { name: action, exact: true }).check();
    await menu.getByRole('button', { name: '提交回复', exact: true }).click();
  };
  const waitIdle = () =>
    page.waitForFunction(
      () => !!document.querySelector('.run-meta .completed, .run-meta .stopped, .run-meta .idle'),
      undefined,
      { timeout: 60000 },
    );

  const preservedDraft = '这段草稿先保留，不要作为 Goal 发送';
  await input.fill('/goal');
  await goalButton.click();
  const cancelled = page.getByRole('dialog', { name: '新建 Goal', exact: true });
  await cancelled.getByRole('button', { name: '取消', exact: true }).click();
  await waitIdle();
  assert.equal(provider.count, 0, 'opening and cancelling Goal must not request the model');
  assert.equal(await input.inputValue(), '/goal', 'even a draft matching the internal command must survive');
  await input.fill(preservedDraft);

  provider.reset('continue');
  await createGoal('核对登录校验的修改和测试结果，并提交完成证据');
  await page.locator('.run-meta .completed').waitFor({ timeout: 60000 });
  await page.locator('.extension-widget').filter({ hasText: '已完成' }).waitFor();
  assert.equal(provider.count, 2);
  assert.equal(await page.locator('.message').filter({ hasText: 'goal_id:' }).count(), 0);
  assert.ok(await page.locator('.tool-card').filter({ hasText: 'desktop_goal_complete' }).count());
  assert.equal(await input.inputValue(), preservedDraft, 'Goal controls must preserve the composer draft');
  await page.screenshot({ path: path.join(output, 'goal-completed.png'), animations: 'disabled' });

  await manageGoal('清除目标');
  await waitIdle();
  await page.locator('.extension-widget').waitFor({ state: 'detached' });
  provider.reset('hold');
  await createGoal('检查修改并保留验证结果，等待进一步确认', '10k');
  await page.locator('.run-meta .running').waitFor({ timeout: 60000 });
  await page.locator('.extension-widget').filter({ hasText: '检查修改并保留验证结果' }).waitFor();
  await page.getByText('GOAL_WAITING_FOR_CANCELLATION', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(output, 'goal-running.png'), animations: 'disabled' });
  await manageGoal('暂停目标');
  await waitIdle();
  await page.locator('.extension-widget').filter({ hasText: '已暂停' }).waitFor();
  assert.equal(provider.count, 1);

  provider.reset('complete');
  await manageGoal('恢复目标');
  await page.locator('.extension-widget').filter({ hasText: '已完成' }).waitFor({ timeout: 60000 });
  await waitIdle();
  assert.equal(provider.count, 1);
  assert.equal(await input.inputValue(), preservedDraft);
  assert.deepEqual(provider.errors, []);
  assert.deepEqual(errors, []);
  console.log(
    'PASS Goal button creation, cancellation, draft preservation, native continuation, pause and resume with real Pi',
  );
} catch (error) {
  await page?.screenshot({ path: path.join(output, 'goal-failure.png'), animations: 'disabled' });
  throw error;
} finally {
  await app?.close().catch(() => {});
  await provider.close();
}
