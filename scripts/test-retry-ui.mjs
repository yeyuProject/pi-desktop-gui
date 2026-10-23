import { _electron as electron } from 'playwright';
import { expect } from 'playwright/test';
import { emptyRuntime } from '../shared/types.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { prepareRealPiFixture } from '../tests/support/local-provider.ts';
import { createRetryProvider } from '../tests/support/retry-provider.ts';
import { installRetryDisplayFixture } from '../tests/support/retry-display-fixture.mjs';

process.env.PI_OFFLINE = '1';
const provider = await createRetryProvider();
const fixture = await prepareRealPiFixture(provider.baseUrl, 'retry-ui');
const settingsFile = path.join(fixture.agentDir, 'settings.json');
const settings = JSON.parse(await fs.readFile(settingsFile, 'utf8'));
await fs.writeFile(
  settingsFile,
  JSON.stringify({
    ...settings,
    retry: { enabled: true, maxRetries: 2, baseDelayMs: 40, provider: { maxRetries: 0, timeoutMs: 20000 } },
  }),
);
const output = path.resolve('output/playwright', `retry-ui-${process.platform}`);
await fs.mkdir(output, { recursive: true });
const errors = [];
let app, page;
const wait = async (check) => {
  const started = Date.now();
  while (!(await check())) {
    if (Date.now() - started > 25000) throw new Error('Retry UI condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
};
try {
  app = await electron.launch({
    executablePath: process.env.PI_DESKTOP_EXE,
    args: process.env.PI_DESKTOP_EXE ? [] : [path.resolve('.')],
    env: { ...process.env, PI_DESKTOP_DATA_DIR: fixture.dataDir, PI_OFFLINE: '1' },
    timeout: 30000,
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(25000);
  page.on('pageerror', (error) => errors.push(error.message));
  const input = page.getByRole('textbox', { name: '任务输入' });
  await input.waitFor();
  const send = async (text) => {
    await input.fill(text);
    await page.getByRole('button', { name: '发送任务', exact: true }).click();
  };
  const normalAfterRetry = async (outcome) => {
    provider.reset('success', true);
    await send(`NORMAL_AFTER_${outcome.toUpperCase()}`);
    await wait(() => provider.count === 1);
    await page.locator('.run-meta .running').waitFor();
    await page.locator('.runtime-notices').waitFor({ state: 'detached' });
    provider.release();
    await page.locator('.run-meta .completed').waitFor();
    assert.equal(await page.locator('.runtime-notices').count(), 0);
    console.log(`PASS a normal run after ${outcome} has no stale retry history`);
  };
  provider.reset('recover', true);
  await send('RETRY_RECOVER');
  await wait(() => provider.count === 2);
  await page
    .locator('.retry-banner')
    .getByText(/等待模型响应/)
    .waitFor();
  await page.locator('.retry-banner').getByRole('button', { name: '取消重试' }).waitFor();
  await page.screenshot({ path: path.join(output, 'requesting.png'), animations: 'disabled' });
  provider.release();
  await page.locator('.run-meta .completed').waitFor();
  await page.locator('.retry-banner').waitFor({ state: 'detached' });
  await page.locator('.message.assistant').getByText('RECOVERED', { exact: true }).waitFor();
  assert.equal(await page.locator('.runtime-notices').count(), 0);
  assert.equal(await page.locator('.message.assistant .inline-error').count(), 0);
  const recoveredToasts = page.getByRole('status').filter({ hasText: '连接已恢复' });
  await recoveredToasts.first().waitFor();
  assert.ok((await recoveredToasts.count()) > 0);
  for (const text of await recoveredToasts.allTextContents()) {
    assert.equal(text, '连接已恢复');
  }
  assert.equal(provider.count, 4);
  await page.screenshot({ path: path.join(output, 'recovered.png'), animations: 'disabled' });
  await recoveredToasts.last().waitFor({ state: 'detached', timeout: 6500 });
  assert.equal(await page.locator('.runtime-notices').count(), 0);
  await page.reload();
  await input.waitFor();
  await page.locator('.message.assistant').getByText('RECOVERED', { exact: true }).waitFor();
  assert.equal(await page.locator('.message.assistant .inline-error').count(), 0);
  assert.equal(await recoveredToasts.count(), 0);
  console.log('PASS recovered errors leave the conversation and recovery toasts automatically disappear');

  provider.reset('cancel-request');
  await send('RETRY_CANCEL_REQUEST');
  await wait(() => provider.count === 2);
  await page.locator('.retry-banner').getByRole('button', { name: '取消重试' }).click();
  await page.locator('.run-meta .stopped').waitFor();
  await page.locator('.retry-banner').waitFor({ state: 'detached' });
  await page.locator('.runtime-notices summary').click();
  await wait(() => provider.requests.at(-1).closed);
  assert.match(await page.locator('.runtime-notices p').last().innerText(), /^重试已取消/);
  assert.equal(provider.count, 2);
  await page.screenshot({ path: path.join(output, 'cancelled.png'), animations: 'disabled' });
  console.log('PASS cancel button stops an in-flight retry and closes the silent HTTP request');
  await normalAfterRetry('cancellation');

  provider.reset('exhaust');
  await send('RETRY_EXHAUST');
  await page.locator('.run-meta .error').waitFor();
  await page.locator('.retry-banner').waitFor({ state: 'detached' });
  assert.equal(await page.locator('.runtime-notices').evaluate((node) => node.open), false);
  await page.locator('.runtime-notices summary').click();
  assert.match(await page.locator('.runtime-notices p').last().innerText(), /^重试失败（2\/2）/);
  const failedAttempts = page.locator('.retry-error-group').last();
  await failedAttempts.waitFor();
  assert.equal(await failedAttempts.locator('.message.assistant').count(), 1);
  assert.equal(await failedAttempts.locator('.inline-error').count(), 1);
  assert.match(await failedAttempts.locator('summary').innerText(), /相同错误 ×3/);
  await failedAttempts.locator('summary').click();
  await failedAttempts.locator('.retry-error-history-content').waitFor();
  assert.equal(await failedAttempts.locator('.message.assistant .inline-error').count(), 3);
  await failedAttempts.locator('summary').click();
  await failedAttempts.locator('.retry-error-history-content').waitFor({ state: 'detached' });
  assert.equal(await failedAttempts.locator('.message.assistant .inline-error').count(), 1);
  assert.equal(provider.count, 3);
  assert.equal(await page.locator('.runtime-notices p').count(), 1);
  await normalAfterRetry('failure');
  // Deterministic renderer fixtures exercise mixed errors and search; provider scenarios above use real Pi.
  await app.evaluate(installRetryDisplayFixture, fixture.sessionId);
  const show = (messages, extra = {}) =>
    app.evaluate((_electron, runtime) => globalThis.retryDisplayFixture.publish(runtime), {
      ...emptyRuntime(),
      sessionId: fixture.sessionId,
      connected: true,
      status: 'error',
      messages,
      ...extra,
    });
  const user = (content) => ({ role: 'user', content });
  const failure = (errorMessage, timestamp) => ({
    role: 'assistant',
    content: [],
    stopReason: 'error',
    errorMessage,
    timestamp,
  });
  const repeated = [
    user('Repeated failures'),
    failure('Connection error.', 1),
    failure('Connection error.', 2),
    failure('Connection error.', 3),
  ];
  const history = page.locator('.retry-error-history');
  const assistant = page.locator('.message.assistant');
  const inlineErrors = page.locator('.message.assistant .inline-error');
  await show(repeated, {
    status: 'retrying',
    retry: { attempt: 2, maxAttempts: 3, delayMs: 2000, startedAt: Date.now(), phase: 'requesting' },
  });
  await expect(assistant).toHaveCount(1);
  await expect(history.locator('summary')).toHaveText('相同错误 ×3 · 前 2 条');
  await expect(page.locator('.retry-banner')).toContainText('等待模型响应');
  await expect(page.getByRole('button', { name: '取消重试' })).toBeEnabled();
  await history.locator('summary').click();
  await expect(assistant).toHaveCount(3);
  await history.locator('summary').click();
  await expect(assistant).toHaveCount(1);

  await show(repeated);
  await expect(page.locator('.retry-banner')).toHaveCount(0);
  await expect(inlineErrors).toHaveCount(1);
  await page.getByTitle('重新生成这条回复').click();
  await wait(async () => (await app.evaluate(() => globalThis.retryDisplayFixture.actions.length)) === 1);
  assert.deepEqual(await app.evaluate(() => globalThis.retryDisplayFixture.actions[0]), [
    fixture.sessionId,
    'regenerate',
    'assistant',
    3,
  ]);

  const mixed = [
    user('Mixed failures'),
    failure('Request timed out.', 10),
    failure('Connection error.', 11),
    failure('Latest failure.', 12),
  ];
  await show(mixed);
  await expect(history.locator('summary')).toHaveText('请求失败记录 · 3 次 · 前 2 条');
  await expect(inlineErrors).toHaveText(['Latest failure.']);
  await page.evaluate(() => window.dispatchEvent(new Event('pi:find')));
  await page.getByRole('textbox', { name: '查找当前会话' }).fill('Request timed out.');
  await expect(page.locator('.search-active .inline-error')).toHaveText('Request timed out.');
  await expect(history).toHaveAttribute('open', '');
  await page.getByRole('textbox', { name: '查找当前会话' }).fill('.');
  await expect(page.locator('.search-active .inline-error')).toHaveText('Request timed out.');
  await history.locator('summary').click();
  await expect(page.locator('.search-active .inline-error')).toBeVisible();
  await page.getByTitle('下一个匹配').click();
  await expect(page.locator('.search-active .inline-error')).toHaveText('Connection error.');
  await expect(page.locator('.search-active .inline-error')).toBeVisible();
  await history.locator('summary').press('Enter');
  await expect(history).toHaveAttribute('open', '');
  await expect(page.locator('.search-active .inline-error')).toBeVisible();
  await page.getByTitle('关闭会话查找').click();
  await expect(assistant).toHaveCount(1);
  for (let i = 0; i < 2; i++) {
    await history.locator('summary').click();
    await expect(assistant).toHaveCount(3);
    await history.locator('summary').click();
    await expect(assistant).toHaveCount(1);
  }
  const appended = [...mixed, failure('Newest failure.', 13)];
  await show(appended);
  await expect(inlineErrors).toHaveText(['Newest failure.']);
  await expect(history.locator('summary')).toContainText('4 次');

  await show([...appended, user('New turn'), failure('New turn failure.', 14)]);
  await expect(inlineErrors).toHaveText(['Newest failure.', 'New turn failure.']);
  await show([...appended, { role: 'assistant', content: [], stopReason: 'aborted' }], { status: 'stopped' });
  await expect(inlineErrors).toHaveText(['Newest failure.']);
  await show([...appended, { role: 'assistant', content: 'Recovered reply', stopReason: 'stop' }], {
    status: 'completed',
  });
  await expect(history).toHaveCount(0);
  await expect(inlineErrors).toHaveCount(0);
  await expect(assistant).toHaveText([/Recovered reply/]);

  // Search and paging retain original message indices even when a group straddles the page boundary.
  const many = [
    user('Long failure sequence'),
    ...Array.from({ length: 90 }, (_, index) => failure(`Failure ${index}`, 100 + index)),
  ];
  await show(many);
  await expect(assistant).toHaveCount(1);
  await expect(history.locator('summary')).toContainText('90 次');
  await page.evaluate(() => window.dispatchEvent(new Event('pi:find')));
  await page.getByRole('textbox', { name: '查找当前会话' }).fill('Failure 0');
  await expect(page.locator('.search-active')).toHaveAttribute('data-message-index', '1');
  await expect(page.locator('.search-active .inline-error')).toHaveText('Failure 0');
  await page.getByTitle('关闭会话查找').click();
  await history.locator('summary').click();
  await expect(history.locator('summary')).toContainText('90 次');
  await expect(history.locator('summary')).toContainText('本页 79 条');
  await expect(assistant).toHaveCount(79);
  await page.getByRole('button', { name: '加载更新的 11 条消息', exact: true }).click();
  await expect(page.locator('[data-message-index="90"]')).toBeVisible();
  await expect(history.locator('summary')).toContainText('90 次');
  await expect(assistant).toHaveCount(80);
  await show(repeated);
  await expect(history.locator('summary')).toContainText('相同错误 ×3');
  await page.reload();
  await input.waitFor();
  await expect(assistant).toHaveCount(1);
  await expect(history).not.toHaveAttribute('open', '');

  await page.screenshot({ path: path.join(output, 'collapsed-failures.png'), animations: 'disabled' });
  console.log(
    'PASS grouped errors preserve terminal actions, repeated expansion, search indices, paging, turn boundaries, cancellation and recovery',
  );
  assert.deepEqual(errors, []);
  await fs.writeFile(
    path.join(output, 'result.json'),
    JSON.stringify(
      {
        passed: true,
        packaged: Boolean(process.env.PI_DESKTOP_EXE),
        checks: [
          'requesting banner',
          'recovery toast auto-dismiss',
          'cancel active request',
          'exhaustion with one visible final failure and expandable attempts',
          'new run after cancellation and failure',
          'grouped errors: mixed errors, search, paging, expansion, terminal actions and reload',
        ],
        rendererErrors: errors,
      },
      null,
      2,
    ),
  );
  console.log('PASS retry exhaustion displays its final outcome with no busy retry banner');
} catch (error) {
  await page?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  // Only local fixture state and bounded display diagnostics; never dump settings or credentials.
  const fixtureState = await app
    ?.evaluate(() => {
      const fixture = globalThis.retryDisplayFixture;
      const runtime = fixture?.runtime;
      return {
        active: Boolean(runtime),
        ignoredEvents: fixture?.ignoredEvents ?? 0,
        actionCount: fixture?.actions.length ?? 0,
        status: runtime?.status,
        connected: runtime?.connected,
        retry: runtime?.retry && {
          attempt: runtime.retry.attempt,
          maxAttempts: runtime.retry.maxAttempts,
          phase: runtime.retry.phase,
        },
        messages: runtime?.messages.map((message) => ({
          role: message.role,
          stopReason: message.stopReason,
          timestamp: message.timestamp,
          hasError: Boolean(message.errorMessage),
        })),
      };
    })
    .catch(() => ({ unavailable: true }));
  const displayState = await page
    ?.evaluate(() => ({
      runStatus: document.querySelector('.run-meta')?.textContent?.slice(0, 300),
      retryBanner: document.querySelector('.retry-banner')?.textContent?.slice(0, 300),
      findQuery: document.querySelector('[aria-label="查找当前会话"]')?.value,
      groups: [...document.querySelectorAll('.retry-error-history')].map((details) => ({
        open: details.open,
        summary: details.querySelector('summary')?.textContent,
        messages: details.querySelectorAll('.message.assistant').length,
      })),
      messages: [...document.querySelectorAll('[data-message-index]')].map((element) => ({
        index: element.getAttribute('data-message-index'),
        active: element.classList.contains('search-active'),
        visible: element.getClientRects().length > 0,
        hasError: Boolean(element.querySelector('.inline-error')),
      })),
    }))
    .catch(() => ({ unavailable: true }));
  await fs
    .writeFile(
      path.join(output, 'failure-state.json'),
      JSON.stringify({ failed: true, fixture: fixtureState, display: displayState }, null, 2),
    )
    .catch(() => {});
  throw error;
} finally {
  await app?.close();
  await provider.close();
}
