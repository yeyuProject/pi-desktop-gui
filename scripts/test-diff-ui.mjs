import { _electron as electron } from 'playwright';
import { expect } from 'playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLocalProvider, prepareRealPiFixture } from '../tests/support/local-provider.ts';

const provider = await createLocalProvider();
const fixture = await prepareRealPiFixture(provider.baseUrl, 'diff-responsiveness-ui');
const exec = promisify(execFile);
const before = Array.from({ length: 6000 }, (_, i) => `original_${i} = ${i};`).join('\n');
const after = Array.from({ length: 6000 }, (_, i) => `replacement_${i} = ${i + 1};`).join('\n');
const small = Array.from({ length: 200 }, (_, i) => `const value${i + 1} = ${i + 1};`).join('\n');
await fs.writeFile(path.join(fixture.projectDir, 'large.ts'), before);
await fs.writeFile(path.join(fixture.projectDir, 'small.ts'), small);
await exec('git', ['add', 'large.ts', 'small.ts'], { cwd: fixture.projectDir });
await exec(
  'git',
  ['-c', 'user.name=Pi GUI Test', '-c', 'user.email=pi-test@example.invalid', 'commit', '-m', 'diff fixture'],
  { cwd: fixture.projectDir },
);
await fs.writeFile(path.join(fixture.projectDir, 'large.ts'), after);
await fs.writeFile(
  path.join(fixture.projectDir, 'small.ts'),
  small.replace('value100 = 100', 'value100 = 999'),
);
const report = { packaged: Boolean(process.env.PI_DESKTOP_TEST_EXECUTABLE), errors: [] };
let app;
try {
  app = await electron.launch({
    ...(process.env.PI_DESKTOP_TEST_EXECUTABLE
      ? { executablePath: process.env.PI_DESKTOP_TEST_EXECUTABLE, args: [] }
      : { args: [path.resolve('.')] }),
    env: { ...process.env, PI_DESKTOP_DATA_DIR: fixture.dataDir, PI_OFFLINE: '1' },
    timeout: 60000,
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  page.on('pageerror', (error) => report.errors.push(error.message));
  const input = page.getByRole('textbox', { name: '任务输入' });
  await input.waitFor();
  await page.bringToFront();
  await app.evaluate(({ ipcMain }) => {
    globalThis.diffAudit = [];
    const original = ipcMain._invokeHandlers.get('desktop:invoke');
    ipcMain.removeHandler('desktop:invoke');
    ipcMain.handle('desktop:invoke', async (event, method, args) => {
      const started = performance.now();
      if (method === 'diff') globalThis.diffAudit.push({ phase: 'start', file: args[1] });
      const value = await original(event, method, args);
      if (method === 'diff')
        globalThis.diffAudit.push({
          phase: 'end',
          file: args[1],
          unavailable: value.unavailable,
          ms: performance.now() - started,
        });
      return value;
    });
  });
  await input.press(process.platform === 'darwin' ? 'Meta+j' : 'Control+j');
  const inspector = page.locator('#workspace-inspector');
  await inspector.locator('.change-row').filter({ hasText: 'large.ts' }).click();
  await expect(inspector.getByText('加载差异…', { exact: true })).toBeVisible();
  await input.fill('切换文件时保留这份草稿');
  report.mainIpcDuringDiffMs = await page.evaluate(async () => {
    const started = performance.now();
    await window.desktop.invoke('navigationState');
    return performance.now() - started;
  });
  assert.equal(
    await app.evaluate(() =>
      globalThis.diffAudit.some((item) => item.file === 'large.ts' && item.phase === 'end'),
    ),
    false,
    'main IPC remains available before the large diff completes',
  );
  await inspector.locator('.change-row').filter({ hasText: 'small.ts' }).click();
  await expect(inspector.locator('.unified-diff')).toContainText('value100 = 999');
  await expect
    .poll(() =>
      app.evaluate(() =>
        globalThis.diffAudit.some(
          (item) => item.file === 'large.ts' && item.unavailable === '差异预览已取消',
        ),
      ),
    )
    .toBe(true);
  await expect(input).toHaveValue('切换文件时保留这份草稿');
  await expect(inspector.locator('.unified-diff')).not.toContainText('replacement_');

  await inspector.getByRole('button', { name: '对照', exact: true }).click();
  await expect(inspector.locator('.diff-pane')).toHaveCount(2);
  await inspector.getByRole('button', { name: '展开完整文件', exact: true }).click();
  await expect(inspector.locator('.diff-pane').last()).toContainText('value200 = 200');
  await expect(inspector.locator('.diff-pane').last()).toContainText('value100 = 999');
  await inspector.getByRole('button', { name: '追问此段', exact: true }).click();
  assert.match(await input.inputValue(), /^切换文件时保留这份草稿/);
  await expect(page.locator('.attachments')).toContainText('small.ts');

  // Cancellation is scoped to a request: a late cancellation cannot abort a newer file.
  const next = await page.evaluate(async (projectId) => {
    const old = window.desktop.invoke('diff', projectId, 'large.ts', 'all', undefined, 'old-preview');
    const current = window.desktop.invoke('diff', projectId, 'small.ts', 'all', undefined, 'new-preview');
    await window.desktop.invoke('cancelDiff', 'old-preview');
    return { old: await old, current: await current };
  }, fixture.projectId);
  assert.equal(next.old.unavailable, '差异预览已取消');
  assert.equal(next.current.unavailable, undefined);
  assert.match(next.current.patch, /\+const value100 = 999/);
  report.requests = await app.evaluate(() => globalThis.diffAudit);
  assert.deepEqual(report.errors, []);
  assert.equal(provider.requests.length, 0);
  await fs.mkdir('test-results', { recursive: true });
  await fs.writeFile(
    `test-results/diff-ui${report.packaged ? '-packaged' : ''}.json`,
    JSON.stringify(report, null, 2),
  );
  console.log(
    'PASS responsive main IPC, cancelled stale previews, draft retention, full-file/split rendering and hunk follow-up',
  );
  console.log(JSON.stringify({ packaged: report.packaged, mainIpcDuringDiffMs: report.mainIpcDuringDiffMs }));
} finally {
  await app?.close();
  await provider.close();
}
