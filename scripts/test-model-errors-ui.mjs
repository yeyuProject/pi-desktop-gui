import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { createLocalProvider, prepareRealPiFixture } from '../tests/support/local-provider.ts';

// The unmodified Pi CLI talks only to the generated local provider. The Electron update
// service is disabled by PI_DESKTOP_DATA_DIR, and PI_OFFLINE disables Pi online discovery.
process.env.PI_OFFLINE = '1';
const provider = await createLocalProvider();
const fixture = await prepareRealPiFixture(provider.baseUrl, 'model-errors-ui');
const sessionId = fixture.sessionId;
const secret = 'sk-test12345678901234567890';
const output = path.resolve('output/playwright', `model-errors-ui-${process.platform}`);
await fs.mkdir(output, { recursive: true });
await Promise.all(
  ['result.json', 'failure.png', 'failure.txt'].map((name) =>
    fs.rm(path.join(output, name), { force: true }),
  ),
);
const modelsFile = path.join(fixture.agentDir, 'models.json');
const models = JSON.parse(await fs.readFile(modelsFile, 'utf8'));
models.providers['local-e2e'].models.push({
  ...models.providers['local-e2e'].models[0],
  id: 'local-e2e-alternate',
  name: '本地验收备用模型',
});
await fs.writeFile(modelsFile, JSON.stringify(models));
const settingsFile = path.join(fixture.agentDir, 'settings.json');
const settings = JSON.parse(await fs.readFile(settingsFile, 'utf8'));
settings.compaction = { enabled: false, keepRecentTokens: 1, reserveTokens: 1024 };
await fs.writeFile(settingsFile, JSON.stringify(settings));

