import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createLocalProvider, prepareRealPiFixture } from '../tests/support/local-provider.ts';

const provider = await createLocalProvider();
const fixture = await prepareRealPiFixture(provider.baseUrl, 'approval-ui');
const output = path.resolve('test-results');
await fs.mkdir(output, { recursive: true });
let app, page;
const errors = [];
const exists = (file) =>
  fs.stat(file).then(
    () => true,
    () => false,
  );
try {
  app = await electron.launch({
    executablePath: process.env.PI_DESKTOP_EXE,
    args: process.env.PI_DESKTOP_EXE ? [] : [path.resolve('.')],
    env: { ...process.env, PI_DESKTOP_DATA_DIR: fixture.dataDir, PI_OFFLINE: '1' },
    timeout: 30000,
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(30000);
  page.on('pageerror', (error) => errors.push(error.message));
  const input = page.getByRole('textbox', { name: '任务输入' });
  const mode = page.getByRole('button', { name: '审批模式' });
  await input.waitFor();
  await page.evaluate((id) => window.desktop.invoke('connect', id), fixture.sessionId);
  await mode.click();
  await page.getByRole('menuitemradio', { name: /^确认修改/ }).click();
  await page.waitForFunction(() => document.querySelector('.approval-pill')?.textContent === '确认修改');

  await input.fill('E2E_FILES');
  await input.evaluate((element) => {
    window.approvalInputBlurs = 0;
    window.trackApprovalBlur = () => window.approvalInputBlurs++;
    element.addEventListener('blur', window.trackApprovalBlur);
  });
  await input.press('Enter');
  // Start the next draft after the first send is accepted, beyond its save barrier.
  await page.locator('.message.user').filter({ hasText: 'E2E_FILES' }).waitFor();
  await input.fill('这条草稿不应被审批卡片打断');
  const write = page.getByRole('region', { name: '等待批准：write', exact: true });
  await write.waitFor();
  assert.match(await write.innerText(), /真实 Pi 工具执行成功/);
  assert.equal(await page.evaluate(() => window.approvalInputBlurs), 0);
  await input.evaluate((element) => element.removeEventListener('blur', window.trackApprovalBlur));
  assert.equal(await input.evaluate((el) => document.activeElement === el), true);
  assert.equal(await input.inputValue(), '这条草稿不应被审批卡片打断');
  assert.equal(await exists(path.join(fixture.projectDir, '输出结果.txt')), false);

  await mode.click();
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('menu').count(), 0);
  assert.equal(await page.locator('.stop-button.armed').count(), 0);
  await write.getByRole('button', { name: '允许', exact: true }).click();
  const shell = page.locator('.approval-card.shell');
  await shell.waitFor();
  assert.equal(
    await fs.readFile(path.join(fixture.projectDir, '输出结果.txt'), 'utf8'),
    '真实 Pi 工具执行成功\n',
  );
  console.log('PASS approval preserves typing focus; Escape closes its menu without arming stop');

  const command = await shell.locator('.approval-command').innerText();
  await page.reload();
  await shell.waitFor();
  assert.equal(await shell.locator('.approval-command').innerText(), command);
  assert.match(await page.locator('.thread').innerText(), /E2E_FILES/);
  await shell.getByRole('button', { name: '拒绝…', exact: true }).click();
  await shell.getByRole('textbox', { name: '拒绝原因' }).fill('界面测试：不要执行命令');
  await shell.getByRole('button', { name: '拒绝', exact: true }).click();
  await page.locator('.run-meta .completed').waitFor();
  const runtime = (await page.evaluate(() => window.desktop.invoke('bootstrap'))).runtime;
  assert.match(runtime.tools.find((t) => ['bash', 'powershell'].includes(t.name)).output, /不要执行命令/);
  assert.equal(await page.locator('.approval-card').count(), 0);
  console.log('PASS refresh resyncs history and the pending approval; denial reaches the tool result');

  await mode.click();
  await page.getByRole('menuitemradio', { name: /^只读/ }).click();
  await page.waitForFunction(() => document.querySelector('.approval-pill')?.textContent === '只读');
  await input.fill('!printf blocked > ui-denied.txt');
  await input.press('Enter');
  await page.waitForFunction(() =>
    document.querySelector('.bash-message')?.textContent?.includes('只读模式'),
  );
  assert.equal(await exists(path.join(fixture.projectDir, 'ui-denied.txt')), false);
  assert.equal(await page.locator('.approval-card').count(), 0);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: path.join(output, 'approval-ui.png') });
  console.log('PASS read-only mode also blocks manual commands in the UI');
  console.log('Approval UI PASS', fixture.dir);
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'approval-ui-failure.png') });
  throw error;
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
