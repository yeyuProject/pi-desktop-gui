import { launchApp, closeApp } from '../tests/support/desktop-app.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import { once } from 'node:events';
import path from 'node:path';
import { Store } from '../electron/store.ts';
import { PI_INSTALL_COMMAND, VERIFIED } from '../shared/pi-version.ts';

// Each version exercises a cold start, including first-run compatibility detection.
async function verifyVersion(version, compatibility) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-compatibility-ui-'));
  const dataDir = path.join(dir, 'desktop');
  const agentDir = path.join(dir, 'agent');
  let app, page;
  const errors = [];
  try {
    await fs.mkdir(agentDir);
    const store = new Store(dataDir);
    await store.load();
    const session = store.createSession();
    Object.assign(store.state.settings, {
      piPath: path.resolve('tests/support/versioned-pi.mjs'),
      nodePath: process.execPath,
      agentDir,
      onboardingDone: true,
    });
    await store.save();
    const recognized = compatibility !== 'unknown';
    await fs.writeFile(path.join(agentDir, 'fixture-version.txt'), version);
    ({ app, page } = await launchApp({
      executablePath: process.env.PI_DESKTOP_EXE,
      dataDir,
      errors: errors,
    }));

    const child = app.process();
    child.once('exit', (code, signal) =>
      console.log('Electron exit', { version, pid: child.pid, code, signal }),
    );
    const input = page.getByRole('textbox', { name: '任务输入' });
    await input.waitFor();
    const notice = page.getByLabel('Pi 版本兼容性');
    if (recognized) {
      await page.evaluate((id) => window.desktop.invoke('connect', id), session.id);
      await page.getByRole('region', { name: '开始前检查' }).waitFor({ state: 'detached' });
      assert.equal(await notice.count(), 0);
      await input.fill('compatibility UI test');
      await page.getByRole('button', { name: '发送任务', exact: true }).click();
      await page.locator('.run-meta .completed').waitFor();
    } else {
      await notice.waitFor();
      assert.match(await notice.innerText(), /未检测到可识别的 Pi 版本/);
      await input.fill('blocked by unrecognized entry');
      assert.equal(await page.getByRole('button', { name: '发送任务', exact: true }).isDisabled(), true);
      await assert.rejects(
        page.evaluate((id) => window.desktop.invoke('send', id, 'blocked', [], 'steer'), session.id),
        /未检测到可识别的 Pi 版本/,
      );
      await notice.getByRole('button', { name: '复制代码' }).click();
      await notice.getByRole('button', { name: '复制代码' }).getByText('已复制', { exact: true }).waitFor();
      assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), PI_INSTALL_COMMAND);
    }
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('button', { name: '运行环境', exact: true }).click();
    const versionText = await page.locator('.environment-status > div').first().locator('strong').innerText();
    if (recognized) assert.equal(versionText, version);
    else assert.match(versionText, /未知/);
    assert.equal(
      await page.locator('.settings-content').getByLabel('Pi 版本兼容性').count(),
      recognized ? 0 : 1,
    );
    const diagnostic = await page.evaluate(() => window.desktop.invoke('diagnostics'));
    assert.match(diagnostic, new RegExp(`"piCompatibility": "${compatibility}"`));
    console.log(`PASS ${version} welcome/settings, sending policy and diagnostic compatibility`);
    await app.close();
    if (child.exitCode === null && child.signalCode === null)
      await once(child, 'exit', { signal: AbortSignal.timeout(15000) });
    assert.equal(child.exitCode, 0, `Electron exited with signal ${child.signalCode}`);
    assert.deepEqual(errors, []);
  } catch (error) {
    console.error('Compatibility case failed', { version, errors });
    if (page && !page.isClosed()) {
      await fs.mkdir('test-results', { recursive: true });
      await page.screenshot({ path: 'test-results/compatibility-ui-failure.png' }).catch(() => {});
    }
    throw error;
  } finally {
    try {
      await closeApp(app);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
}
for (const [version, compatibility] of [
  [VERIFIED, 'verified'],
  ['1.1.1', 'unverified'],
  ['1.2.0', 'unverified'],
  ['2.0.0', 'unverified'],
  ['no version', 'unknown'],
])
  await verifyVersion(version, compatibility);