let app, page;
const rendererErrors = [];
const checks = [];
const screenshots = [];
const wait = async (condition, message) => {
  const start = Date.now();
  while (!(await condition())) {
    if (Date.now() - start > 30000) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
};
const launch = async () => {
  app = await electron.launch({
    executablePath: process.env.PI_DESKTOP_EXE,
    args: process.env.PI_DESKTOP_EXE ? [] : [path.resolve('.')],
    env: { ...process.env, PI_OFFLINE: '1', PI_DESKTOP_DATA_DIR: fixture.dataDir },
    timeout: 60000,
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(30000);
  page.on('pageerror', (error) => rendererErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') rendererErrors.push(message.text());
  });
  await app.evaluate(({ BrowserWindow, session }) => {
    globalThis.modelErrorExternalRequests = [];
    session.defaultSession.webRequest.onBeforeRequest(
      { urls: ['http://*/*', 'https://*/*'] },
      (request, callback) => {
        globalThis.modelErrorExternalRequests.push(request.url);
        callback({ cancel: true });
      },
    );
    const window = BrowserWindow.getAllWindows()[0];
    window.setContentSize(1360, 960);
    window.focus();
  });
  await page.getByRole('textbox', { name: '任务输入' }).waitFor();
  await page.bringToFront();
};
const bootstrap = () => page.evaluate(() => window.desktop.invoke('bootstrap'));
const card = () => page.locator('.model-error-card');
const screenshot = async (name) => {
  const file = path.join(output, `${name}.png`);
  await page.screenshot({ path: file, animations: 'disabled' });
  screenshots.push(file);
};
const pass = (name) => {
  checks.push(name);
  console.log('PASS', name);
};
const assertSafe = (text, label) =>
  assert.ok(!text.includes(secret), `${label} exposed the fixture credential`);
const assertHistorySafe = async () => {
  const history = await page.evaluate((id) => window.desktop.invoke('readHistory', id), sessionId);
  const failure = history.find((message) => message.errorMessage?.includes('Invalid API key'));
  assert.ok(failure, 'the authentication failure must remain visible in history');
  assert.match(failure.errorMessage, /已隐藏/);
  assertSafe(JSON.stringify(history), 'history IPC');
};
const failWith = async (prompt, kind, title) => {
  const before = (await bootstrap()).runtime.startedAt;
  await page.getByRole('textbox', { name: '任务输入' }).fill(prompt);
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await wait(async () => {
    const { runtime } = await bootstrap();
    return runtime.startedAt !== before && runtime.status === 'error' && runtime.errorKind === kind;
  }, `The ${kind} failure did not settle`);
  await page.getByRole('alert', { name: title, exact: true }).waitFor();
  assertSafe(await page.locator('body').innerText(), 'rendered error');
};
const closeFeature = () =>
  page.locator('.modal > header').getByRole('button', { name: '关闭', exact: true }).click();
const closeApp = async () => {
  assert.deepEqual(await app.evaluate(() => globalThis.modelErrorExternalRequests), []);
  await app.close();
  app = undefined;
};

try {
  await launch();
  await page.getByRole('textbox', { name: '任务输入' }).fill('保留这些上下文用于压缩验收。'.repeat(80));
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await wait(
    async () => (await bootstrap()).runtime.status === 'completed',
    'The initial conversation did not complete',
  );
  await failWith('E2E_401', 'auth', '供应商拒绝了凭据');
  await card().getByText('查看详细信息', { exact: true }).click();
  await card().getByRole('button', { name: '复制详细信息', exact: true }).click();
  const copied = await app.evaluate(({ clipboard }) => clipboard.readText());
  assert.match(copied, /401|Invalid API key/);
  assert.match(copied, /已隐藏/);
  assertSafe(copied, 'clipboard');
  assertSafe(await page.evaluate(() => window.desktop.invoke('diagnostics')), 'diagnostics');
  await assertHistorySafe();
  await screenshot('auth-details');
  await card().getByRole('button', { name: '管理供应商与登录', exact: true }).click();
  await page.locator('.feature-layout nav button.active').filter({ hasText: '供应商与登录' }).waitFor();
  await closeFeature();
  pass(
    'authentication card opens providers; rendered details, clipboard, history and diagnostics redact the key',
  );
  const persisted = (await bootstrap()).state.sessions.find((session) => session.id === sessionId);
  assert.ok(
    (await fs.readFile(persisted.file, 'utf8')).includes(secret),
    'fixture history contains the raw provider error before the IPC boundary',
  );
  await closeApp();
  await launch();
  await assertHistorySafe();
  pass('a fresh application reads the stored provider failure through the redacted history boundary');

  for (let i = 0; i < 3; i++) await failWith('E2E_429', 'busy', '请求过多或服务繁忙');
  await card().getByText('已连续失败 3 次。', { exact: false }).waitFor();
  assert.equal((await bootstrap()).runtime.errorCount, 3);
  await screenshot('busy-three-failures');
  const beforeRetry = provider.requests.length;
  await card().getByRole('button', { name: '重新生成', exact: true }).click();
  await wait(() => provider.requests.length > beforeRetry, 'regenerate did not reach the local provider');
  await wait(async () => {
    const { runtime } = await bootstrap();
    return runtime.status === 'error' && runtime.errorKind === 'busy' && runtime.errorCount === 4;
  }, 'The fourth failure did not settle');
  pass('three consecutive rate-limit failures are counted; regenerate performs a fourth real request');

  await failWith('E2E_QUOTA', 'quota', '账户额度不足或已欠费');
  assert.equal((await bootstrap()).runtime.errorCount, 1);
  await card().getByRole('button', { name: '查看额度处理说明', exact: true }).click();
  await card()
    .getByText(/请登录当前模型供应商的网站/)
    .waitFor();
  await screenshot('quota-instructions');
  await page.evaluate(() => window.desktop.invoke('saveSettings', { fontScale: 2 }));
  await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--font-scale') === '2');
  const layout = await card().evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const send = document.querySelector('.send-button').getBoundingClientRect();
    return {
      insideViewport: bounds.left >= 0 && bounds.right <= window.innerWidth,
      sendVisible: send.top >= 0 && send.bottom <= window.innerHeight,
      buttonsInside: [...element.querySelectorAll('button')].every((button) => {
        const rect = button.getBoundingClientRect();
        return rect.left >= bounds.left && rect.right <= bounds.right;
      }),
      textFits: [...element.querySelectorAll('p, pre')].every(
        (text) => text.scrollWidth <= text.clientWidth + 1,
      ),
    };
  });
  assert.deepEqual(layout, { insideViewport: true, sendVisible: true, buttonsInside: true, textFits: true });
  await card().getByRole('button', { name: '查看额度处理说明', exact: true }).click();
  await card().getByRole('button', { name: '查看额度处理说明', exact: true }).click();
  await screenshot('quota-font-200-percent');
  await page.evaluate(() => window.desktop.invoke('saveSettings', { fontScale: 1 }));
  pass('quota guidance stays in the app and the card remains readable at 200 percent font size');

  await failWith('E2E_OVERFLOW', 'context', '对话超出模型上下文');
  await screenshot('context-actions');
  const beforeCompact = provider.requests.length;
  await card().getByRole('button', { name: '压缩上下文', exact: true }).click();
  await wait(async () => (await bootstrap()).runtime.status === 'idle', 'Compaction did not settle');
  assert.ok(provider.requests.length > beforeCompact, 'compaction must call the local provider');
  const tree = await page.evaluate((id) => window.desktop.invoke('sessionTree', id), sessionId);
  assert.ok(
    tree.some((entry) => entry.type === 'compaction'),
    'Pi must persist a compaction entry',
  );
  await failWith('E2E_OVERFLOW', 'context', '对话超出模型上下文');
  await card().getByRole('button', { name: '开启自动压缩', exact: true }).click();
  await wait(
    async () => (await bootstrap()).runtime.autoCompaction === true,
    'Automatic compaction was not enabled',
  );
  pass('context actions perform and persist real compaction, and enable automatic compaction');

  await failWith('E2E_MODEL', 'model', '模型不存在或无权使用');
  await card().getByRole('button', { name: '选择模型', exact: true }).click();
  const picker = page.getByRole('dialog', { name: '模型与推理级别', exact: true });
  await picker.waitFor();
  await screenshot('model-picker');
  await picker.getByRole('option', { name: /本地验收备用模型/ }).click();
  await wait(async () => {
    const { runtime, state } = await bootstrap();
    return (
      runtime.model?.id === 'local-e2e-alternate' &&
      state.sessions.find((session) => session.id === state.selectedSessionId)?.model?.id ===
        'local-e2e-alternate'
    );
  }, 'The alternate model was not applied to the conversation');
  await picker.waitFor({ state: 'hidden' });
  const diagnostic = JSON.parse(await page.evaluate(() => window.desktop.invoke('diagnostics')));
  assert.equal(diagnostic.modelErrors.length, 5);
  assert.ok(diagnostic.modelErrors.every((entry) => Object.keys(entry).sort().join(',') === 'at,kind'));
  assertSafe(JSON.stringify(diagnostic), 'five-error diagnostic history');
  pass(
    'model recovery opens the picker and changes the real session model; diagnostics retain only five categories and times',
  );

  await closeApp();
  const socket = http.createServer();
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  models.providers['local-e2e'].baseUrl = `http://127.0.0.1:${port}/v1`;
  await fs.writeFile(modelsFile, JSON.stringify(models));
  await launch();
  await failWith('CONNECTION_REFUSED', 'network', '无法连接模型服务');
  await screenshot('network-error');
  await card().getByRole('button', { name: '检查 HTTP 代理', exact: true }).click();
  await page.locator('.feature-layout nav button.active').filter({ hasText: '常用设置' }).waitFor();
  await page.getByLabel('HTTP 代理', { exact: true }).waitFor();
  await screenshot('network-proxy-settings');
  await closeFeature();
  assert.deepEqual(rendererErrors, []);
  await closeApp();
  pass('an actual refused connection opens HTTP proxy settings without renderer errors');
  await fs.writeFile(
    path.join(output, 'result.json'),
    JSON.stringify(
      {
        platform: process.platform,
        packaged: Boolean(process.env.PI_DESKTOP_EXE),
        checks,
        screenshots,
        rendererErrors,
        providerRequests: provider.requests.length,
      },
      null,
      2,
    ),
  );
} catch (error) {
  if (page && !page.isClosed()) {
    await screenshot('failure').catch(() => {});
    await fs
      .writeFile(path.join(output, 'failure.txt'), await page.locator('body').innerText())
      .catch(() => {});
  }
  throw error;
} finally {
  await app?.close().catch(() => {});
  await provider.close();
}
