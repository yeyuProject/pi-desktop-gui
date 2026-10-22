import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { messageText } from '../shared/types.ts';
import { createLocalProvider, prepareRealPiFixture } from '../tests/support/local-provider.ts';
const provider = await createLocalProvider();
const fixture = await prepareRealPiFixture(provider.baseUrl, 'features-ui');
const output = path.resolve('test-results');
await fs.mkdir(output, { recursive: true });
const errors = [];
let app, page;
async function waitForState(predicate, timeout = 45000) {
  const end = Date.now() + timeout;
  do {
    const snapshot = await page.evaluate(() => window.desktop.invoke('bootstrap'));
    if (predicate(snapshot)) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < end);
  throw new Error('Desktop state did not reach expected condition');
}
try {
  app = await electron.launch({
    executablePath: process.env.PI_DESKTOP_EXE,
    args: process.env.PI_DESKTOP_EXE ? [] : [path.resolve('.')],
    env: { ...process.env, PI_DESKTOP_DATA_DIR: fixture.dataDir, PI_OFFLINE: '1' },
    timeout: 30000,
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  const input = page.getByRole('textbox', { name: '任务输入' });
  await input.waitFor();
  const png = (await fs.readFile('build/icon.png')).toString('base64');
  await input.evaluate((el, png) => {
    const d = new DataTransfer();
    d.items.add(
      new File([Uint8Array.from(atob(png), (c) => c.charCodeAt(0))], 'image.png', { type: 'image/png' }),
    );
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: d, bubbles: true }));
  }, png);
  await page.locator('.image-attachments img').waitFor();
  await input.fill('UI_IMAGE_TEST');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await page.locator('.run-meta .completed').waitFor({ timeout: 30000 });
  await page.locator('.message-images img').first().waitFor();
  assert.equal(await page.locator('.image-attachments img').count(), 0);
  assert.ok(
    provider.requests
      .at(-1)
      .messages.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'image_url')),
  );
  await page.screenshot({ path: path.join(output, 'features-images.png'), animations: 'disabled' });
  await input.fill('/tre');
  await page.getByRole('listbox', { name: 'Pi 命令' }).waitFor();
  await input.press('Tab');
  assert.equal(await input.inputValue(), '/tree ');
  await input.press('Enter');
  let modal = page.getByRole('dialog', { name: 'Pi 功能' });
  await modal.locator('.session-tree article').first().waitFor({ timeout: 30000 });
  await page.screenshot({ path: path.join(output, 'features-tree.png'), animations: 'disabled' });
  await modal.getByRole('button', { name: '会话与上下文', exact: true }).click();
  await modal.getByRole('button', { name: '立即压缩', exact: true }).waitFor();
  const toggle = modal.getByRole('checkbox', { name: '自动压缩上下文' });
  await toggle.click();
  await waitForState((b) => b.runtime.autoCompaction === true);
  await page.screenshot({ path: path.join(output, 'features-session.png'), animations: 'disabled' });
  const html = path.join(fixture.dir, 'export.html');
  await app.evaluate(({ dialog }, html) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: html });
  }, html);
  await modal.getByRole('button', { name: '导出 HTML', exact: true }).click();
  await modal.locator('.feature-notice').filter({ hasText: '已导出' }).waitFor({ timeout: 30000 });
  assert.match(await fs.readFile(html, 'utf8'), /<!DOCTYPE html>/i);
  await modal.getByRole('button', { name: '供应商与登录', exact: true }).click();
  const select = modal.getByRole('combobox', { name: '登录供应商' });
  await select.selectOption('openai');
  await modal.getByRole('button', { name: '设置 API Key', exact: true }).click();
  const secret = page.getByLabel('回复内容', { exact: true });
  await secret.waitFor();
  assert.equal(await secret.getAttribute('type'), 'password');
  await secret.fill('local-ui-test-key');
  await page.getByRole('dialog').last().getByRole('button', { name: '提交回复', exact: true }).click();
  await modal.locator('.feature-notice').filter({ hasText: '凭据已保存' }).waitFor({ timeout: 30000 });
  assert.ok(!(await modal.innerText().then((t) => t.includes('local-ui-test-key'))));
  await modal.getByRole('button', { name: '退出登录', exact: true }).click();
  await page
    .getByRole('dialog')
    .filter({ hasText: '退出供应商' })
    .getByRole('button', { name: '退出登录', exact: true })
    .click();
  await modal.locator('.feature-notice').filter({ hasText: '已移除' }).waitFor();
  await modal.getByText('添加自定义供应商', { exact: true }).click();
  await modal.getByRole('textbox', { name: '新供应商标识' }).fill('ui-provider');
  await modal.getByRole('textbox', { name: '供应商接口地址' }).fill(provider.baseUrl);
  await modal.getByLabel('新供应商密钥', { exact: true }).fill('ui-test-key');
  await modal.getByRole('textbox', { name: '新供应商模型' }).fill('local-e2e');
  await modal.getByRole('button', { name: '添加到配置', exact: true }).click();
  await modal.getByRole('button', { name: '保存并应用', exact: true }).click();
  await modal.locator('.feature-notice').filter({ hasText: '已保存并重新连接' }).waitFor({ timeout: 30000 });
  const json = JSON.parse(await fs.readFile(path.join(fixture.agentDir, 'models.json'), 'utf8'));
  assert.ok(json.providers['local-e2e']);
  assert.equal(json.providers['ui-provider'].apiKey, 'ui-test-key');
  assert.ok(
    !(await modal
      .getByRole('textbox', { name: 'Pi 配置 JSON' })
      .inputValue()
      .then((t) => t.includes('ui-test-key'))),
  );
  await page.screenshot({ path: path.join(output, 'features-providers.png'), animations: 'disabled' });
  // Real Electron + real Pi read paths complement the delayed-IPC renderer tests.
  for (const title of ['完整 Pi 设置', '供应商与登录', 'MCP 服务器']) {
    const tab = modal.getByRole('button', { name: title, exact: true });
    await tab.click();
    const editor = modal.getByRole('textbox', { name: 'Pi 配置 JSON' });
    await editor.waitFor();
    await page.waitForFunction(() => {
      const editor = document.querySelector('textarea[aria-label="Pi 配置 JSON"]');
      return editor && !editor.disabled;
    });
    const before = await editor.inputValue();
    JSON.parse(before);
    await tab.click();
    assert.equal(await editor.inputValue(), before, `${title}: selecting current tab retains content`);
    assert.equal(await editor.isDisabled(), false);
  }
  console.log('PASS real Pi settings/models/MCP same-tab selection retains editable configuration');
  await modal.getByRole('button', { name: 'MCP 服务器', exact: true }).click();
  await modal
    .getByRole('textbox', { name: 'Pi 配置 JSON' })
    .fill(
      JSON.stringify(
        { mcpServers: { 'ui-disabled': { command: 'not-a-real-program', enabled: false } } },
        null,
        2,
      ),
    );
  await modal.getByRole('button', { name: '保存并应用', exact: true }).click();
  await modal.locator('.feature-notice').filter({ hasText: '已保存并重新连接' }).waitFor({ timeout: 30000 });
  assert.equal(
    JSON.parse(await fs.readFile(path.join(fixture.agentDir, 'mcp.json'), 'utf8')).mcpServers['ui-disabled']
      .enabled,
    false,
  );
  await modal.getByRole('button', { name: 'Skills 与扩展', exact: true }).click();
  const ext = modal.locator('.resource-row').filter({ hasText: 'gui-e2e.js' }).getByRole('checkbox');
  await ext.waitFor();
  await ext.click();
  await waitForState((b) => !b.runtime.commands.some((c) => c.name === 'gui-select'));
  await ext.click();
  await waitForState((b) => b.runtime.commands.some((c) => c.name === 'gui-select'));
  await page.screenshot({ path: path.join(output, 'features-resources.png'), animations: 'disabled' });
  const pkg = path.join(fixture.dir, 'local package');
  await fs.mkdir(path.join(pkg, 'prompts'), { recursive: true });
  await fs.writeFile(
    path.join(pkg, 'package.json'),
    JSON.stringify({ name: 'desktop-test-resources', version: '1.0.0', pi: { prompts: ['prompts/*.md'] } }),
  );
  await fs.writeFile(
    path.join(pkg, 'prompts', 'desktop-test-prompt.md'),
    '---\ndescription: Local package prompt\n---\nPROMPT_TEMPLATE_TEST $@\n',
  );
  await modal.getByRole('textbox', { name: '资源包来源' }).fill(pkg);
  await modal.getByRole('button', { name: '安装', exact: true }).click();
  await waitForState((b) => b.runtime.commands.some((c) => c.name === 'desktop-test-prompt'));
  await modal.getByRole('button', { name: '更新资源包', exact: true }).click();
  await modal.getByRole('button', { name: '移除', exact: true }).click();
  await page
    .getByRole('dialog')
    .filter({ hasText: '移除资源包' })
    .getByRole('button', { name: '移除', exact: true })
    .click();
  await waitForState((b) => !b.runtime.commands.some((c) => c.name === 'desktop-test-prompt'));
  await modal.getByRole('button', { name: '更新资源包', exact: true }).waitFor();
  await page.waitForFunction(() =>
    [...document.querySelectorAll('button')].some((b) => b.textContent === '更新资源包' && !b.disabled),
  );
  console.log('PASS desktop local resource package install, update and removal');
  await modal.getByRole('button', { name: '关闭', exact: true }).last().click();
  await input.fill('/clone');
  await input.press('Enter');
  const cloned = await waitForState(
    (b) => b.state.sessions.length === 2 && b.state.selectedSessionId !== fixture.sessionId,
  );
  assert.notEqual(
    cloned.state.sessions.find((session) => session.id === cloned.state.selectedSessionId).file,
    cloned.state.sessions.find((session) => session.id === fixture.sessionId).file,
  );
  const history = await page.evaluate(
    (id) => window.desktop.invoke('readHistory', id),
    cloned.state.selectedSessionId,
  );
  assert.ok(history.some((message) => messageText(message).includes('UI_IMAGE_TEST')));
  const source = JSON.parse(await page.evaluate(() => window.desktop.invoke('diagnostics'))).sessions.find(
    (session) => session.sessionId === fixture.sessionId,
  );
  assert.equal(source.connected, true, 'cloning must keep the source connection');
  await input.fill('!!printf UI_SHELL_COMMAND');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await page.locator('.bash-message').filter({ hasText: 'UI_SHELL_COMMAND' }).waitFor({ timeout: 30000 });
  assert.deepEqual(errors, []);
  console.log('Feature UI PASS', fixture.dir);
} catch (e) {
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'features-ui-failure.png') });
  throw e;
} finally {
  if (page && !page.isClosed()) {
    await page
      .evaluate(async () => {
        const { state } = await window.desktop.invoke('bootstrap');
        await window.desktop.invoke('cancelLogin', state.selectedSessionId);
        await window.desktop.invoke('stop', state.selectedSessionId);
      })
      .catch(() => {});
  }
  await app?.close();
  await provider.close();
}
