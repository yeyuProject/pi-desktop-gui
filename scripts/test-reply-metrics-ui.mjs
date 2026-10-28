import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createLocalProvider, prepareRealPiFixture } from '../tests/support/local-provider.ts';

const provider = await createLocalProvider();
const fixture = await prepareRealPiFixture(provider.baseUrl, 'reply-metrics-ui');
const output = path.resolve('test-results', 'reply-metrics');
await fs.mkdir(output, { recursive: true });
let app;
try {
  app = await electron.launch({
    args: [path.resolve('.')],
    env: { ...process.env, PI_DESKTOP_DATA_DIR: fixture.dataDir, PI_OFFLINE: '1' },
    timeout: 60000,
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(30000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.getByRole('textbox', { name: '任务输入' }).waitFor();
  await page.evaluate(async (id) => {
    await window.desktop.invoke('connect', id);
    await window.desktop.invoke('send', id, 'E2E_USAGE', [], 'steer');
  }, fixture.sessionId);
  const speed = page.locator('.message.assistant .reply-speed').last();
  await speed.waitFor();
  const before = await page.evaluate(() => window.desktop.invoke('bootstrap'));
  const reply = before.runtime.messages.findLast((message) => message.role === 'assistant');
  assert.equal(reply.usage.output, 20);
  assert.ok(reply.durationMs > 0, 'Pi provides the native response duration');
  const expectedSpeed = `${(20 / (reply.durationMs / 1000)).toFixed(1)} TPS`;
  assert.equal((await speed.textContent()).trim(), `平均输出速度 ${expectedSpeed}`);
  assert.equal(await page.locator('.message.user .reply-speed').count(), 0);
  const placement = await speed.evaluate((element) => ({
    speedTop: element.getBoundingClientRect().top,
    contentBottom: element.closest('.message').querySelector('.message-content').getBoundingClientRect()
      .bottom,
  }));
  assert.ok(placement.speedTop >= placement.contentBottom, 'TPS is displayed below the reply content');
  await page
    .locator('.message.assistant')
    .last()
    .getByRole('button', { name: '复制回复', exact: true })
    .waitFor();
  await page.screenshot({ path: path.join(output, 'reply-tps.png') });

  await page.getByRole('button', { name: '选择模型', exact: true }).click();
  const refresh = page.getByRole('button', { name: '刷新模型列表', exact: true });
  await refresh.waitFor();
  assert.equal(await refresh.isEnabled(), true, 'connected conversations can refresh models');
  const modelsPath = path.join(fixture.agentDir, 'models.json');
  const config = JSON.parse(await fs.readFile(modelsPath, 'utf8'));
  config.providers['local-e2e'].models.push({
    ...config.providers['local-e2e'].models[0],
    id: 'refreshed-model',
    name: '刷新后新增模型',
  });
  await fs.writeFile(modelsPath, JSON.stringify(config));
  const requestCount = provider.requests.length;
  await refresh.click();
  await page.getByRole('option', { name: /刷新后新增模型/ }).waitFor();
  await page.waitForFunction(() => !document.querySelector('.model-refresh')?.disabled);
  const after = await page.evaluate(() => window.desktop.invoke('bootstrap'));
  assert.equal(after.runtime.connected, true);
  assert.deepEqual(after.runtime.model, before.runtime.model);
  assert.deepEqual(after.runtime.messages, before.runtime.messages);
  assert.equal(provider.requests.length, requestCount, 'refresh does not send a model prompt');
  await page.screenshot({ path: path.join(output, 'model-refresh.png') });
  await page.getByRole('option', { name: /刷新后新增模型/ }).click();
  await page.waitForFunction(() =>
    document.querySelector('.model-pill')?.textContent.includes('刷新后新增模型'),
  );
  await page.reload();
  await page.locator('.message.assistant .reply-speed').waitFor();
  assert.equal(
    (await page.locator('.reply-speed').last().textContent()).trim(),
    `平均输出速度 ${expectedSpeed}`,
  );
  assert.deepEqual(errors, []);
  console.log(
    'PASS reply TPS from native usage/duration, history reload, and connected model refresh/selection',
  );
} finally {
  await app?.close();
  await provider.close();
}
