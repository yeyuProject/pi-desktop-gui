import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect } from 'playwright/test';
import { STYLE_META } from '../shared/window-theme';
import { closeApp, launchApp } from '../tests/support/desktop-app.mjs';
import { createLocalProvider, prepareRealPiFixture } from '../tests/support/local-provider';

const provider = await createLocalProvider({ holdSlowResponses: true });
const fixture = await prepareRealPiFixture(provider.baseUrl, 'pi-update');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-desktop-update-'));
const appDir = path.join(root, 'app');
const wrapper = path.join(root, 'pi.mjs');
const versionFile = path.join(root, 'version');
const runLog = path.join(root, 'runs.jsonl');
const outcomeFile = path.join(root, 'outcome');
const releaseFile = path.join(root, 'release');
const probeLog = path.join(root, 'version-checks');
const holdProbe = path.join(root, 'hold-version-check');
let latest = '1.4.0';
let malformed = false;
let checks = 0;
const endpoint = http.createServer((request, response) => {
  checks++;
  assert.equal(request.url, '/api/latest-version');
  assert.equal(request.headers.accept, 'application/json');
  assert.match(request.headers['user-agent'] ?? '', /^pi-desktop\/.* pi\//);
  response.end(malformed ? 'not JSON' : JSON.stringify({ version: latest, note: '本地更新说明' }));
});
let app;
try {
  await new Promise((resolve) => endpoint.listen(0, '127.0.0.1', resolve));
  const address = endpoint.address();
  assert.ok(address && typeof address === 'object');
  await fs.mkdir(appDir);
  await Promise.all(
    ['dist', 'dist-electron', 'build', 'package.json'].map((name) =>
      fs.cp(name, path.join(appDir, name), { recursive: true }),
    ),
  );
  const main = path.join(appDir, 'dist-electron/main.cjs');
  const source = await fs.readFile(main, 'utf8');
  assert.equal(source.split('https://pi.dev/api/latest-version').length, 2);
  await fs.writeFile(
    main,
    source.replace(
      'https://pi.dev/api/latest-version',
      `http://127.0.0.1:${address.port}/api/latest-version`,
    ),
  );

  const realPi = fixture.store.state.settings.piPath;
  await fs.writeFile(
    wrapper,
    `
    import fs from 'node:fs/promises';
    import { setTimeout } from 'node:timers/promises';
    const version = await fs.readFile(${JSON.stringify(versionFile)}, 'utf8');
    if (process.argv[2] === '--version') {
      await fs.appendFile(${JSON.stringify(probeLog)}, 'x');
      while (await fs.stat(${JSON.stringify(holdProbe)}).catch(() => undefined)) await setTimeout(25);
      console.log(version);
    } else if (process.argv[2] === 'update' && process.argv[3] === 'pi' && process.argv.length === 4) {
      if (process.env.PI_CODING_AGENT_DIR !== ${JSON.stringify(fixture.agentDir)} || process.stdout.isTTY) process.exit(2);
      const outcome = await fs.readFile(${JSON.stringify(outcomeFile)}, 'utf8');
      await fs.appendFile(${JSON.stringify(runLog)}, JSON.stringify({ pid: process.pid, update: outcome }) + '\\n');
      console.log('准备更新 Pi');
      if (outcome === 'success') {
        for (let i = 0; i < 300; i++) {
          if (await fs.stat(${JSON.stringify(releaseFile)}).catch(() => undefined)) break;
          await setTimeout(100);
        }
        await fs.writeFile(${JSON.stringify(versionFile)}, '1.5.0');
      }
      for (let i = 0; i < 221; i++) console.log('update line ' + i);
      console.error('API_KEY=local-fixture-key');
      process.exitCode = outcome === 'failure' ? 1 : 0;
    } else if (process.argv.includes('rpc')) {
      await fs.appendFile(${JSON.stringify(runLog)}, JSON.stringify({ pid: process.pid, version }) + '\\n');
      process.env.PI_OFFLINE = '1';
      process.argv[1] = ${JSON.stringify(realPi)};
      await import(${JSON.stringify(pathToFileURL(realPi).href)});
    } else {
      process.exitCode = 3;
    }
  `,
  );
  await fs.writeFile(versionFile, '1.3.9');
  await fs.writeFile(runLog, '');
  fixture.store.state.settings.piPath = wrapper;
  await fixture.store.save();

  const launch = (offline = false) =>
    launchApp({
      args: [appDir],
      dataDir: fixture.dataDir,
      env: {
        PI_OFFLINE: offline ? '1' : '',
        HTTPS_PROXY: '',
        https_proxy: '',
        ALL_PROXY: '',
        all_proxy: '',
      },
    });
  const first = await launch();
  app = first.app;
  const badgeSelector = '.sidebar-footer .pi-update-badge';
  await expect(first.page.locator(badgeSelector)).toBeVisible();
  const settingsButton = '.sidebar-footer button:has-text("设置")';
  await first.page.locator(settingsButton).click();
  await expect(first.page.locator(badgeSelector)).toHaveCount(0);
  await first.page.getByRole('button', { name: '更新 Pi', exact: true }).click();
  const verified = first.page.getByRole('dialog', { name: '将 Pi 从 1.3.9 更新到 1.4.0' });
  await expect(verified).toContainText('本地更新说明');
  await expect(verified).not.toContainText('尚未完成桌面端回归验证');
  await verified.getByRole('button', { name: '取消', exact: true }).click();
  await expect(verified).toHaveCount(0);
  await closeApp(app);
  app = undefined;
  assert.equal(checks, 1);
  assert.deepEqual(first.errors, []);

  const launched = await launch();
  app = launched.app;
  const { page } = launched;
  const versionRow = page.locator('.pi-version-status');
  const updateButton = versionRow.getByRole('button', { name: '更新 Pi', exact: true });
  const settings = page.getByRole('dialog', { name: '设置', exact: true });
  const openSettings = () => page.locator(settingsButton).click();
  const closeSettings = () =>
    settings.locator('header').getByRole('button', { name: '关闭', exact: true }).click();
  const begin = async () => {
    await updateButton.click();
    const confirm = page.getByRole('dialog', { name: '将 Pi 从 1.3.9 更新到 1.5.0' });
    await expect(confirm).toContainText('尚未完成桌面端回归验证');
    await confirm.getByRole('button', { name: '更新', exact: true }).click();
  };
  const prompt = async (message) => {
    await page.getByRole('textbox', { name: '任务输入' }).fill(message);
    await page.locator('.send-button').click();
  };
  const runs = async () =>
    (await fs.readFile(runLog, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  await openSettings();
  await expect(versionRow).toContainText('可更新到 1.4.0');
  await expect(page.locator(badgeSelector)).toHaveCount(0);
  assert.equal(checks, 1);
  latest = '1.5.0';
  malformed = true;
  await versionRow.getByRole('button', { name: '检查更新' }).click();
  await expect(versionRow).toContainText('检查失败');
  malformed = false;
  await versionRow.getByRole('button', { name: '重试' }).click();
  await expect(versionRow).toContainText('可更新到 1.5.0');
  assert.equal(checks, 3);
  await fs.writeFile(holdProbe, '');
  await page.evaluate(() => {
    window.pendingPiDiagnostics = window.desktop.invoke('diagnostics');
  });
  await expect(updateButton).toBeDisabled();
  await expect(updateButton).toHaveAttribute('title', '请等待所有任务结束后再更新 Pi');
  await fs.unlink(holdProbe);
  await page.evaluate(() => window.pendingPiDiagnostics);
  await expect(updateButton).toBeEnabled();
  await page.evaluate(() => window.desktop.invoke('saveSettings', { updateProxy: 'socks4://127.0.0.1:9' }));
  await expect(updateButton).toBeDisabled();
  await expect(updateButton).toHaveAttribute('title', /SOCKS4/);
  await assert.rejects(
    page.evaluate(() => window.desktop.invoke('updatePi')),
    /SOCKS4/,
  );
  await page.evaluate(() => window.desktop.invoke('saveSettings', { updateProxy: '' }));
  await expect(updateButton).toBeEnabled();
  for (const style of ['codex', 'claude', 'classic']) {
    await settings.getByRole('button', { name: '外观与编辑器', exact: true }).click();
    await settings.getByRole('button', { name: STYLE_META[style].label, exact: true }).click();
    await settings.getByRole('button', { name: '运行环境', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-style', style);
    await expect(updateButton).toBeVisible();
    assert.equal(await versionRow.evaluate((el) => el.scrollWidth <= el.clientWidth), true, style);
    await settings.getByRole('button', { name: '保存设置', exact: true }).click();
    await expect(updateButton).toBeEnabled();
  }

  await closeSettings();
  await prompt('E2E_SLOW busy while checking Pi');
  await expect.poll(() => provider.heldSlowResponseCount, { timeout: 30_000 }).toBe(1);
  await openSettings();
  await expect(updateButton).toBeDisabled();
  await expect(updateButton).toHaveAttribute('title', '请等待所有任务结束后再更新 Pi');
  await closeSettings();
  await page.locator('.stop-button').click();
  await expect(page.locator('.stop-button')).toHaveCount(0, { timeout: 30_000 });

  await page.getByRole('button', { name: '审批模式' }).click();
  await page.getByRole('menuitemradio', { name: /^确认修改/ }).click();
  await prompt('E2E_STOP wait for command approval');
  const approval = page.locator('.approval-card.shell');
  await expect(approval).toBeVisible({ timeout: 30_000 });
  await openSettings();
  await expect(updateButton).toBeDisabled();
  await closeSettings();
  await approval.getByRole('button', { name: '拒绝…', exact: true }).click();
  const denial = approval.getByRole('textbox', { name: '拒绝原因' });
  await denial.fill('本次只验证审批期间的更新按钮');
  await denial.press('Enter');
  await expect(approval).toHaveCount(0, { timeout: 30_000 });
  await expect(page.locator('.stop-button')).toHaveCount(0, { timeout: 30_000 });

  await page.evaluate((id) => {
    void window.desktop.invoke('sideChatSend', id, {
      id: 'pi-update-side',
      scope: 'all',
      prompt: 'E2E_SIDE_HOLD',
      quotes: [],
    });
  }, fixture.sessionId);
  await expect.poll(() => provider.heldSlowResponseCount, { timeout: 30_000 }).toBe(1);
  await openSettings();
  await expect(updateButton).toBeDisabled();
  await closeSettings();
  await page.evaluate((id) => window.desktop.invoke('sideChatStop', id), fixture.sessionId);
  await expect.poll(() => provider.heldSlowResponseCount).toBe(0);

  await openSettings();
  await fs.writeFile(outcomeFile, 'failure');
  await begin();
  const failed = page.getByRole('status').filter({ hasText: '更新失败' });
  await expect(failed).toContainText('退出（代码 1）');
  await expect(failed.locator('pre')).toContainText('API_KEY=[已隐藏]');
  await expect(failed.locator('pre')).not.toContainText('local-fixture-key');
  assert.equal((await failed.locator('pre').textContent())?.split('\n').length, 20);
  await expect(page.getByRole('button', { name: '复制命令', exact: true })).toBeVisible();
  await expect(versionRow.locator('strong')).toHaveText('1.3.9');
  assert.ok((await runs()).some((run) => run.version === '1.3.9'));
  for (const run of await runs()) assert.throws(() => process.kill(run.pid, 0), { code: 'ESRCH' });
  await closeSettings();
  await prompt('send after failed Pi update');
  await expect(page.getByText('OK', { exact: true }).last()).toBeVisible({ timeout: 30_000 });
  await openSettings();

  await fs.writeFile(outcomeFile, 'unchanged');
  await begin();
  await expect(failed).toContainText('检测到的版本仍是 1.3.9');
  await expect(failed).toContainText(wrapper);

  await fs.writeFile(versionFile, latest);
  await settings.getByRole('button', { name: '重新检测' }).click();
  await expect(versionRow).toContainText('已是最新');
  await expect(updateButton).toHaveCount(0);
  await expect(failed).toHaveCount(0);
  await fs.writeFile(versionFile, '1.3.9');
  await settings.getByRole('button', { name: '重新检测' }).click();
  await expect(updateButton).toBeEnabled();
  await begin();
  await expect(failed).toContainText(wrapper);
  const otherPi = path.join(root, 'second-pi.mjs');
  await fs.copyFile(wrapper, otherPi);
  await page.evaluate((piPath) => window.desktop.invoke('saveSettings', { piPath }), otherPi);
  await settings.getByRole('button', { name: '重新检测' }).click();
  await expect(failed).toHaveCount(0);
  await expect(updateButton).toBeEnabled();
  await page.evaluate((piPath) => window.desktop.invoke('saveSettings', { piPath }), wrapper);
  await page.evaluate(() => window.desktop.invoke('detect'));
  assert.equal(checks, 3);

  await fs.writeFile(outcomeFile, 'success');
  // 只在隔离的 Electron 进程中提前触发超时，让第一次系统停止命令失败；重试走真实进程树清理。
  await app.evaluate(() => {
    const schedule = globalThis.setTimeout;
    globalThis.setTimeout = function (callback, delay, ...args) {
      if (delay !== 600_000 || callback.name !== 'stop') return schedule(callback, delay, ...args);
      globalThis.setTimeout = schedule;
      return schedule(() => {
        const prototype = process.getBuiltinModule('node:child_process').ChildProcess.prototype;
        const spawn = prototype.spawn;
        prototype.spawn = function (options) {
          if (!['taskkill.exe', 'ps'].includes(options.file)) return spawn.call(this, options);
          prototype.spawn = spawn;
          throw new Error('Fixture: the OS denied the first stop attempt');
        };
        callback(...args);
      }, 1500);
    };
  });
  await begin();
  const retryStop = settings.getByRole('button', { name: '重试停止', exact: true });
  await expect(retryStop).toBeVisible();
  await expect(page.locator('.new-session')).toBeDisabled();
  const interrupted = (await runs()).findLast((run) => run.update === 'success');
  assert.ok(interrupted);
  assert.doesNotThrow(() => process.kill(interrupted.pid, 0));
  await retryStop.click();
  await expect(failed).toContainText('更新 Pi 超时，已停止更新');
  assert.throws(() => process.kill(interrupted.pid, 0), { code: 'ESRCH' });
  await expect(page.locator('.new-session')).toBeEnabled();

  await begin();
  await expect(versionRow).toContainText('正在更新 Pi…');
  await expect(page.locator('.pi-update-tail')).toContainText('准备更新 Pi');
  const beforeDiagnostics = await fs.readFile(probeLog, 'utf8');
  const diagnostics = await page.evaluate(() => window.desktop.invoke('diagnostics'));
  assert.equal(JSON.parse(diagnostics).environment.version, '1.3.9');
  assert.equal(await fs.readFile(probeLog, 'utf8'), beforeDiagnostics);
  const projectsBefore = await page.evaluate(() => window.desktop.invoke('navigationState'));
  await assert.rejects(
    page.evaluate(() => window.desktop.invoke('addProject')),
    /Pi 正在更新/,
  );
  const projectsAfter = await page.evaluate(() => window.desktop.invoke('navigationState'));
  assert.deepEqual(projectsAfter.state.projects, projectsBefore.state.projects);
  assert.equal(projectsAfter.state.selectedSessionId, projectsBefore.state.selectedSessionId);
  await expect(page.locator('.project-list > .section-heading button')).toBeDisabled();
  await expect(page.locator('.new-session')).toBeDisabled();
  await expect(page.locator('.send-button')).toBeDisabled();
  assert.equal(
    await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('new-session').enabled),
    false,
  );
  await settings.getByRole('button', { name: '模型连接', exact: true }).click();
  await expect(settings.getByRole('button', { name: '连接 Pi', exact: true })).toBeDisabled();
  await settings.getByRole('button', { name: '运行环境', exact: true }).click();
  const errors = await page.evaluate(
    async (id) =>
      Promise.all(
        [
          window.desktop.invoke('newSession'),
          window.desktop.invoke('connect', id),
          window.desktop.invoke('send', id, 'blocked', [], 'steer'),
        ].map((promise) =>
          promise.then(
            () => '',
            (error) => error.message,
          ),
        ),
      ),
    fixture.sessionId,
  );
  assert.ok(
    errors.every((error) => error.includes('Pi 正在更新')),
    errors.join('\n'),
  );
  await page.evaluate(() => window.desktop.invoke('quit'));
  const quitWarning = page.getByRole('dialog', { name: 'Pi 正在更新', exact: true });
  await expect(quitWarning).toContainText('请等 Pi 更新结束后再退出');
  await quitWarning.getByRole('button', { name: '关闭', exact: true }).click();
  await page.evaluate(() => {
    window.maxPiUpdateLines = 0;
    window.desktop.onEvent((event) => {
      if (event.type === 'piUpdate' && event.piUpdate.status === 'updating')
        window.maxPiUpdateLines = Math.max(window.maxPiUpdateLines, event.piUpdate.output?.length ?? 0);
    });
  });
  await fs.writeFile(releaseFile, 'continue');
  await expect(versionRow.locator('strong')).toHaveText('1.5.0');
  await expect(versionRow).toContainText('已是最新');
  await expect(page.getByText('Pi 已更新到 1.5.0', { exact: true })).toBeVisible();
  assert.equal(
    await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('new-session').enabled),
    true,
  );
  assert.equal(await page.evaluate(() => window.maxPiUpdateLines), 200);
  for (const run of await runs()) assert.throws(() => process.kill(run.pid, 0), { code: 'ESRCH' });

  await closeSettings();
  const previousReplies = await page.getByText('OK', { exact: true }).count();
  await prompt('send after successful Pi update');
  await expect.poll(async () => (await runs()).some((run) => run.version === '1.5.0')).toBe(true);
  await expect(page.getByText('OK', { exact: true })).toHaveCount(previousReplies + 1, { timeout: 30_000 });
  await expect(page.locator('.stop-button')).toHaveCount(0, { timeout: 30_000 });
  assert.deepEqual(launched.errors, []);
  await closeApp(app);
  app = undefined;

  const offline = await launch(true);
  app = offline.app;
  await offline.page.locator(settingsButton).click();
  await expect(offline.page.locator('.pi-version-status')).toContainText('1.5.0');
  await offline.page.getByRole('button', { name: '检查更新', exact: true }).click();
  assert.equal(checks, 3);
  console.log('PASS Pi update check, persistence, confirmation, process lifecycle, offline and settings UI');
} catch (error) {
  const [page] = app?.windows() ?? [];
  if (page)
    console.error(
      await page
        .locator('body')
        .innerText()
        .catch(() => ''),
    );
  throw error;
} finally {
  await fs.rm(holdProbe, { force: true });
  await fs.writeFile(releaseFile, 'continue');
  const [page] = app?.windows() ?? [];
  await page
    ?.locator('.pi-version-status')
    .getByText('正在更新 Pi…', { exact: true })
    .waitFor({ state: 'detached', timeout: 10_000 })
    .catch(() => {});
  await closeApp(app);
  endpoint.closeAllConnections();
  await new Promise((resolve) => endpoint.close(() => resolve()));
  await provider.close();
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(fixture.dir, { recursive: true, force: true });
}
