import { launchApp, closeApp } from '../tests/support/desktop-app.mjs';
import { expect } from 'playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
import { Store } from '../electron/store.ts';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-review-followup-ui-'));
const projectDir = path.join(dir, 'project');
const agentDir = path.join(dir, 'agent');
const marker = path.join(dir, 'package-actions.jsonl');
await fs.mkdir(projectDir);
await fs.mkdir(agentDir);
await exec('git', ['init', '-b', 'main'], { cwd: projectDir });
for (const name of ['a.txt', 'b.txt', 'c.txt']) await fs.writeFile(path.join(projectDir, name), 'before');
const wrapper = path.join(dir, 'fixture-cli.mjs');
await fs.writeFile(
  wrapper,
  `
import fs from 'node:fs';
if (['install', 'update', 'remove'].includes(process.argv[2])) {
  fs.appendFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2)) + '\\n');
} else await import(${JSON.stringify(pathToFileURL(path.resolve('tests/support/fixture-pi.mjs')).href)});
`,
);
const store = new Store(dir);
await store.load();
const project = {
  id: randomUUID(),
  name: '修复验收项目',
  path: projectDir,
  trusted: true,
  createdAt: Date.now(),
};
store.state.projects.push(project);
const session = store.createSession(project.id);
Object.assign(store.state.settings, {
  onboardingDone: true,
  piPath: wrapper,
  nodePath: process.execPath,
  agentDir,
});
await store.save();
let app, page;
const errors = [];
const actions = async () =>
  (await fs.readFile(marker, 'utf8').catch(() => ''))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
