import { launchApp, closeApp } from '../tests/support/desktop-app.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { prepareRealPiFixture } from '../tests/support/local-provider.ts';

const requests = [];
const server = http.createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  requests.push(body);
  const index = body.messages.findLastIndex((message) => message.role === 'user');
  const content = body.messages[index]?.content;
  const prompt =
    typeof content === 'string' ? content : (content ?? []).map((part) => part.text ?? '').join('');
  const hasResult = body.messages.slice(index + 1).some((message) => message.role === 'tool');
  const write = /^MGMT_WRITE ([\w./-]+)$/.exec(prompt)?.[1];
  const read = /^MGMT_READ (.+)$/.exec(prompt)?.[1];
  const file = write ?? read;
  response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive' });
  const emit = (delta, reason = null) =>
    response.write(
      `data: ${JSON.stringify({ id: 'management-test', object: 'chat.completion.chunk', created: 1, model: 'local-e2e', choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`,
    );
  if (file && !hasResult) {
    emit({
      role: 'assistant',
      tool_calls: [
        {
          index: 0,
          id: randomUUID(),
          type: 'function',
          function: {
            name: write ? 'write' : 'read',
            arguments: JSON.stringify(write ? { path: file, content: 'management test\n' } : { path: file }),
          },
        },
      ],
    });
    emit({}, 'tool_calls');
  } else {
    emit({ role: 'assistant', content: 'OK' });
    emit({}, 'stop');
  }
  response.end('data: [DONE]\n\n');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const fixture = await prepareRealPiFixture(
  `http://127.0.0.1:${server.address().port}/v1`,
  'management-v014-ui',
);
const extraDir = path.join(fixture.dir, 'other-project');
await fs.mkdir(extraDir);
const extraProjectId = randomUUID(),
  standaloneId = randomUUID(),
  oldId = randomUUID(),
  draftId = randomUUID(),
  cleanupId = randomUUID();
fixture.store.state.projects.push({
  id: extraProjectId,
  name: '第二个项目',
  path: extraDir,
  trusted: true,
  createdAt: Date.now(),
});
const session = (id, projectId, title, extra = {}) => ({
  id,
  projectId,
  title,
  draft: '',
  attachments: [],
  lastStatus: 'idle',
  updatedAt: Date.now(),
  ...extra,
});
fixture.store.state.sessions.push(
  session(standaloneId, undefined, '独立草稿', { draft: '保留独立草稿' }),
  session(oldId, fixture.projectId, '八天前的会话', {
    updatedAt: Date.now() - 8 * 86400000,
    draft: '旧草稿',
    stats: { tokens: 400, cost: 4 },
  }),
  session(randomUUID(), extraProjectId, '其他项目未读', {
    unread: true,
    draft: '保留',
    stats: { tokens: 200, cost: 2 },
  }),
  session(draftId, fixture.projectId, '有附件的空会话', { attachments: ['输入 文件.txt'] }),
  session(cleanupId, fixture.projectId, '新会话'),
  session(randomUUID(), fixture.projectId, '自定义空会话'),
);
fixture.store.state.selectedProjectId = undefined;
fixture.store.state.selectedSessionId = standaloneId;
await fixture.store.save();
await fs.writeFile(
  path.join(fixture.projectDir, 'package.json'),
  JSON.stringify({ scripts: { test: 'node -e "console.log(123)"' } }),
);
const output = path.resolve('test-results');
await fs.mkdir(output, { recursive: true });
let app, page;
const errors = [];
const snapshot = () => page.evaluate(() => window.desktop.invoke('bootstrap'));
async function until(predicate, timeout = 45000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await snapshot();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error('Timed out waiting for state: ' + JSON.stringify((await snapshot()).runtime));
}
const idle = () =>
  until(
    (value) =>
      !['starting', 'running', 'waiting', 'retrying', 'compacting', 'stopping'].includes(
        value.runtime.status,
      ),
  );
