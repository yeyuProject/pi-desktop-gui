import { launchApp, closeApp } from '../tests/support/desktop-app.mjs';
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
  ({ app, page } = await launchApp({ dataDir: fixture.dataDir, pageTimeout: 10000, errors: errors }));

  const input = page.getByRole('textbox', { name: '任务输入' });
  await input.waitFor();
  const goalButton = page.getByRole('button', { name: 'Goal 目标管理', exact: true });
  const card = page.getByRole('region', { name: 'Goal 状态' });
  const snapshot = () => page.evaluate(() => window.desktop.invoke('bootstrap'));
  const idle = () =>
    expect
      .poll(async () => (await snapshot()).runtime.status, { timeout: 60000 })
      .toMatch(/^(completed|stopped|idle|error)$/);
  const mode = page.getByRole('group', { name: 'Goal 输入模式' });
  const previousResult = page.getByRole('button', { name: '查看上个 Goal 结果', exact: true });
  const createGoal = async (objective, budget) => {
    await goalButton.click();
    await expect(mode).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await input.fill(objective);
    if (budget) {
      await page.getByRole('button', { name: 'Goal 上限', exact: true }).click();
      const picker = page.getByRole('group', { name: 'Goal 上限选择' });
      await picker.getByRole('combobox', { name: 'Goal 用量上限' }).selectOption(budget);
      await picker.getByRole('button', { name: '确定上限' }).click();
    }
    await page.getByRole('button', { name: '开始 Goal', exact: true }).click();
    await expect(mode).toHaveCount(0, { timeout: 60000 });
  };
  const clear = async () => {
    await card.getByRole('button', { name: '清除 Goal', exact: true }).click();
    await expect(card).toHaveCount(0);
    await expect.poll(async () => (await snapshot()).runtime.goal).toBe(null);
  };
  await input.fill('离线目标草稿');
  await goalButton.click();
  await expect(mode).toBeVisible();
  await page.getByRole('button', { name: 'Goal 上限', exact: true }).click();
  await page.getByRole('combobox', { name: 'Goal 用量上限' }).selectOption('500k');
  await page.getByRole('button', { name: '确定上限' }).click();
  await page.getByRole('button', { name: 'Goal 上限', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('group', { name: 'Goal 上限选择' })).toHaveCount(0);
  await expect(mode).toBeVisible();
  const originalSession = (await snapshot()).state.selectedSessionId;
  await page.evaluate(() => window.desktop.invoke('flushDraft'));
  await page.evaluate(() => window.desktop.invoke('newSession'));
  await expect(mode).toHaveCount(0);
  await page.evaluate((id) => window.desktop.invoke('selectSession', id), originalSession);
  await expect(input).toHaveValue('离线目标草稿');
  await expect(mode).toContainText('500k');
  await page.reload();
  await expect(mode).toContainText('500k');
  assert.equal((await snapshot()).runtime.connected, false);
  assert.equal(provider.count, 0);
  await input.focus();
  await page.keyboard.press('Escape');
  await expect(mode).toHaveCount(0);
  await expect(input).toHaveValue('离线目标草稿');
  await input.fill('/goal --tokens 2m 预览目标');
  await expect(mode).toContainText('2m');
  await page.getByRole('button', { name: 'Goal 上限', exact: true }).click();
  await page.getByRole('combobox', { name: 'Goal 用量上限' }).selectOption('500k');
  await page.getByRole('button', { name: '确定上限' }).click();
  await expect(input).toHaveValue('/goal --tokens 500000 预览目标');
  await input.focus();
  await page.keyboard.press('Escape');
  await expect(input).toHaveValue('预览目标');
  await expect(mode).toHaveCount(0);
  await input.fill('/goal');
  await input.press('Enter');
  await expect(mode).toBeVisible();
  await expect(input).toHaveValue('');
  await page.getByRole('button', { name: '退出 Goal 模式' }).click();
  assert.equal(provider.count, 0);
  const preservedDraft = '编辑前草稿与附件必须完整恢复';
  provider.reset('continue');
  await createGoal('核对登录校验的修改和测试结果，并提交完成证据');
  await expect(card).toHaveClass(/completed/, { timeout: 60000 });
  await idle();
  assert.equal(provider.count, 2);
  await expect(page.locator('.goal-message-badge')).toHaveCount(1);
  await expect(page.locator('.extension-widget')).toHaveCount(0);
  assert.equal(await page.locator('.message').filter({ hasText: 'goal_id:' }).count(), 0);
  await expect(card).toContainText('Goal 已完成');
  assert.ok(!((await page.locator('.composer-bottom').textContent()) ?? '').includes('Goal：已完成'));
  await page.mouse.move(1, 1);
  await expect(card).toHaveCount(0, { timeout: 11000 });
  await expect(previousResult.locator('.goal-completed-dot')).toHaveCount(1);
  await previousResult.click();
  await expect(card.locator('.goal-details')).toBeVisible();
  const dimensions = await card.evaluate((element) => ({
    bar: element.querySelector('.goal-bar').getBoundingClientRect().height,
    details: element.querySelector('.goal-details').getBoundingClientRect().height,
    max: window.innerHeight * 0.4,
  }));
  assert.ok(dimensions.bar <= 36 && dimensions.details <= dimensions.max + 1);
  assert.ok(
    await card.locator('.goal-details').evaluate((element) => element.scrollHeight > element.clientHeight),
  );
  await expect(card.locator('.goal-usage')).toContainText('不含缓存命中');
  const titled = await snapshot();
  assert.equal(
    titled.state.sessions.find((session) => session.id === titled.state.selectedSessionId).title,
    '核对登录校验的修改和测试结果，并提交完成证据',
  );
  await card.getByRole('button', { name: '跳到结果' }).click();
  await expect(page.locator('.thread .turn-jump-highlight')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(card.locator('.goal-details')).toHaveCount(0);
  await page.screenshot({ path: path.join(output, 'goal-completed.png'), animations: 'disabled' });
  await previousResult.click();
  await page.reload();
  await input.waitFor();
  await expect(previousResult.locator('.goal-completed-dot')).toHaveCount(1);
  await expect(card).toHaveCount(0);
  await expect(page.locator('.goal-message-badge')).toHaveCount(1);
  await previousResult.click();
  await clear();
  provider.reset('hold');
  await createGoal('检查修改并保留验证结果，等待进一步确认');
  await page.getByText('GOAL_WAITING_FOR_CANCELLATION', { exact: true }).waitFor({ timeout: 60000 });
  await expect(card).toHaveClass(/active/);
  await expect(card.locator('.goal-bar')).toContainText('用时');
  await expect(card.locator('.goal-bar')).not.toContainText('续跑');
  await expect(card.locator('.goal-bar')).not.toContainText(/tokens|Token/);
  assert.ok((await card.locator('.goal-bar').boundingBox()).height <= 36);
  await page.screenshot({ path: path.join(output, 'goal-running.png'), animations: 'disabled' });
  const originalId = (await snapshot()).runtime.goal.id;
  const replacing = page.evaluate(async () => {
    const value = await window.desktop.invoke('bootstrap');
    return window.desktop.invoke('goalAction', value.state.selectedSessionId, {
      action: 'start',
      objective: '不要替换原目标',
    });
  });
  const replacement = page.getByRole('dialog', { name: '替换当前 Goal？', exact: true });
  await expect(replacement).toContainText('已完成的修改保留');
  await replacement.getByRole('button', { name: '取消', exact: true }).click();
  await replacing;
  console.log('PASS active replacement cancellation preserves the Goal');
  assert.equal((await snapshot()).runtime.goal.id, originalId);
  await input.fill(preservedDraft);
  await page.evaluate(async () => {
    const { state } = await window.desktop.invoke('bootstrap');
    const session = state.sessions.find((s) => s.id === state.selectedSessionId);
    await window.desktop.invoke(
      'saveDraft',
      session.id,
      session.draft,
      ['输入 文件.txt'],
      [],
      [{ id: 'kept-piece', text: '保留片段', offset: session.draft.length }],
      [
        {
          id: 'kept-quote',
          text: '保留引用',
          role: 'assistant',
          turn: 1,
          messageTimestamp: 1,
          section: 'text',
        },
      ],
    );
    await window.desktop.invoke('flushDraft');
  });
  await card.getByRole('button', { name: '编辑目标', exact: true }).first().click();
  await input.fill('未保存的编辑缓冲区');
  await page.evaluate(() => window.desktop.invoke('flushDraft'));
  const editorSession = (await snapshot()).state.selectedSessionId;
  await page.evaluate(() => window.desktop.invoke('newSession'));
  await expect(mode).toHaveCount(0);
  await page.evaluate((id) => window.desktop.invoke('selectSession', id), editorSession);
  await expect(input).toHaveValue('未保存的编辑缓冲区');
  await page.reload();
  await expect(input).toHaveValue('未保存的编辑缓冲区');
  await page.getByRole('button', { name: '取消修改目标' }).click();
  await expect(input).toHaveValue(preservedDraft);
  await expect(page.locator('.pasted-snippets')).toContainText('粘贴片段');
  await expect(page.locator('.draft-quotes')).toContainText('保留引用');
  await card.getByRole('button', { name: '编辑目标', exact: true }).first().click();
  await input.fill('过期编辑仍要保留');
  await page.evaluate(async () => {
    const value = await window.desktop.invoke('bootstrap');
    await window.desktop.invoke('goalAction', value.state.selectedSessionId, {
      action: 'edit',
      goalId: value.runtime.goal.id,
      revision: value.runtime.goal.revision,
      objective: '别处已修改的目标',
    });
  });
  await page.getByRole('button', { name: '保存修改', exact: true }).click();
  await expect(page.getByText('Goal 已变化，请重新打开编辑目标。', { exact: false }).first()).toBeVisible();
  await expect(input).toHaveValue('过期编辑仍要保留');
  await page.getByRole('button', { name: '取消修改目标' }).click();
  await card.getByRole('button', { name: '编辑目标', exact: true }).first().click();
  await input.fill('x'.repeat(4001));
  await expect(page.getByRole('button', { name: '保存修改', exact: true })).toBeDisabled();
  await expect(mode).toContainText('目标超过 4000 字');
  await input.fill('修改后的目标仍然需要完成验证');
  await page.getByRole('button', { name: '保存修改', exact: true }).click();
  await expect(mode).toHaveCount(0);
  await expect(input).toHaveValue(preservedDraft);
  await expect(page.locator('.draft-quotes')).toContainText('保留引用');
  await page.evaluate(async () => {
    const { state } = await window.desktop.invoke('bootstrap');
    await window.desktop.invoke('saveDraft', state.selectedSessionId, '', [], [], [], []);
    await window.desktop.invoke('flushDraft');
  });
  console.log('PASS active editing and objective length validation');
  assert.equal((await snapshot()).runtime.goal.revision, 3);
  await card.getByRole('button', { name: '暂停', exact: true }).click();
  await idle();
  await expect(card).toHaveClass(/paused/);
  await card.getByRole('button', { name: '清除 Goal', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: '清除 Goal？', exact: true });
  await expect(confirm).toContainText('清除后不再自动继续，已完成的修改保留');
  await confirm.getByRole('button', { name: '取消', exact: true }).click();
  console.log('PASS clear cancellation');
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
  await expect(card).toHaveClass(/budget_limited/, { timeout: 60000 });
  await idle();
  await card.getByRole('button', { name: '调整上限并继续', exact: true }).click();
  const budget = page.getByRole('group', { name: 'Goal 上限选择', exact: true });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(budget.locator('.goal-budget-estimate')).toContainText('预计可执行');
  await expect(budget.locator('.goal-budget-help')).toHaveAttribute('title', /平均每次请求约/);
  await budget.getByRole('combobox', { name: 'Goal 用量上限' }).selectOption('2m');
  provider.reset('complete');
  await budget.getByRole('button', { name: '调整并继续', exact: true }).click();
  await expect(card).toHaveClass(/completed/, { timeout: 60000 });
  await idle();
  assert.equal((await snapshot()).runtime.goal.tokenBudget, 2000000);
  assert.equal(await input.inputValue(), '');
  await clear();
  provider.reset('plan');
  await createGoal('执行三步计划并显示当前步骤');
  await expect(card.locator('.goal-bar')).toContainText('步骤 2 / 3');
  await goalButton.click();
  await expect(card.getByRole('list', { name: 'Goal 计划' })).toContainText('实现并验证');
  await card.getByRole('button', { name: '收起 Goal 详情' }).click();
  await page.evaluate(async () => {
    const value = await window.desktop.invoke('bootstrap');
    return window.desktop.invoke('openGoal', value.state.selectedSessionId);
  });
  await expect(card.locator('.goal-details')).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Goal 管理' })).toHaveCount(0);
  const slashEdit = page.evaluate(async () => {
    const value = await window.desktop.invoke('bootstrap');
    return window.desktop.invoke('send', value.state.selectedSessionId, '/goal edit', [], 'steer', []);
  });
  await expect(input).toHaveValue('执行三步计划并显示当前步骤');
  await input.fill('通过命令修改后的目标');
  await page.getByRole('button', { name: '保存修改' }).click();
  await slashEdit;
  assert.equal((await snapshot()).runtime.goal.objective, '通过命令修改后的目标');
  const beforeReplacement = (await snapshot()).runtime.goal.id;
  const acceptedReplacement = page.evaluate(async () => {
    const value = await window.desktop.invoke('bootstrap');
    return window.desktop.invoke('goalAction', value.state.selectedSessionId, {
      action: 'start',
      objective: '确认替换后的新目标',
    });
  });
  const acceptDialog = page.getByRole('dialog', { name: '替换当前 Goal？', exact: true });
  await expect(acceptDialog).toBeVisible();
  provider.reset('complete');
  await acceptDialog.getByRole('button', { name: '确认', exact: true }).click();
  await acceptedReplacement;
  await expect(card).toHaveClass(/completed/);
  await idle();
  assert.notEqual((await snapshot()).runtime.goal.id, beforeReplacement);
  assert.equal((await snapshot()).runtime.goal.objective, '确认替换后的新目标');
  console.log('PASS slash edit and confirmed replacement during a running Goal');
  await clear();
  provider.reset('quota');
  await createGoal('显示额度不足和设置入口');
  await expect(card).toHaveClass(/usage_limited/, { timeout: 60000 });
  await idle();
  await expect(card.getByRole('button', { name: '打开服务商设置' })).toBeVisible();
  await card.getByRole('button', { name: '打开服务商设置' }).click();
  await expect(page.getByRole('textbox', { name: '筛选供应商' })).toBeVisible();
  await page.keyboard.press('Escape');
  provider.reset('complete');
  await card.getByRole('button', { name: '继续', exact: true }).click();
  await expect(card).toHaveClass(/completed/);
  await idle();
  assert.deepEqual(provider.errors, []);
  assert.deepEqual(errors, []);
  const oldSession = (await snapshot()).state.selectedSessionId;
  await page.evaluate(() => window.desktop.invoke('newSession'));
  await page.evaluate((id) => window.desktop.invoke('selectSession', id), oldSession);
  await expect(previousResult.locator('.goal-completed-dot')).toHaveCount(1);
  await expect(card).toHaveCount(0);
  const requestCount = provider.requests.length;
  const legacySnapshot = await snapshot();
  const legacyGoal = legacySnapshot.runtime.goal;
  const legacyFile = legacySnapshot.state.sessions.find((session) => session.id === oldSession).file;
  await app.close();
  const legacyRows = (await fs.readFile(legacyFile, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const resultRow = legacyRows.findLast(
    (row) => row.message?.role === 'toolResult' && row.message?.details?.id === legacyGoal.id,
  );
  assert.ok(resultRow);
  resultRow.message.toolName = 'desktop_goal_complete';
  const callId = resultRow.message.toolCallId;
  for (const row of legacyRows) {
    if (row.message?.role !== 'assistant') continue;
    for (const block of row.message.content ?? [])
      if (block.type === 'toolCall' && block.id === callId) block.name = 'desktop_goal_complete';
  }
  legacyRows.push({
    type: 'custom',
    customType: 'desktop-goal',
    id: 'legacy-fixture',
    parentId: legacyRows.at(-1).id,
    timestamp: new Date().toISOString(),
    data: {
      version: 1,
      id: legacyGoal.id,
      objective: legacyGoal.objective,
      status: 'completed',
      tokensUsed: legacyGoal.tokensUsed,
      continuations: 1,
      noToolRuns: 0,
      createdAt: legacyGoal.createdAt,
      updatedAt: legacyGoal.updatedAt,
      summary: '旧版已完成结果',
      evidence: '**旧版验证证据保留**',
    },
  });
  await fs.writeFile(legacyFile, legacyRows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  ({ app, page } = await launchApp({ dataDir: fixture.dataDir }));
  const restoredGoalButton = page.getByRole('button', { name: '查看上个 Goal 结果', exact: true });
  await expect(restoredGoalButton.locator('.goal-completed-dot')).toHaveCount(1);
  await expect(page.getByRole('region', { name: 'Goal 状态' })).toHaveCount(0);
  assert.equal((await page.evaluate(() => window.desktop.invoke('bootstrap'))).runtime.connected, false);
  await restoredGoalButton.click();
  const restoredCard = page.getByRole('region', { name: 'Goal 状态' });
  await expect(restoredCard).toContainText('旧版验证证据保留');
  await expect(restoredCard).toContainText('用量可能偏大');
  await expect(restoredCard).toContainText('用时 —');
  await restoredCard.getByRole('button', { name: '跳到结果' }).click();
  await expect(page.locator('.thread .turn-jump-highlight')).toHaveCount(1);
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
    'PASS G2 states, editing, replacement, plans, quota settings, title, budget resume, restored dot and result navigation with real Pi',
  );
} catch (error) {
  await fs.writeFile(path.join(output, 'goal-ui-provider.json'), JSON.stringify(provider.requests, null, 2));
  await page?.screenshot({ path: path.join(output, 'goal-failure.png'), animations: 'disabled' });
  throw error;
} finally {
  await provider.close();
  await app?.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await closeApp(app).catch(() => {});
}
