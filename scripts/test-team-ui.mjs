import { launchApp, closeApp } from '../tests/support/desktop-app.mjs';
import { expect } from 'playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { Store } from '../electron/store.ts';
import { packagedExecutable, unregisterMacTestApp } from './mac-builds.mjs';
import { prepareRealPiFixture } from '../tests/support/local-provider.ts';
import { createTeamProvider } from '../tests/support/team-provider.ts';
const executablePath =
  process.env.PI_DESKTOP_EXE ?? (process.argv.includes('--packaged') ? packagedExecutable() : undefined);
const provider = await createTeamProvider();
const fixture = await prepareRealPiFixture(provider.baseUrl, 'team-ui');
const id = fixture.sessionId;
fixture.store.session(id).teamEnabled = true;
fixture.store.session(id).approvalMode = 'confirm';
fixture.store.state.settings.team.concurrency = 2;
await fixture.store.save();
let app, page;
const errors = [];
try {
  ({ app, page } = await launchApp({
    executablePath,
    dataDir: fixture.dataDir,
    errors,
  }));
  await page.getByRole('textbox', { name: '任务输入' }).waitFor();
  await page.bringToFront();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 960));
  const invoke = (method, ...args) =>
    page.evaluate(({ method, args }) => window.desktop.invoke(method, ...args), { method, args });
  const ready = (count) => expect.poll(() => provider.pending.length, { timeout: 30000 }).toBe(count);
  const screenshots = async (state) => {
    for (const uiStyle of ['classic', 'codex', 'claude']) {
      await invoke('saveSettings', { uiStyle });
      await expect.poll(() => page.evaluate(() => document.documentElement.dataset.style)).toBe(uiStyle);
      await page.screenshot({ path: `test-results/team-${state}-${uiStyle}.png` });
    }
  };
  const notificationsSupported = await app.evaluate(({ Notification }) => {
    globalThis.teamNotifications = [];
    Notification.prototype.show = function () {
      globalThis.teamNotifications.push({ title: this.title, body: this.body });
    };
    return Notification.isSupported();
  });
  // Role management is local: editing a file must not request a model.
  await page.getByRole('button', { name: 'Pi 功能', exact: true }).click();
  const features = page.getByRole('dialog', { name: 'Pi 功能', exact: true });
  await features.getByRole('button', { name: '角色', exact: true }).click();
  await features.getByRole('button', { name: '新建角色', exact: true }).click();
  await features.getByRole('textbox', { name: '角色名', exact: true }).fill('ui-role');
  await features
    .getByRole('textbox', { name: 'Markdown 与 YAML', exact: true })
    .fill('---\nname: ui-role\ndescription: UI 角色验收\ntools: read, grep, find, ls\n---\n只读汇报。');
  await features.getByRole('button', { name: '保存', exact: true }).click();
  const resource = features.locator('.resource-item').filter({ hasText: 'ui-role' });
  await resource.getByRole('button', { name: '编辑', exact: true }).click();
  await features.getByRole('button', { name: '删除角色', exact: true }).click();
  await features.getByRole('button', { name: '取消', exact: true }).click();
  await features.getByRole('button', { name: '删除角色', exact: true }).click();
  await features.getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(resource).toHaveCount(0);
  await page.keyboard.press('Escape');
  assert.equal(provider.requests.length, 0);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+,' : 'Control+,');
  const settings = page.getByRole('dialog', { name: '设置', exact: true });
  await settings.getByRole('button', { name: '团队', exact: true }).click();
  await expect(settings.getByRole('combobox', { name: '并行上限', exact: true })).toHaveValue('2');
  await expect(settings.getByRole('combobox', { name: '单个成员用量上限', exact: true })).toHaveValue(
    '1000000',
  );
  await expect(settings.getByRole('combobox', { name: '成员默认模型', exact: true })).toHaveValue('');
  await settings.getByRole('button', { name: '关闭', exact: true }).last().click();
  await expect(settings).toHaveCount(0);
  await invoke('send', id, '验证团队卡和成员审批', [], 'steer');
  await ready(1);
  provider.reply(provider.pending[0], {
    name: 'desktop_team_dispatch',
    args: {
      members: [
        { name: '实现接口', task: '写入 team-ui.txt 并汇报' },
        { name: '调研测试', role: 'scout', task: '调查测试并汇报' },
        { name: '审查代码', role: 'reviewer', task: '审查结果并汇报' },
      ],
    },
  });
  await ready(2);
  const card = page.getByRole('region', { name: '团队卡', exact: true });
  await expect(card).toBeVisible();
  await expect(card).toContainText('等待空位');
  await expect(page.locator('.team-strip')).toContainText('团队 2/3 运行中 · 1 排队中');
  assert.equal(await card.evaluate((node) => getComputedStyle(node).borderTopWidth), '1px');
  await expect(page.locator('.run-meta')).toContainText('等待成员 0/3');
  await card.locator('.team-member-row').first().click();
  await expect(card).toContainText('任务：');
  await card.locator('.team-member-row').first().focus();
  await page.keyboard.press('Space');
  await expect(card.locator('.team-member-row').first()).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press('Enter');
  await expect(card.locator('.team-member-row').first()).toHaveAttribute('aria-expanded', 'true');
  await fs.mkdir('test-results', { recursive: true });
  await screenshots('running');
  await screenshots('expanded');
  await screenshots('strip');
  const writerRequest = provider.pending.find((index) =>
    JSON.stringify(provider.requests[index].messages).includes('实现接口'),
  );
  assert.notEqual(writerRequest, undefined);
  await invoke('newSession');
  provider.reply(writerRequest, { name: 'write', args: { path: 'team-ui.txt', content: '成员审批测试\n' } });
  if (notificationsSupported)
    await expect
      .poll(() => app.evaluate(() => globalThis.teamNotifications), { timeout: 30000 })
      .toEqual([{ title: '成员需要确认 · 验证团队卡和成员审批', body: '实现接口 · 写入 team-ui.txt' }]);
  await invoke('selectSession', id);
  const approval = page.locator('.approval-card');
  await expect(approval).toContainText('成员 · 实现接口');
  await expect(page.locator('.team-strip')).toContainText('实现接口 · 等待确认');
  await expect(card.locator('.team-member.waiting')).toContainText('team-ui.txt');
  await expect(approval.getByRole('button', { name: '此成员总是允许', exact: true })).toBeVisible();
  await screenshots('approval');
  const memberState = (await invoke('bootstrap')).state;
  const writer = memberState.sessions.find((s) => s.team?.name === '实现接口');
  await approval.getByRole('button', { name: '在成员中查看', exact: true }).click();
  await expect(page.locator('.team-banner')).toContainText('返回负责人');
  await expect(approval).toBeVisible();
  await page.getByRole('button', { name: '返回负责人', exact: true }).click();
  await approval.getByRole('button', { name: '此成员总是允许', exact: true }).click();
  await expect(approval).toHaveCount(0);
  assert.equal((await invoke('bootstrap')).runtime.approvalGrants?.length ?? 0, 0);
  await invoke('selectSession', writer.id);
  await expect(approval).toHaveCount(0);
  assert.equal((await invoke('bootstrap')).runtime.approvalGrants.length, 1);
  await invoke('selectSession', id);
  await ready(2);
  const writerReport = provider.pending.find((index) =>
    JSON.stringify(provider.requests[index].messages).includes('实现接口'),
  );
  provider.reply(
    writerReport,
    '实现汇报：验证成功。\n' + Array.from({ length: 45 }, (_, i) => `检查项 ${i}`).join('\n'),
  );
  await expect.poll(() => provider.requests.length, { timeout: 30000 }).toBeGreaterThan(writerReport + 1);
  await ready(2);
  for (const index of provider.pending)
    provider.reply(index, '独立成员汇报：发现唯一搜索词 TEAM_REPORT_MATCH。');
  await ready(1);
  provider.reply(provider.pending[0], '负责人已核对所有汇报。');
  await expect
    .poll(async () => (await invoke('bootstrap')).runtime.status, { timeout: 30000 })
    .toBe('completed');
  await expect(page.locator('.team-strip')).toHaveCount(0);
  await screenshots('done');
  if (notificationsSupported)
    assert.equal(
      (await app.evaluate(() => globalThis.teamNotifications)).length,
      1,
      'members do not notify on completion',
    );
  await expect(card.locator('.team-member')).toHaveCount(0);
  await card.locator('header button').first().click();
  if ((await card.locator('.team-member-row').first().getAttribute('aria-expanded')) !== 'true')
    await card.locator('.team-member-row').first().click();
  await card.getByRole('button', { name: '查看汇报', exact: true }).first().click();
  await expect(card).toContainText('展开全文');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+f' : 'Control+f');
  await page.getByRole('textbox', { name: '查找当前会话', exact: true }).fill('TEAM_REPORT_MATCH');
  await expect(card).toContainText('TEAM_REPORT_MATCH');
  await page.getByRole('button', { name: '关闭会话查找' }).click();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 900));
  await expect.poll(() => card.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  await screenshots('narrow');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1.5));
  await expect.poll(() => card.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1));
  await invoke('saveDraft', id, '保留负责人的草稿', []);
  await invoke('selectSession', writer.id);
  await expect(page.locator('.team-banner')).toContainText('之后的对话不会自动同步给负责人');
  await page.getByRole('button', { name: '引用到负责人', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '任务输入' })).toHaveValue('保留负责人的草稿');
  const quoted = (await invoke('bootstrap')).state.sessions.find((s) => s.id === id);
  assert.match(quoted.draftQuotes.at(-1).text, /实现汇报/);
  await invoke('branchSession', id, 'clone');
  await expect(card).toBeVisible();
  await expect(card.getByRole('button', { name: '全部停止', exact: true })).toHaveCount(0);
  await invoke('selectSession', id);
  await invoke('flushDraft');
  await closeApp(app);
  app = undefined;
  ({ app, page } = await launchApp({
    executablePath,
    dataDir: fixture.dataDir,
    errors,
  }));
  await page.getByRole('region', { name: '团队卡', exact: true }).waitFor();
  const restoredCard = page.getByRole('region', { name: '团队卡', exact: true });
  await expect(restoredCard.locator('.team-member-row').first()).toHaveAttribute('aria-expanded', 'true');
  assert.equal((await invoke('bootstrap')).runtime.connected, false);
  await invoke('connect', id);
  await invoke('send', id, '验证中断恢复', [], 'steer');
  await ready(1);
  provider.reply(provider.pending[0], {
    name: 'desktop_team_dispatch',
    args: { members: [{ name: '中断成员', role: 'scout', task: '等待停止' }] },
  });
  await ready(1);
  await expect(page.locator('.team-strip')).toBeVisible();
  await invoke('flushDraft');
  const running = await invoke('bootstrap');
  await page.locator('.team-strip button').click();
  await expect(
    page.getByRole('region', { name: '团队卡', exact: true }).last().locator('.team-member-row'),
  ).toHaveAttribute('aria-expanded', 'true');
  await page
    .getByRole('region', { name: '团队卡', exact: true })
    .last()
    .getByRole('button', { name: '全部停止', exact: true })
    .click();
  await expect
    .poll(
      () =>
        provider.pending.length === 1 &&
        provider.requests[provider.pending[0]].tools.some((t) => t.function.name === 'desktop_team_dispatch'),
      { timeout: 30000 },
    )
    .toBe(true);
  provider.reply(provider.pending[0], '已停止成员并继续本回合。');
  await expect
    .poll(async () => (await invoke('bootstrap')).runtime.status, { timeout: 30000 })
    .toBe('completed');
  await expect(
    page.getByRole('region', { name: '团队卡', exact: true }).last().locator('.team-member'),
  ).toHaveCount(0);
  await closeApp(app);
  app = undefined;
  // Reproduce a crash after the call persisted but before its tool result. Keep
  // the real Pi transcript and member files, remove only that unfinished result.
  const leadFile = running.state.sessions.find((s) => s.id === id).file;
  const records = (await fs.readFile(leadFile, 'utf8')).trim().split('\n').map(JSON.parse);
  const interruptedCall = records
    .flatMap((e) => (e.message?.role === 'assistant' ? (e.message.content ?? []) : []))
    .findLast((b) => b.type === 'toolCall' && b.name === 'desktop_team_dispatch');
  const resultIndex = records.findIndex(
    (e) => e.message?.role === 'toolResult' && e.message.toolCallId === interruptedCall.id,
  );
  if (resultIndex >= 0)
    await fs.writeFile(
      leadFile,
      records
        .slice(0, resultIndex)
        .map((e) => JSON.stringify(e))
        .join('\n') + '\n',
    );
  const recoveredStore = new Store(fixture.dataDir);
  await recoveredStore.load();
  for (const session of recoveredStore.state.sessions)
    if (session.team?.name === '中断成员') session.team.status = 'running';
  await recoveredStore.save();
  ({ app, page } = await launchApp({
    executablePath,
    dataDir: fixture.dataDir,
    errors,
  }));
  await expect(page.getByRole('region', { name: '团队卡', exact: true }).last()).toContainText('已中断');
  assert.equal(provider.pending.length, 0);
  assert.equal((await invoke('bootstrap')).runtime.connected, false);
  await invoke('connect', id);
  await invoke('send', id, '验证失败成员和单个停止', [], 'steer');
  await ready(1);
  provider.reply(provider.pending[0], {
    name: 'desktop_team_dispatch',
    args: {
      members: [
        { name: '凭据失败', role: 'scout', task: '验证模型错误' },
        { name: '单独停止', role: 'scout', task: '等待单个停止' },
      ],
    },
  });
  await ready(2);
  const failedRequest = provider.pending.find((index) =>
    JSON.stringify(provider.requests[index].messages).includes('凭据失败'),
  );
  provider.fail(failedRequest);
  const failureCard = page.getByRole('region', { name: '团队卡', exact: true }).last();
  await expect(failureCard).toContainText('供应商拒绝了凭据');
  const failedRow = failureCard.locator('.team-member.failed');
  await expect(failedRow.locator('.team-member-row')).toHaveAttribute('aria-expanded', 'true');
  await failedRow.locator('.team-member-row').click();
  await expect(failedRow.locator('.team-member-row')).toHaveAttribute('aria-expanded', 'false');
  const stoppingRow = failureCard.locator('.team-member').filter({ hasText: '单独停止' });
  await stoppingRow.locator('.team-member-row').click();
  await stoppingRow.getByRole('button', { name: '停止', exact: true }).click();
  await expect
    .poll(
      () =>
        provider.pending.length === 1 &&
        provider.requests[provider.pending[0]].tools.some((t) => t.function.name === 'desktop_team_dispatch'),
      { timeout: 30000 },
    )
    .toBe(true);
  provider.reply(provider.pending[0], '已核对失败与停止结果。');
  await expect
    .poll(async () => (await invoke('bootstrap')).runtime.status, { timeout: 30000 })
    .toBe('completed');
  await expect(failureCard).toContainText('1 失败');
  await expect(failureCard).toContainText('1 已停止');
  const restartedState = (await invoke('bootstrap')).state;
  await invoke('selectSession', writer.id);
  const deleting = invoke('deleteSession', writer.id);
  await page.getByRole('dialog').getByRole('button', { name: '删除', exact: true }).click();
  await deleting;
  await invoke('selectSession', id);
  const originalCard = page.getByRole('region', { name: '团队卡', exact: true }).first();
  if ((await originalCard.locator('header button').first().getAttribute('aria-expanded')) !== 'true')
    await originalCard.locator('header button').first().click();
  await expect(originalCard).toContainText('会话已删除');
  const deletedRow = originalCard.locator('.team-member').first();
  if ((await deletedRow.locator('.team-member-row').getAttribute('aria-expanded')) !== 'true')
    await deletedRow.locator('.team-member-row').click();
  await expect(deletedRow.getByRole('button', { name: '打开', exact: true })).toBeDisabled();
  await deletedRow.getByRole('button', { name: '查看汇报', exact: true }).click();
  await expect(deletedRow).toContainText('实现汇报');
  const deletingLead = invoke('deleteSession', id);
  await expect(page.getByRole('dialog')).toContainText('是否一起删除');
  await page.getByRole('dialog').getByRole('button', { name: '一起删除成员', exact: true }).click();
  await deletingLead;
  const afterDeletion = (await invoke('bootstrap')).state;
  assert.ok(!afterDeletion.sessions.some((s) => s.id === id || s.team?.leadId === id));
  assert.ok(
    afterDeletion.sessions.some((s) => restartedState.sessions.some((before) => before.id === s.id)),
    'unrelated cloned session survives',
  );
  assert.deepEqual(errors, []);
  console.log(
    'PASS team UI approvals/source grants/notification, styles, narrow/150%, quote preservation, clone and offline interrupted restoration',
  );
} finally {
  try {
    await closeApp(app);
  } finally {
    await provider.close();
    await unregisterMacTestApp(executablePath, process.env.PI_DESKTOP_TEST_APP_ROOT);
  }
}