try {
  ({ app, page } = await launchApp({
    executablePath: process.env.PI_DESKTOP_EXE,
    dataDir: fixture.dataDir,
    pageTimeout: 45000,
    errors: errors,
  }));

  const input = page.getByRole('textbox', { name: '任务输入' });
  await input.waitFor();
  const firstProject = page.locator('.project-row').filter({ hasText: 'Pi GUI 验收项目' });
  const secondProject = page.locator('.project-row').filter({ hasText: '第二个项目' });
  await firstProject.click();
  await secondProject.click();
  assert.equal((await snapshot()).state.selectedSessionId, standaloneId);
  assert.equal(await input.inputValue(), '保留独立草稿');
  assert.equal(await firstProject.getAttribute('aria-expanded'), 'true');
  assert.equal(await secondProject.getAttribute('aria-expanded'), 'true');
  await secondProject.click();
  assert.equal(await secondProject.locator('.unread').count(), 1);
  assert.equal(await page.getByRole('button', { name: '八天前的会话', exact: true }).count(), 0);
  await page.getByRole('button', { name: '更早的会话 (1)', exact: true }).click();
  await page.getByRole('button', { name: '八天前的会话', exact: true }).waitFor();
  await page.reload();
  await input.waitFor();
  assert.equal(await firstProject.getAttribute('aria-expanded'), 'true');
  assert.equal(await secondProject.getAttribute('aria-expanded'), 'false');
  assert.equal((await snapshot()).state.selectedSessionId, standaloneId);
  console.log(
    'PASS multiple projects expand independently, persist and show collapsed unread status; older sessions fold',
  );

  await page
    .locator(`[data-session-id="${fixture.sessionId}"]`)
    .getByRole('button', { name: '新会话', exact: true })
    .click();
  await page.evaluate((id) => window.desktop.invoke('connect', id), fixture.sessionId);
  const mode = page.getByRole('button', { name: '审批模式' });
  await mode.click();
  await page.getByRole('menuitemradio', { name: /^确认修改/ }).click();
  await until((value) => value.runtime.approvalMode === 'confirm');
  await input.fill('!npm test tests/a.ts');
  await input.press('Enter');
  await page.getByRole('button', { name: '本会话总是允许此完整命令', exact: true }).click();
  await idle();
  await input.fill('!npm test tests/b.ts');
  await input.press('Enter');
  const card = page.locator('.approval-card');
  await card.getByRole('button', { name: '本会话总是允许此完整命令', exact: true }).waitFor();
  await card.getByRole('button', { name: '允许', exact: true }).click();
  await until((value) =>
    value.runtime.messages.some(
      (message) => message.role === 'bashExecution' && message.command === 'npm test tests/b.ts',
    ),
  );
  await idle();
  assert.equal(await page.locator('.approval-card').count(), 0);
  await input.fill('!npm test && printf compound');
  await input.press('Enter');
  await card.getByRole('button', { name: '本会话总是允许此完整命令', exact: true }).waitFor();
  await card.getByRole('button', { name: '拒绝…', exact: true }).click();
  await card.getByRole('button', { name: '拒绝', exact: true }).click();
  await idle();
  await mode.click();
  await page.getByRole('button', { name: '撤回 完整命令：npm test tests/a.ts', exact: true }).click();
  await until((value) => !value.runtime.approvalGrants.length);
  await page.keyboard.press('Escape');
  await input.fill('!npm test tests/c.ts');
  await input.press('Enter');
  await page.getByRole('button', { name: '本会话总是允许此完整命令', exact: true }).waitFor();
  await card.getByRole('button', { name: '允许', exact: true }).click();
  await idle();
  console.log('PASS actual Pi exact command grants, changed-argument confirmation and individual revoke');

  await input.fill('MGMT_WRITE first.txt');
  await input.press('Enter');
  await page.getByRole('button', { name: '本会话允许修改项目内文件', exact: true }).click();
  await page.locator('.run-meta .completed').waitFor();
  await input.fill('MGMT_WRITE second.txt');
  await input.press('Enter');
  await until(
    (value) =>
      value.runtime.status === 'completed' &&
      value.runtime.tools.some((tool) => tool.args.path === 'second.txt' && tool.status === 'done'),
  );
  assert.equal(await fs.readFile(path.join(fixture.projectDir, 'second.txt'), 'utf8'), 'management test\n');
  await input.fill('MGMT_WRITE .env');
  await input.press('Enter');
  await page.locator('.approval-path-warning').filter({ hasText: '敏感文件' }).waitFor();
  assert.equal(await card.getByRole('button', { name: /本会话/ }).count(), 0);
  await firstProject.click();
  await firstProject.getByLabel('待确认 1 项').waitFor();
  await card.getByRole('button', { name: '拒绝…', exact: true }).click();
  await card.getByRole('button', { name: '拒绝', exact: true }).click();
  await page.locator('.run-meta .completed').waitFor();
  await mode.click();
  await page.getByRole('button', { name: '全部清空', exact: true }).click();
  await until((value) => !value.runtime.approvalGrants.length);
  await page.keyboard.press('Escape');
  console.log(
    'PASS project write grant, sensitive target still prompts, collapsed waiting badge and clear all',
  );

  const outside = path.join(fixture.dir, 'outside-approval.txt');
  const secret = 'temporary-outside-approval-sentinel';
  await fs.writeFile(outside, secret);
  const readsStart = requests.length;
  for (let attempt = 0; attempt < 2; attempt++) {
    await input.fill(`MGMT_READ ${outside}`);
    await input.press('Enter');
    const readCard = page.getByRole('region', { name: '等待批准：read', exact: true });
    await readCard.waitFor();
    assert.match(await readCard.innerText(), /项目外路径.*本次需要单独确认/);
    assert.equal(await readCard.getByRole('button', { name: /本会话/ }).count(), 0);
    await readCard.getByRole('button', { name: '拒绝…', exact: true }).click();
    await readCard.getByRole('button', { name: '拒绝', exact: true }).click();
    await page.locator('.run-meta .completed').waitFor();
  }
  await mode.click();
  await page.getByRole('menuitemradio', { name: /^只读/ }).click();
  await until((value) => value.runtime.approvalMode === 'readonly');
  await input.fill(`MGMT_READ ${outside}`);
  await input.press('Enter');
  await until(
    (value) =>
      value.runtime.status === 'completed' &&
      value.runtime.tools.some((tool) => tool.name === 'read' && tool.output.includes('只读模式')),
  );
  assert.equal(await page.locator('.approval-card').count(), 0);
  assert.equal(JSON.stringify(requests.slice(readsStart)).includes(secret), false);
  await mode.click();
  await page.getByRole('menuitemradio', { name: /^确认修改/ }).click();
  await until((value) => value.runtime.approvalMode === 'confirm');
  console.log(
    'PASS outside reads prompt each time; readonly blocks them without sending file content to the provider',
  );

  await input.fill('/settings');
  await input.press('Enter');
  const modal = page.getByRole('dialog', { name: 'Pi 功能', exact: true });
  await modal.waitFor();
  await modal.getByRole('button', { name: 'Skills 与扩展', exact: true }).click();
  await modal.getByRole('button', { name: '新建提示词模板', exact: true }).click();
  await modal.getByRole('textbox', { name: '模板命令名' }).fill('check-diff');
  await modal.getByRole('textbox', { name: '模板说明' }).fill('检查模块变更');
  await modal.getByRole('textbox', { name: '模板参数提示' }).fill('<模块名>');
  await modal.getByRole('textbox', { name: '模板正文' }).fill('Review module $1 using $ARGUMENTS');
  await modal.getByRole('button', { name: '保存模板', exact: true }).click();
  const editButton = modal.getByRole('button', { name: '编辑模板 check-diff.md', exact: true });
  await editButton.waitFor();
  await modal.locator('.resource-description').filter({ hasText: '检查模块变更' }).waitFor();
  await modal.locator('.resource-trigger').filter({ hasText: '/check-diff <模块名>' }).waitFor();
  await modal.getByRole('radio', { name: /^提示词模板/ }).click();
  await editButton.waitFor();
  await modal.getByRole('radio', { name: /^全部/ }).click();
  assert.match(
    await fs.readFile(path.join(fixture.projectDir, '.pi/prompts/check-diff.md'), 'utf8'),
    /argument-hint: "<模块名>"/,
  );
  assert.ok(
    (await snapshot()).runtime.commands.some(
      (command) => command.name === 'check-diff' && command.argumentHint === '<模块名>',
    ),
  );
  await editButton.click();
  await modal.getByRole('textbox', { name: '模板正文' }).fill('Updated module $1');
  await modal.getByRole('button', { name: '保存模板', exact: true }).click();
  await editButton.waitFor();
  await modal.getByRole('button', { name: '会话与上下文', exact: true }).click();
  await modal.getByRole('region', { name: '本地用量汇总' }).waitFor();
  assert.match(await modal.locator('.usage-summary').innerText(), /并非逐日账单/);
  assert.match(await modal.locator('.usage-projects').innerText(), /\$4\.0000/);
  await modal.getByRole('button', { name: 'Skills 与扩展', exact: true }).click();
  await modal.getByRole('button', { name: '删除模板 check-diff.md', exact: true }).click();
  await modal.getByRole('button', { name: '删除模板', exact: true }).click();
  await until((value) => !value.runtime.commands.some((command) => command.name === 'check-diff'));
  await modal.getByRole('button', { name: '关闭', exact: true }).last().click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const settingsDialog = page.getByRole('dialog', { name: '设置', exact: true });
  await settingsDialog.waitFor();
  await settingsDialog.getByRole('button', { name: '管理 Skills、扩展与提示词模板', exact: true }).click();
  await modal.getByRole('radiogroup', { name: '资源分类' }).waitFor();
  await modal.getByRole('button', { name: '关闭', exact: true }).last().click();
  console.log(
    'PASS native project template create/edit/delete refreshes commands and usage shows its accounting basis',
  );

  assert.equal(
    await page.locator('.sidebar-footer').getByRole('button', { name: '清理空会话', exact: true }).count(),
    0,
  );
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await settingsDialog.getByRole('button', { name: '诊断与数据', exact: true }).click();
  await settingsDialog.getByRole('button', { name: '清理空会话', exact: true }).click();
  await page
    .getByRole('dialog', { name: /清理 .* 个空会话/ })
    .getByRole('button', { name: '清理空会话', exact: true })
    .click();
  await until((value) => !value.state.sessions.some((session) => session.id === cleanupId));
  await settingsDialog.getByRole('button', { name: '关闭', exact: true }).last().click();
  assert.ok((await snapshot()).state.sessions.some((session) => session.title === '自定义空会话'));
  const after = await snapshot();
  assert.ok(after.state.sessions.some((session) => session.id === draftId));
  assert.ok(after.state.sessions.some((session) => session.id === oldId));
  assert.ok(after.state.sessions.some((session) => session.id === standaloneId));
  assert.deepEqual(errors, []);
  await page.screenshot({ path: path.join(output, 'management-v014.png'), animations: 'disabled' });
  console.log('PASS empty-session cleanup preserves drafts, attachments and sessions with messages');
} catch (error) {
  if (page && !page.isClosed())
    await page.screenshot({ path: path.join(output, 'management-v014-failure.png') });
  throw error;
} finally {
  await closeApp(app);
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
