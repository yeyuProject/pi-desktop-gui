import { launchApp, closeApp } from '../tests/support/desktop-app.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createLocalProvider, prepareRealPiFixture } from '../tests/support/local-provider.ts';

const provider = await createLocalProvider();
const fixture = await prepareRealPiFixture(provider.baseUrl, 'coding-ui');
const output = path.resolve('test-results');
await fs.mkdir(output, { recursive: true });
const settingsFile = path.join(fixture.agentDir, 'settings.json');
const settings = JSON.parse(await fs.readFile(settingsFile, 'utf8'));
await fs.writeFile(
  settingsFile,
  JSON.stringify({
    ...settings,
    defaultTools: [],
    defaultThinkingLevel: 'medium',
    defaultProjectTrust: 'always',
  }),
);
const projectSettingsFile = path.join(fixture.projectDir, '.pi', 'settings.json');
await fs.mkdir(path.dirname(projectSettingsFile), { recursive: true });
await fs.writeFile(
  projectSettingsFile,
  JSON.stringify({ retry: { maxRetries: 8 }, defaultTools: ['+find'] }),
);
const modelsFile = path.join(fixture.agentDir, 'models.json');
const models = JSON.parse(await fs.readFile(modelsFile, 'utf8'));
models.providers['local-e2e'].models[0].reasoning = true;
await fs.writeFile(modelsFile, JSON.stringify(models));
await fs.mkdir(path.join(fixture.agentDir, 'prompts'), { recursive: true });
await fs.writeFile(
  path.join(fixture.agentDir, 'prompts', 'copy.md'),
  '---\ndescription: Collision test prompt\n---\nCOLLISION_TEST $@\n',
);
// The old desktop default must not override Pi's configured default.
fixture.store.state.settings.thinking = 'low';
await fixture.store.save();
let app, page;
const errors = [];
try {
  ({ app, page } = await launchApp({
    executablePath: process.env.PI_DESKTOP_EXE,
    dataDir: fixture.dataDir,
    errors: errors,
  }));

  const input = page.getByRole('textbox', { name: '任务输入' });
  await input.waitFor();
  await page.evaluate(async (id) => {
    await window.desktop.invoke('connect', id);
    await window.desktop.invoke('setSessionThinking', id, 'low');
  }, fixture.sessionId);
  assert.equal(JSON.parse(await fs.readFile(settingsFile, 'utf8')).defaultThinkingLevel, 'medium');
  const selectedThinking = await page.evaluate(() => window.desktop.invoke('bootstrap'));
  assert.equal(selectedThinking.runtime.thinking, 'low');
  assert.equal(
    selectedThinking.state.sessions.find((session) => session.id === fixture.sessionId).thinking,
    'low',
  );

  for (const key of ['Tab', 'Enter']) {
    await input.fill('//cop');
    await page.getByRole('listbox', { name: 'Pi 命令' }).waitFor();
    await input.press(key);
    assert.equal(await input.inputValue(), '//copy ');
  }
  await input.press('Enter');
  await page.locator('.run-meta .completed').waitFor();
  assert.ok(
    provider.requests
      .at(-1)
      .messages.some((m) => m.role === 'user' && JSON.stringify(m.content).includes('COLLISION_TEST')),
  );
  console.log('PASS double-slash completion preserves the Pi command and executes its template');

  await input.fill('/settings ');
  await input.press('Enter');
  const modal = page.getByRole('dialog', { name: 'Pi 功能' });
  await modal.getByRole('button', { name: '常用设置', exact: true }).click();
  const userScope = modal.getByRole('radio', { name: '个人（所有项目）' });
  const projectScope = modal.getByRole('radio', { name: '仅当前项目' });
  const retry = modal.getByRole('checkbox', { name: '临时错误自动重试' });
  await page.waitForFunction(() => {
    const input = document.querySelector('[aria-label="临时错误自动重试"]');
    return input && !input.disabled && !input.checked;
  });
  assert.equal(await modal.locator('.tool-checks input:checked').count(), 0);
  await modal.locator('.tool-checks').getByRole('checkbox', { name: 'grep', exact: true }).check();
  const save = async () => {
    await modal.getByRole('button', { name: '保存并重新加载', exact: true }).click();
    await modal.locator('.feature-notice').filter({ hasText: '设置已保存' }).waitFor();
  };
  await save();
  assert.deepEqual(JSON.parse(await fs.readFile(settingsFile, 'utf8')).defaultTools, ['grep']);
  await modal.locator('.tool-checks').getByRole('checkbox', { name: 'grep', exact: true }).uncheck();
  assert.equal(await modal.locator('.tool-checks input:checked').count(), 0);
  await save();
  assert.deepEqual(JSON.parse(await fs.readFile(settingsFile, 'utf8')).defaultTools, []);
  await modal.locator('.tool-checks').getByRole('checkbox', { name: 'grep', exact: true }).check();
  await save();
  console.log('PASS an empty tool selection stays empty and enabling grep adds no other tools');

  await projectScope.click();
  await page.waitForFunction(() => document.querySelector('[aria-label="最多重试"]')?.value === '8');
  assert.equal(await retry.isChecked(), false);
  assert.equal(await modal.getByRole('checkbox', { name: '自动压缩上下文' }).isChecked(), false);
  assert.equal(
    await modal.locator('.tool-checks').getByRole('checkbox', { name: 'grep', exact: true }).isChecked(),
    true,
  );
  assert.equal(
    await modal.locator('.tool-checks').getByRole('checkbox', { name: 'find', exact: true }).isChecked(),
    true,
  );
  assert.equal(await modal.locator('.tool-checks input:checked').count(), 2);
  await retry.check();
  await save();
  const projectSettings = JSON.parse(await fs.readFile(projectSettingsFile, 'utf8'));
  assert.deepEqual(projectSettings, { retry: { maxRetries: 8, enabled: true }, defaultTools: ['+find'] });
  assert.equal(JSON.parse(await fs.readFile(settingsFile, 'utf8')).retry.enabled, false);
  assert.equal((await page.evaluate(() => window.desktop.invoke('bootstrap'))).runtime.autoRetry, true);
  console.log('PASS project controls display inherited values and save only explicit overrides');

  await modal.locator('.tool-checks').getByRole('checkbox', { name: 'grep', exact: true }).uncheck();
  await modal.locator('.tool-checks').getByRole('checkbox', { name: 'find', exact: true }).uncheck();
  assert.equal(await modal.locator('.tool-checks input:checked').count(), 0);
  await save();
  const resources = await page.evaluate((id) => window.desktop.invoke('resources', id), fixture.sessionId);
  const builtins = ['read', 'bash', 'powershell', 'edit', 'write', 'grep', 'find', 'ls'];
  assert.deepEqual(
    resources.activeTools.filter((name) => builtins.includes(name)),
    [],
  );
  assert.equal(await modal.locator('.tool-checks input:checked').count(), 0);
  console.log('PASS clearing project tools disables inherited tools in the running Pi');

  await userScope.click();
  await page.waitForFunction(
    () => document.querySelector('[aria-label="临时错误自动重试"]')?.checked === false,
  );
  await modal.getByRole('combobox', { name: '新会话的推理级别' }).selectOption('high');
  await save();
  assert.equal(JSON.parse(await fs.readFile(settingsFile, 'utf8')).defaultThinkingLevel, 'high');
  assert.equal(
    (await page.evaluate(() => window.desktop.invoke('bootstrap'))).runtime.thinking,
    'low',
    'existing session keeps its choice',
  );
  await modal.getByRole('button', { name: '关闭', exact: true }).last().click();
  const newSession = async (projectId) =>
    page.evaluate(async (projectId) => {
      const session = await window.desktop.invoke('newSession', projectId);
      await window.desktop.invoke('connect', session.id);
      return window.desktop.invoke('bootstrap');
    }, projectId);
  assert.equal((await newSession(fixture.projectId)).runtime.thinking, 'high');

  await input.fill('/settings ');
  await input.press('Enter');
  await modal.getByRole('button', { name: '常用设置', exact: true }).click();
  await projectScope.click();
  await page.waitForFunction(() => document.querySelector('[aria-label="最多重试"]')?.value === '8');
  await modal.getByRole('combobox', { name: '新会话的推理级别' }).selectOption('off');
  await save();
  await modal.getByRole('button', { name: '关闭', exact: true }).last().click();
  assert.equal((await newSession(fixture.projectId)).runtime.thinking, 'off');
  assert.equal((await newSession(undefined)).runtime.thinking, 'high');
  console.log(
    'PASS new sessions use Pi defaults, project overrides stay local, existing sessions retain their choice',
  );
  assert.deepEqual(errors, []);
  console.log('Coding UI PASS', fixture.dir);
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'coding-ui-failure.png') });
  throw error;
} finally {
  await closeApp(app);
  await provider.close();
}
