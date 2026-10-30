import { launchApp, closeApp } from '../tests/support/desktop-app.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../electron/store.ts';
import { PI_INSTALL_COMMAND, VERIFIED } from '../shared/pi-version.ts';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-compatibility-ui-'));
const store = new Store(dir);
await store.load();
const session = store.createSession();
Object.assign(store.state.settings, {
  piPath: path.resolve('tests/support/versioned-pi.mjs'),
  nodePath: process.execPath,
  agentDir: dir,
  onboardingDone: true,
});
await store.save();
let app, page;
const errors = [];
try {
  for (const [version, compatibility] of [
    [VERIFIED, 'verified'],
    ['1.1.1', 'unverified'],
    ['1.2.0', 'unverified'],
    ['2.0.0', 'unverified'],
    ['no version', 'unknown'],
  ]) {
    const recognized = compatibility !== 'unknown';
    await fs.writeFile(path.join(dir, 'fixture-version.txt'), version);
    ({ app, page } = await launchApp({
      executablePath: process.env.PI_DESKTOP_EXE,
      dataDir: dir,
      errors: errors,
    }));

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
    app = undefined;
  }
  assert.deepEqual(errors, []);
} catch (error) {
  if (page && !page.isClosed()) {
    await fs.mkdir('test-results', { recursive: true });
    await page.screenshot({ path: 'test-results/compatibility-ui-failure.png' });
  }
  throw error;
} finally {
  if (app) await closeApp(app);
  await fs.rm(dir, { recursive: true, force: true });
}
