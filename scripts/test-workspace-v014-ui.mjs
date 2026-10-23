import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createLocalProvider, prepareRealPiFixture } from '../tests/support/local-provider.ts';

const provider = await createLocalProvider();
const fixture = await prepareRealPiFixture(provider.baseUrl, 'workspace-v014-ui');
const sample = path.join(fixture.projectDir, 'src', 'range.ts');
const secondDirectory = path.join(fixture.dataDir, 'second-project');
await fs.mkdir(secondDirectory, { recursive: true });
fixture.store.state.projects.push({
  id: 'second-project',
  name: '另一个项目',
  path: secondDirectory,
  trusted: true,
  createdAt: Date.now(),
});
const secondSession = fixture.store.createSession('second-project');
fixture.store.selectSession(fixture.sessionId);
await fixture.store.save();
await fs.mkdir(path.dirname(sample), { recursive: true });
const source = Array.from(
  { length: 80 },
  (_, index) => `export const value${index + 1} = ${index + 1};`,
).join('\n');
await fs.writeFile(sample, source);
await fs.writeFile(
  path.join(fixture.projectDir, 'AGENTS.md'),
  '# Project rules\nRun npm test before release.\n',
);
const output = path.resolve('test-results');
await fs.mkdir(output, { recursive: true });
let app;
try {
  app = await electron.launch({
    args: [path.resolve('.')],
    env: { ...process.env, PI_DESKTOP_DATA_DIR: fixture.dataDir, PI_OFFLINE: '1' },
    timeout: 30000,
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const input = page.getByRole('textbox', { name: '任务输入' });
  await input.waitFor();
  await page.bringToFront();
  const send = async (text) => {
    await input.fill(text);
    // Enter can submit only after automatic model initialization enables sending.
    await page.getByRole('button', { name: '发送任务', exact: true }).click({ trial: true });
    await input.press('Enter');
    await page.waitForFunction(
      (text) => {
        const prompt = [...document.querySelectorAll('.message.user')].at(-1);
        return prompt?.textContent?.includes(text) && document.querySelector('.run-meta .completed');
      },
      text,
      { timeout: 60000 },
    );
  };
  await send('E2E_FILES');
  await send('E2E_EDIT');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+j' : 'Control+j');
  const inspector = page.locator('#workspace-inspector');
  await inspector.waitFor();
  await inspector.getByRole('combobox', { name: '变更范围' }).selectOption({ label: '自第 1 轮起' });
  await inspector.locator('.change-row').filter({ hasText: '输出结果.txt' }).waitFor();
  await inspector.locator('.change-row').filter({ hasText: '输入 文件.txt' }).click();
  await inspector.locator('.diff-word-add').first().waitFor();
  await input.fill('保留现有草稿');
  await inspector.getByRole('button', { name: '追问此段' }).first().click();
  assert.match(await input.inputValue(), /^保留现有草稿/);
  await page.locator('.attachments > span').filter({ hasText: '输入 文件.txt' }).waitFor();
  await inspector.getByRole('button', { name: '对照', exact: true }).click();
  assert.equal(await inspector.locator('.diff-pane').count(), 2);
  console.log('PASS checkpoint selector, highlighted aligned diff and hunk follow-up preserve the draft');

  await page.keyboard.press('Alt+2');
  await inspector.getByRole('button', { name: '项目规则：AGENTS.md' }).waitFor();
  await inspector.getByRole('textbox', { name: '过滤项目文件' }).fill('range.ts');
  await inspector.getByRole('button', { name: /src\/range.ts/ }).click();
  await inspector.getByRole('button', { name: '选择第 10 行', exact: true }).click();
  await inspector.getByRole('button', { name: '选择第 14 行', exact: true }).click({ modifiers: ['Shift'] });
  await inspector.getByRole('button', { name: '引用 L10–L14', exact: true }).click();
  await page
    .locator('.attachments > span')
    .filter({ hasText: /range.ts.*10.*14/ })
    .waitFor();
  const preview = inspector.locator('.source-preview');
  await preview.evaluate((element) => {
    element.scrollTop = 400;
  });
  const scrollTop = await preview.evaluate((element) => element.scrollTop);
  await fs.writeFile(sample, source.replace('value20 = 20', 'value20 = 200'));
  await inspector.locator('.preview-stale').waitFor();
  assert.match(
    await preview.textContent(),
    /value20 = 20;/,
    'external writes do not replace the visible preview',
  );
  await inspector.locator('.preview-stale').getByRole('button', { name: '刷新', exact: true }).click();
  await page.waitForFunction(() =>
    document.querySelector('.source-preview')?.textContent?.includes('value20 = 200;'),
  );
  assert.ok(Math.abs((await preview.evaluate((element) => element.scrollTop)) - scrollTop) < 5);
  await inspector.getByRole('button', { name: '最大化预览', exact: true }).click();
  await inspector.locator('.preview-return').waitFor();
  await inspector.getByRole('button', { name: '恢复列表', exact: true }).click();
  await inspector.getByRole('button', { name: '定位当前预览文件' }).click();
  await inspector.locator('.file-browser-tree .file-row.active').waitFor();
  console.log(
    'PASS filtered files, range chips, watcher stale preview, scroll preservation, maximize and reveal',
  );

  await fs.writeFile(path.join(fixture.projectDir, '已有修改.txt'), 'manual change stays\n');
  await page.keyboard.press('Alt+1');
  const undo = page
    .locator('.message.user')
    .first()
    .getByRole('button', { name: '撤销此轮起的文件修改', exact: true });
  await undo.click();
  const dialog = page.getByRole('dialog', { name: '撤销第 1 轮起的文件修改' });
  await dialog.waitFor();
  const manual = dialog.locator('label').filter({ hasText: '已有修改.txt' });
  assert.equal(await manual.getByRole('checkbox').isChecked(), false);
  await dialog.getByRole('button', { name: /^恢复 \d+ 个文件$/ }).click();
  await page.getByRole('dialog', { name: '文件已恢复' }).waitFor();
  assert.equal(
    await fs.readFile(path.join(fixture.projectDir, '已有修改.txt'), 'utf8'),
    'manual change stays\n',
  );
  await assert.rejects(fs.access(path.join(fixture.projectDir, '输出结果.txt')));
  await page.getByRole('button', { name: '同时回到这条消息之前的对话', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[aria-label="任务输入"]')?.value === 'E2E_FILES');
  assert.equal(
    await page.locator('.thread .tool-card').count(),
    0,
    'returning before the first message clears tools from the previous branch',
  );

  await page.evaluate((id) => {
    globalThis.originalCommand = window.desktop.invoke(
      'send',
      id,
      '!!node -e "setTimeout(function(){console.log(123456)},1500)"',
      [],
      'steer',
      [],
    );
  }, fixture.sessionId);
  await page.waitForFunction(() => !!document.querySelector('.run-meta .running'));
  await page.evaluate((id) => window.desktop.invoke('selectSession', id), secondSession.id);
  await page.evaluate(() => globalThis.originalCommand);
  await page.keyboard.press('Alt+3');
  assert.equal(await inspector.locator('.output-scroll').getByText('123456', { exact: true }).count(), 0);
  assert.equal(
    await inspector.getByRole('button', { name: '本地重跑（不发给模型）', exact: true }).count(),
    0,
  );
  assert.equal(await inspector.getByRole('button', { name: '重跑并发给 Pi', exact: true }).count(), 0);
  await page.evaluate((id) => window.desktop.invoke('selectSession', id), fixture.sessionId);
  await inspector.locator('.output-scroll').getByText('123456', { exact: true }).waitFor();
  await inspector.getByRole('button', { name: '本地重跑（不发给模型）', exact: true }).waitFor();
  await inspector.getByRole('button', { name: '重跑并发给 Pi', exact: true }).waitFor();
  console.log(
    'PASS background command output and rerun actions stay with their source session across project switches',
  );
  assert.deepEqual(errors, []);
  await page.screenshot({ path: path.join(output, 'workspace-v014.png'), animations: 'disabled' });
  console.log(
    'PASS multi-turn restore dialog leaves manual edits unchecked and separately returns to the original message',
  );
} catch (error) {
  const page = app?.windows()[0];
  if (page && !page.isClosed()) {
    await page.screenshot({ path: path.join(output, 'workspace-v014-failed.png') });
    await fs.writeFile(path.join(output, 'workspace-v014-failed.html'), await page.content());
    const snapshot = await page.evaluate(async () => {
      const { runtime } = await window.desktop.invoke('bootstrap');
      return {
        status: runtime.status,
        connected: runtime.connected,
        error: runtime.error,
        diagnostic: runtime.diagnostic,
        messages: runtime.messages,
      };
    });
    await fs.writeFile(path.join(output, 'workspace-v014-failed.json'), JSON.stringify(snapshot, null, 2));
  }
  throw error;
} finally {
  await app
    ?.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.webContents.executeJavaScript(
        `void window.desktop.onEvent(event => {
          if (event.type === 'appDialog') void window.desktop.invoke('respondAppDialog', event.dialog.id,
            event.dialog.message === 'Pi 仍在执行任务' ? 1 : event.dialog.cancelId);
        })`,
      ),
    )
    .catch(() => {});
  await app?.close();
  await provider.close();
}
