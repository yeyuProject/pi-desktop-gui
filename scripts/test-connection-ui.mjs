import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import { once } from 'node:events';
import { expect } from 'playwright/test';
import { launchApp, closeApp } from '../tests/support/desktop-app.mjs';
import { prepareRealPiFixture } from '../tests/support/local-provider.ts';

// Exercise the production IPC handler and an unmodified Pi against localhost only.
const secret = 'sk-connection-fixture-12345678901234567890';
let response = { status: 200, message: '' };
let requests = 0;
const server = http.createServer(async (req, res) => {
  for await (const _chunk of req) {
    /* Consume the real SDK request. */
  }
  requests++;
  if (response.status !== 200) {
    res.writeHead(response.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: response.message } }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const [delta, finish_reason] of [
    [{ role: 'assistant', content: 'OK' }, null],
    [{}, 'stop'],
  ])
    res.write(
      `data: ${JSON.stringify({ id: 'connection-test', object: 'chat.completion.chunk', created: 1, model: 'local-e2e', choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
    );
  res.end('data: [DONE]\n\n');
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
let app, page;
const errors = [];
const checks = [];
try {
  const fixture = await prepareRealPiFixture(`http://127.0.0.1:${server.address().port}/v1`, 'connection-ui');
  ({ app, page } = await launchApp({ dataDir: fixture.dataDir, errors }));
  await page.getByRole('textbox', { name: '任务输入' }).waitFor();
  await page.evaluate((id) => window.desktop.invoke('connect', id), fixture.sessionId);
  await app.evaluate(({ ipcMain }) => {
    const original = ipcMain._invokeHandlers.get('desktop:invoke');
    globalThis.connectionResults = [];
    ipcMain.removeHandler('desktop:invoke');
    ipcMain.handle('desktop:invoke', async (event, method, args) => {
      const result = await original(event, method, args);
      if (method === 'testConnection') globalThis.connectionResults.push(result);
      return result;
    });
  });
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '模型连接', exact: true }).click();
  const button = page.getByRole('button', { name: '测试模型连接', exact: true });
  for (const sample of [
    {
      status: 401,
      message: `401 invalid x-api-key ${secret}`,
      kind: 'auth',
      title: '供应商拒绝了凭据',
      detail: '请检查 API Key',
      copy: 'invalid x-api-key',
    },
    {
      status: 408,
      message: 'Request timed out',
      kind: 'network',
      title: '无法连接模型服务',
      detail: '请检查网络',
      copy: 'Request timed out',
    },
    {
      status: 429,
      message: '429 rate limit',
      kind: 'busy',
      title: '请求过多或服务繁忙',
      detail: '请稍等片刻',
      copy: 'rate limit',
    },
    {
      status: 400,
      message: 'unexpected fixture response',
      kind: 'unknown',
      title: '模型请求失败',
      detail: '请查看或复制',
      copy: 'unexpected fixture response',
    },
  ]) {
    response = sample;
    await button.click();
    await expect(page.locator('.test-result')).toContainText(sample.title, { timeout: 60000 });
    await expect(page.locator('.test-result')).toContainText(sample.detail);
    const result = await app.evaluate(() => globalThis.connectionResults.at(-1));
    assert.equal(result.ok, false);
    assert.equal(result.error.kind, sample.kind);
    assert.equal(result.error.title, sample.title);
    assert.ok(result.details.includes(sample.copy));
    assert.ok(!JSON.stringify(result).includes(secret));
    await page.getByRole('button', { name: '复制详情', exact: true }).click();
    await expect
      .poll(() => app.evaluate(async ({ clipboard }) => clipboard.readText()))
      .toContain(sample.copy);
    const copied = await app.evaluate(async ({ clipboard }) => clipboard.readText());
    assert.ok(copied.includes(sample.copy));
    assert.ok(!copied.includes(secret));
    const diagnostic = (
      await page.evaluate(() => window.desktop.invoke('bootstrap'))
    ).runtime.diagnostic.join('\n');
    assert.ok(diagnostic.includes('testConnection sessionId='));
    assert.ok(diagnostic.includes(sample.copy));
    assert.ok(!diagnostic.includes(secret));
    checks.push(sample.kind);
  }
  response = { status: 200, message: '' };
  await button.click();
  await expect(page.locator('.test-result')).toContainText('连接成功', { timeout: 60000 });
  await expect(page.locator('.test-result')).toContainText('OK');
  await expect(page.getByRole('button', { name: '复制详情', exact: true })).toHaveCount(0);
  const success = await app.evaluate(() => globalThis.connectionResults.at(-1));
  assert.equal(success.ok, true);
  assert.equal(success.text, 'OK');
  assert.ok(success.elapsed >= 0);
  await assert.rejects(
    page.evaluate(() => window.desktop.invoke('testConnection', { invalid: true })),
    /内部错误/,
  );
  assert.deepEqual(errors, []);
  await fs.mkdir('test-results', { recursive: true });
  await fs.writeFile(
    'test-results/connection-ui.json',
    JSON.stringify({ checks, success, requests, errors }, null, 2),
  );
  console.log(JSON.stringify({ checks, success: true, requests, errors }));
} catch (error) {
  if (page && !page.isClosed()) {
    await fs.mkdir('test-results', { recursive: true });
    await page.screenshot({ path: 'test-results/connection-ui-failure.png' }).catch(() => {});
  }
  throw error;
} finally {
  if (app) await closeApp(app);
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
