import { launchApp, closeApp } from '../tests/support/desktop-app.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createLocalProvider, prepareRealPiFixture } from '../tests/support/local-provider.ts';
import { terminateProcessTree } from '../electron/platform.ts';

const provider = await createLocalProvider();
const fixture = await prepareRealPiFixture(provider.baseUrl, 'recovery-ui');
const output = path.resolve('test-results');
await fs.mkdir(output, { recursive: true });
fixture.store.session(fixture.sessionId).draft = '恢复后的草稿';
await fixture.store.save();
await fs.copyFile(
  path.join(fixture.dataDir, 'state.json'),
  path.join(fixture.dataDir, 'state.backup-1.json'),
);
await fs.writeFile(path.join(fixture.dataDir, 'state.json'), '{ broken');
let app, page;
const errors = [];
const launch = async (dataDir) => {
  ({ app, page } = await launchApp({
    executablePath: process.env.PI_DESKTOP_EXE,
    dataDir: dataDir,
    errors: errors,
  }));

  await page.getByRole('textbox', { name: '任务输入' }).waitFor();
};
const waitFile = async (file) => {
  const until = Date.now() + 15000;
  while (true) {
    try {
      await fs.access(file);
      return;
    } catch {}
    if (Date.now() > until) throw new Error('The isolated tool did not create its file');
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
};
try {
  await launch(fixture.dataDir);
  const banner = page.getByRole('alert', { name: '本地数据状态' });
  await banner.waitFor();
  assert.match(await banner.innerText(), /已恢复到/);
  const input = page.getByRole('textbox', { name: '任务输入' });
  assert.equal(await input.inputValue(), '恢复后的草稿');
  assert.ok((await fs.readdir(fixture.dataDir)).some((name) => name.startsWith('state.corrupt-')));
  await banner.getByRole('button', { name: '知道了' }).click();
  assert.equal(await banner.count(), 0);
  console.log('PASS a damaged index starts normally and restores the draft with a dismissible explanation');

  await page.evaluate((id) => window.desktop.invoke('send', id, '/gui-pid', [], 'steer'), fixture.sessionId);
  const initial = await page.evaluate(() => window.desktop.invoke('bootstrap'));
  const pid = Number(initial.runtime.notices.find((line) => line.startsWith('GUI_PID:')).split(':')[1]);
  assert.ok(Number.isInteger(pid) && pid > 0);
  await input.fill('E2E_CRASH');
  await input.press('Enter');
  await waitFile(path.join(fixture.projectDir, 'crash-partial.txt'));
  await terminateProcessTree(pid);
  const card = page.getByRole('region', { name: 'Pi 意外退出', exact: true });
  await card.waitFor({ timeout: 5000 });
  await card.getByRole('button', { name: '本轮已修改 1 个文件，查看变更' }).waitFor();
  assert.match(await card.innerText(), /退出前正在调用/);
  await card.getByText('无法确认残留命令已结束', { exact: false }).waitFor();
  assert.equal(await card.getByRole('button', { name: '重新连接', exact: true }).isDisabled(), true);
  await assert.rejects(
    page.evaluate((id) => window.desktop.invoke('recover', id), fixture.sessionId),
    /无法确认/,
  );
  await assert.rejects(
    page.evaluate((id) => window.desktop.invoke('revertChanges', id, null), fixture.projectId),
    /无法确认/,
  );
  await page.reload();
  await card.waitFor();
  assert.equal(await card.getByRole('button', { name: '重新连接', exact: true }).isDisabled(), true);
  await page.screenshot({ path: path.join(output, 'recovery-crash.png') });
  console.log('PASS unconfirmed tool cleanup blocks recovery and undo, including after a window reload');
  // The fixture explicitly ended the complete tree above, so a fresh application is now safe.
  // Normal exit must keep refusing an unconfirmed tool tree. End only this isolated
  // test application's process tree to exercise startup after that protected state.
  const fixtureExited = app.waitForEvent('close');
  await terminateProcessTree(app.process().pid);
  await fixtureExited;
  app = undefined;
  await launch(fixture.dataDir);
  await page.evaluate((id) => window.desktop.invoke('send', id, '/gui-pid', [], 'steer'), fixture.sessionId);
  const fresh = await page.evaluate(() => window.desktop.invoke('bootstrap'));
  const idlePid = Number(fresh.runtime.notices.find((line) => line.startsWith('GUI_PID:')).split(':')[1]);
  process.kill(idlePid, 'SIGKILL');
  const safeCard = page.getByRole('region', { name: 'Pi 意外退出', exact: true });
  await safeCard.waitFor({ timeout: 5000 });
  const prompt = 'UI_RESUME：先检查已有修改，再继续完成任务。';
  await safeCard.getByRole('textbox', { name: '继续任务的提问' }).fill(prompt);
  await safeCard.getByRole('button', { name: '重新连接并继续', exact: true }).click();
  await page.locator('.run-meta .completed').waitFor();
  assert.equal(await safeCard.count(), 0);
  assert.ok(
    provider.requests.at(-1).messages.some((message) => JSON.stringify(message.content).includes(prompt)),
  );
  console.log(
    'PASS a real Pi crash shows its last tool and changed files; edited continuation resumes explicitly',
  );

  await page.evaluate((id) => window.desktop.invoke('saveDraft', id, '', []), fixture.sessionId);
  await fs.mkdir(path.join(fixture.dataDir, 'state.json.tmp'));
  await page.getByRole('textbox', { name: '任务输入' }).fill('这条内容不能假装已经保存');
  const readonlyBanner = page.getByRole('alert', { name: '本地数据状态' });
  await readonlyBanner.waitFor();
  assert.match(await readonlyBanner.innerText(), /发送与保存已暂停/);
  await page.waitForFunction(() => document.querySelector('[aria-label="任务输入"]')?.disabled === true);
  await assert.rejects(
    page.evaluate(
      (id) => window.desktop.invoke('send', id, 'must not start', [], 'steer'),
      fixture.sessionId,
    ),
    /发送与保存已暂停/,
  );
  console.log('PASS an actual disk write failure disables input and rejects sending at the IPC boundary');
  const failedWriteClosed = app.waitForEvent('close', { timeout: 60000 });
  await app.evaluate(({ app }) => {
    setImmediate(() => app.quit());
  });
  await page
    .getByRole('dialog', { name: '本地内容尚未保存，仍然退出？', exact: true })
    .getByRole('button', { name: '仍然退出，丢弃未保存内容', exact: true })
    .click();
  await failedWriteClosed;
  app = undefined;

  const empty = await prepareRealPiFixture(provider.baseUrl, 'recovery-empty-ui');
  await fs.unlink(path.join(empty.dataDir, 'state.backup-1.json'));
  await fs.writeFile(path.join(empty.dataDir, 'state.json'), 'broken without backup');
  await launch(empty.dataDir);
  await page.getByRole('alert', { name: '本地数据状态' }).waitFor();
  assert.match(await page.getByRole('alert', { name: '本地数据状态' }).innerText(), /未找到可用备份/);
  const reset = await page.evaluate(() => window.desktop.invoke('bootstrap'));
  assert.equal(
    reset.runtime.sessionId,
    undefined,
    'a reset index must not automatically start Pi with default settings',
  );
  assert.deepEqual(errors, []);
  console.log('PASS an index with no usable backup starts with instructions to reopen Pi history');
  await app.close();
  app = undefined;
  const missing = await prepareRealPiFixture(provider.baseUrl, 'recovery-missing-ui');
  await fs.unlink(path.join(missing.dataDir, 'state.json'));
  await launch(missing.dataDir);
  const missingBanner = page.getByRole('alert', { name: '本地数据状态' });
  await missingBanner.waitFor();
  assert.match(await missingBanner.innerText(), /索引缺失.*已恢复到/);
  await missingBanner.getByRole('button', { name: '知道了' }).click();
  assert.equal(await missingBanner.count(), 0);
  await page.evaluate((id) => window.desktop.invoke('connect', id), missing.sessionId);
  console.log('PASS restoring a missing index also shows the backup time and supports dismissal');
} catch (error) {
  console.error(error);
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'recovery-ui-failure.png') });
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
    if (page && !page.isClosed()) {
      const pendingExit = page.getByRole('dialog').filter({ hasText: 'Pi 仍在执行任务' });
      if (await pendingExit.isVisible())
        await pendingExit
          .getByRole('button', { name: '停止并退出', exact: true })
          .click()
          .catch(() => {});
    }
    await closeApp(app);
  }
  await provider.close();
}
