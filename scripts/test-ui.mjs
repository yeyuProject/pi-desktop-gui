import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createLocalProvider, prepareRealPiFixture } from '../tests/support/local-provider.ts';

const provider = await createLocalProvider();
const fixture = await prepareRealPiFixture(provider.baseUrl, 'ui');
const output = path.resolve('test-results');
await fs.mkdir(output, { recursive: true });
let app;
const errors = [];
let page;
const launch = async () => {
  app = await electron.launch({
    executablePath: process.env.PI_DESKTOP_EXE,
    args: process.env.PI_DESKTOP_EXE ? [] : [path.resolve('.')],
    env: { ...process.env, PI_DESKTOP_DATA_DIR: fixture.dataDir, PI_OFFLINE: '1' },
    timeout: 30000,
  });
  page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.getByRole('textbox', { name: '任务输入' }).waitFor();
  await page.getByText('想一起完成什么？').or(page.locator('.message')).first().waitFor();
};
// A cold Pi process on Windows can take over 25 seconds to initialize.
const waitStatus = async (s) => page.locator('.run-meta .status.' + s).waitFor({ timeout: 60000 });
try {
  await launch();
  assert.equal(await page.locator('.inspector').count(), 0);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(output, 'workspace-empty.png'), animations: 'disabled' });
  await page.getByRole('button', { name: '收起项目侧栏 Ctrl+B', exact: true }).click();
  assert.equal(await page.locator('.sidebar').isVisible(), false);
  await page.keyboard.press('Control+b');
  assert.equal(await page.locator('.sidebar').isVisible(), true);
  await page.getByRole('button', { name: '理解项目', exact: true }).click();
  assert.match(await page.getByRole('textbox', { name: '任务输入' }).inputValue(), /梳理这个项目/);
  assert.equal(
    await page.getByRole('textbox', { name: '任务输入' }).evaluate((e) => e === document.activeElement),
    true,
  );
  const input = page.getByRole('textbox', { name: '任务输入' });
  await input.fill('@输入');
  await page.locator('.file-picker').getByRole('option', { name: '输入 文件.txt', exact: true }).click();
  await page.locator('.attachments').getByText('输入 文件.txt').waitFor();
  await input.fill('E2E_FILES：读取输入文件，写入结果，再执行验证命令。');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await waitStatus('completed');
  await page.locator('.message-attachment').getByText('输入 文件.txt', { exact: false }).waitFor();
  await page.getByText('命令结果：', { exact: false }).waitFor();
  assert.equal(
    await fs.readFile(path.join(fixture.projectDir, '输出结果.txt'), 'utf8'),
    '真实 Pi 工具执行成功\n',
  );
  await page.screenshot({ path: path.join(output, 'workspace-conversation.png'), animations: 'disabled' });
  await page.getByRole('button', { name: '查看工作区变更', exact: true }).click();
  await page.getByRole('button', { name: '刷新变更', exact: true }).click();
  await page.locator('.change-row').filter({ hasText: '输出结果.txt' }).click();
  await page
    .locator('.inspector .diff-row.added')
    .getByText('真实 Pi 工具执行成功', { exact: true })
    .waitFor();
  assert.equal(await page.locator('.tool-card.error').count(), 0);
  await page.screenshot({ path: path.join(output, 'workspace-completed.png'), animations: 'disabled' });
  console.log('PASS UI real Pi task, attachment, tools and diff');
  await input.fill('/gui-select');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await page.getByRole('dialog', { name: '测试选择' }).waitFor();
  await page.getByRole('radio', { name: 'B', exact: true }).check();
  await page.getByRole('button', { name: '提交回复', exact: true }).click();
  await waitStatus('idle');
  console.log('PASS UI actual Pi extension prompt');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '外观与编辑器', exact: true }).click();
  await page.getByRole('button', { name: '深色', exact: true }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await page.screenshot({ path: path.join(output, 'workspace-settings.png'), animations: 'disabled' });
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await page.getByRole('button', { name: '关闭', exact: true }).last().click();
  await page.screenshot({ path: path.join(output, 'workspace-dark.png'), animations: 'disabled' });
  await page.getByRole('textbox', { name: '任务输入' }).fill('不会自动发送的持久草稿');
  await page.getByRole('button', { name: '收起项目侧栏 Ctrl+B', exact: true }).click();
  await page.waitForTimeout(300);
  await app.close();
  app = undefined;
  await launch();
  await page.getByRole('textbox', { name: '任务输入' }).waitFor();
  assert.equal(await page.getByRole('textbox', { name: '任务输入' }).inputValue(), '不会自动发送的持久草稿');
  assert.equal(await page.locator('.sidebar').isVisible(), false);
  await page.keyboard.press('Control+b');
  assert.ok((await page.locator('.message').count()) > 0);
  assert.equal(await page.locator('.run-meta .running').count(), 0);
  console.log('PASS UI theme, draft and history after restart');
  await page.getByRole('textbox', { name: '任务输入' }).fill('E2E_SLOW');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await waitStatus('running');
  await page.getByRole('textbox', { name: '任务输入' }).fill('停止后恢复这条后续任务');
  await page.getByLabel('运行中发送方式').selectOption('followUp');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await page.locator('.queue').getByText('停止后恢复这条后续任务', { exact: false }).waitFor();
  await page.getByRole('button', { name: '停止任务', exact: true }).click();
  await waitStatus('stopped');
  assert.match(await page.getByRole('textbox', { name: '任务输入' }).inputValue(), /停止后恢复/);
  console.log('PASS UI stop and queue restoration');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '外观与编辑器', exact: true }).click();
  await page.getByLabel('字号比例').fill('2');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await page.getByRole('button', { name: '关闭', exact: true }).last().click();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1024, 768));
  await page.waitForFunction(() => !!document.querySelector('.workspace-columns.compact'));
  await page.screenshot({ path: path.join(output, 'workspace-200-percent.png'), animations: 'disabled' });
  assert.ok(await page.getByRole('textbox', { name: '任务输入' }).isVisible());
  const sendBounds = await page.getByRole('button', { name: '发送任务', exact: true }).boundingBox();
  assert.ok(
    sendBounds &&
      sendBounds.y >= 0 &&
      sendBounds.y + sendBounds.height <= (await page.evaluate(() => innerHeight)),
  );
  await page.getByRole('button', { name: '查看工作区变更', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: '工作区检查', exact: true });
  await drawer.waitFor();
  await drawer.locator('.change-row').filter({ hasText: '输出结果.txt' }).click();
  await drawer.getByRole('button', { name: '继续提问', exact: true }).click();
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '任务输入');
  assert.equal(await drawer.count(), 0);
  assert.match(await page.getByRole('textbox', { name: '任务输入' }).inputValue(), /请检查 输出结果/);
  await page.getByRole('button', { name: '查看工作区变更', exact: true }).click();
  await drawer.waitFor();
  await page.getByRole('button', { name: '关闭面板', exact: true }).focus();
  // Tab must stay inside the compact inspector, even after its final action.
  const focusable = drawer.locator(
    'button:visible:not(:disabled), select:visible:not(:disabled), summary:visible',
  );
  await focusable.last().focus();
  await page.keyboard.press('Tab');
  assert.equal(await drawer.evaluate((e) => e.contains(document.activeElement)), true);
  await page.screenshot({
    path: path.join(output, 'workspace-compact-inspector.png'),
    animations: 'disabled',
  });
  await page.keyboard.press('Escape');
  assert.equal(await drawer.count(), 0);
  assert.equal(
    await page
      .getByRole('button', { name: '查看工作区变更', exact: true })
      .evaluate((e) => e === document.activeElement),
    true,
  );
  console.log('PASS UI focus layout, sidebar persistence, compact inspector and keyboard dismissal');
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  assert.equal(await page.evaluate(() => typeof window.process), 'undefined');
  assert.deepEqual(errors, []);
  await fs.writeFile(
    path.join(output, 'ui-result.json'),
    JSON.stringify(
      {
        result: 'PASS',
        fixture: fixture.dir,
        checks: [
          'real Electron renderer',
          'real Pi read/write/shell',
          'attachment picker',
          'Git diff',
          'light/dark themes',
          'draft/history reload',
          'queue and stop',
          '200% font at 1024x768',
          'collapsed inspector by default',
          'sidebar toggle and persistence',
          'suggestion focus and draft',
          'compact inspector keyboard focus and Escape',
          'isolated renderer',
        ],
        consoleErrors: errors,
      },
      null,
      2,
    ),
  );
  console.log('UI PASS:', output);
} catch (e) {
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'ui-failure.png') });
  console.error('Renderer errors:', errors);
  throw e;
} finally {
  if (app) {
    await app
      .evaluate(({ BrowserWindow }) => {
        return BrowserWindow.getAllWindows()[0]?.webContents.executeJavaScript(
          `void window.desktop.onEvent(event => {
            if (event.type === 'appDialog') void window.desktop.invoke('respondAppDialog', event.dialog.id,
              event.dialog.message === 'Pi 仍在执行任务' ? 1 : event.dialog.cancelId);
          })`,
        );
      })
      .catch(() => {});
    await app.close();
  }
  await provider.close();
}