try {
  ({ app, page } = await launchApp({ dataDir: dir, pageTimeout: 20000, errors: errors }));

  await page.getByRole('textbox', { name: '任务输入' }).waitFor();
  const request = (action, source, local) =>
    page.evaluate(
      ([id, action, source, local]) => window.desktop.invoke('packageAction', id, action, source, local),
      [session.id, action, source, local],
    );
  for (const action of ['install', 'update']) {
    const pending = request(action, action === 'install' ? 'npm:fixture-package' : '', false);
    const dialog = page.getByRole('dialog', {
      name: action === 'install' ? '安装资源包并允许执行其代码？' : '更新资源包并允许执行其代码？',
      exact: true,
    });
    await dialog.waitFor();
    await expect(dialog).toContainText('npm 安装脚本');
    await expect(dialog).toContainText('个人配置');
    if (action === 'install') await expect(dialog).toContainText('npm:fixture-package');
    else await expect(dialog).toContainText(projectDir);
    assert.deepEqual(await actions(), []);
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(await pending, false);
    assert.deepEqual(await actions(), []);
  }
  for (const action of ['install', 'update']) {
    const pending = request(action, action === 'install' ? './fixture-local-package' : '', true);
    const dialog = page.getByRole('dialog', {
      name: action === 'install' ? '安装资源包并允许执行其代码？' : '更新资源包并允许执行其代码？',
      exact: true,
    });
    await dialog.waitFor();
    await expect(dialog).toContainText(projectDir);
    await dialog
      .getByRole('button', { name: action === 'install' ? '安装并允许执行' : '更新并允许执行', exact: true })
      .click();
    await pending;
  }
  assert.deepEqual(await actions(), [
    ['install', './fixture-local-package', '--local'],
    ['update', '--extensions'],
  ]);
  console.log(
    'PASS package installation/update cannot execute before main-process confirmation; scopes and cancellation are enforced',
  );

  // Windows holds a running child's working directory open; release it before
  // replacing the fixture directory with a file for the shell safety check.
  const stopping = page.evaluate((id) => window.desktop.invoke('forceStop', id), session.id);
  const stopDialog = page.getByRole('dialog', { name: '强制结束当前 Pi 会话进程？', exact: true });
  await expect(stopDialog).toContainText('后台服务可能继续占用端口');
  await stopDialog.getByRole('button', { name: '强制结束', exact: true }).click();
  assert.equal(await stopping, true);

  await app.evaluate(({ shell }) => {
    globalThis.openedDirectories = [];
    shell.openPath = async (file) => {
      globalThis.openedDirectories.push(file);
      return '';
    };
  });
  await fs.rename(projectDir, projectDir + '-saved');
  await fs.writeFile(projectDir, 'not a directory');
  await assert.rejects(
    page.evaluate((id) => window.desktop.invoke('revealSessionDirectory', id), session.id),
    /有效目录/,
  );
  assert.deepEqual(await app.evaluate(() => globalThis.openedDirectories), []);
  await fs.unlink(projectDir);
  await fs.rename(projectDir + '-saved', projectDir);
  await page.evaluate((id) => window.desktop.invoke('revealSessionDirectory', id), session.id);
  assert.deepEqual(await app.evaluate(() => globalThis.openedDirectories), [projectDir]);
  console.log('PASS opening a working directory rejects a file before invoking the system shell');

  const configPath = path.join(agentDir, 'settings.json');
  await fs.writeFile(configPath, '\uFEFF{"unknownSetting":true,}');
  await page.getByRole('button', { name: 'Pi 功能', exact: true }).click();
  const features = page.getByRole('dialog', { name: 'Pi 功能', exact: true });
  await features.getByRole('button', { name: '完整 Pi 设置', exact: true }).click();
  await expect(features.getByRole('textbox', { name: 'Pi 配置 JSON' })).toHaveValue(
    '{"unknownSetting":true,}',
  );
  await expect(features.getByRole('alert')).toContainText('原文可能包含密钥');
  await expect(features).toContainText(configPath);
  await features.getByRole('textbox', { name: 'Pi 配置 JSON' }).fill('{"unknownSetting":true,"fixed":true}');
  await features.getByRole('button', { name: '保存并应用', exact: true }).click();
  await expect
    .poll(async () => {
      try {
        return JSON.parse(await fs.readFile(configPath, 'utf8')).fixed;
      } catch {
        return false;
      }
    })
    .toBe(true);
  assert.equal(await fs.readFile(configPath + '.desktop-backup', 'utf8'), '\uFEFF{"unknownSetting":true,}');
  await expect(features.getByRole('alert')).toHaveCount(0);
  await features.getByRole('button', { name: '关闭', exact: true }).last().click();
  console.log(
    'PASS malformed/BOM configuration can be repaired in the editor and retains its original backup',
  );

  await page.evaluate(
    (id) => window.desktop.invoke('send', id, 'checkpoint fixture', [], 'steer'),
    session.id,
  );
  await page.waitForFunction(
    async () => (await window.desktop.invoke('bootstrap')).runtime.status === 'completed',
  );
  const checkpoint = (await page.evaluate((id) => window.desktop.invoke('checkpoints', id), session.id)).at(
    -1,
  );
  assert.ok(checkpoint);
  for (const name of ['a.txt', 'b.txt', 'c.txt']) await fs.writeFile(path.join(projectDir, name), 'after');
  const preview = await page.evaluate(
    ([id, checkpointId]) => window.desktop.invoke('checkpointPreview', id, checkpointId),
    [session.id, checkpoint.id],
  );
  await app.evaluate(async () => {
    const fs = process.getBuiltinModule('fs/promises');
    const path = process.getBuiltinModule('path');
    const original = fs.writeFile;
    globalThis.restoreWriteFile = () => {
      fs.writeFile = original;
    };
    fs.writeFile = async (...args) => {
      if (path.basename(String(args[0])) === 'b.txt') throw new Error('fixture write denied');
      return original(...args);
    };
  });
  await page.evaluate(() => {
    window.undoRefreshes = 0;
    window.desktop.onEvent((event) => {
      if (event.type === 'workspaceChanged' && !event.changedPaths) window.undoRefreshes++;
    });
  });
  try {
    await assert.rejects(
      page.evaluate(
        ([id, checkpointId, revision]) =>
          window.desktop.invoke('revertCheckpoint', id, checkpointId, ['a.txt', 'b.txt', 'c.txt'], revision),
        [session.id, checkpoint.id, preview.revision],
      ),
      /已恢复 1 个文件/,
    );
    await page.waitForFunction(() => window.undoRefreshes > 0);
    assert.equal(await fs.readFile(path.join(projectDir, 'a.txt'), 'utf8'), 'before');
    assert.equal(await fs.readFile(path.join(projectDir, 'c.txt'), 'utf8'), 'after');
  } finally {
    await app.evaluate(() => globalThis.restoreWriteFile());
  }
  console.log('PASS partial undo reports completed files and emits a workspace refresh on failure');
  // The readiness component is shown in an empty chat, while a configured model remains available.
  const fresh = await page.evaluate(() => window.desktop.invoke('newSession'));
  await page.evaluate((id) => window.desktop.invoke('connect', id), fresh.id);

  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.send('desktop:event', {
      type: 'environment',
      environment: {
        supported: true,
        compatibility: 'verified',
        piPath: '/fixture/pi',
        agentDir: '/fixture/agent',
        authExists: true,
        modelsExist: true,
        errors: ['missing bash'],
      },
    }),
  );
  await expect(page.getByRole('region', { name: '开始前检查' })).toContainText('执行命令会失败');
  await expect(page.getByRole('button', { name: '重新检查运行环境', exact: true })).toBeVisible();
  assert.deepEqual(errors, []);
  await fs.mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/review-followup-ui.png' });
  console.log(
    'PASS readiness remains incomplete when Bash is unavailable, even with Pi and a model connected',
  );
} finally {
  await closeApp(app);
  await fs.rm(dir, { recursive: true, force: true });
}
