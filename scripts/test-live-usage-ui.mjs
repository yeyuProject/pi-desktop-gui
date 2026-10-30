import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { launchApp, closeApp } from '../tests/support/desktop-app.mjs';
import { createLocalProvider, prepareRealPiFixture } from '../tests/support/local-provider.ts';

const provider = await createLocalProvider({ holdSlowResponses: true });
const fixture = await prepareRealPiFixture(provider.baseUrl, 'live-usage-ui');
const output = path.resolve('test-results', 'live-usage');
await fs.mkdir(output, { recursive: true });
let app;
async function waitFor(condition, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for live usage UI');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
try {
  const errors = [];
  const launched = await launchApp({ dataDir: fixture.dataDir, errors });
  app = launched.app;
  const page = launched.page;
  await page.getByRole('textbox', { name: '任务输入' }).waitFor();
  const invoke = (method, ...args) =>
    page.evaluate(([name, values]) => window.desktop.invoke(name, ...values), [method, args]);
  await invoke('connect', fixture.sessionId);
  await invoke('send', fixture.sessionId, 'E2E_USAGE_LIVE', [], 'steer');
  await waitFor(async () => {
    const value = await invoke('bootstrap');
    return provider.heldInitialUsageResponseCount === 1 && value.runtime.liveUsage?.outputTokens > 0;
  });
  const meter = page.locator('.context-meter');
  await waitFor(async () => (await meter.innerText()).includes('累计约'));
  const firstEstimate = (await invoke('bootstrap')).runtime.liveUsage.outputTokens;
  const firstText = await meter.innerText();
  provider.advanceInitialUsageResponses();
  await waitFor(async () => (await invoke('bootstrap')).runtime.liveUsage?.outputTokens > firstEstimate);
  await waitFor(async () => (await meter.innerText()) !== firstText);
  provider.finishInitialUsageResponses();
  await waitFor(async () => {
    const value = await invoke('bootstrap');
    return (
      provider.heldUsageResponseCount === 1 &&
      value.runtime.stats?.tokens === 120 &&
      value.runtime.liveUsage?.outputTokens > 0
    );
  });
  await waitFor(async () => (await meter.innerText()).includes('累计约'));
  assert.match(await meter.innerText(), /上下文约[\s\S]*累计约/);
  assert.match(await meter.getAttribute('title'), /回复结束后以 Pi 上报为准/);
  for (const uiStyle of ['classic', 'codex', 'claude']) {
    await invoke('saveSettings', { uiStyle });
    await page.waitForFunction((style) => document.documentElement.dataset.style === style, uiStyle);
    assert.match(await meter.innerText(), /累计约/);
    const bounds = await meter.evaluate((element) => ({
      right: element.getBoundingClientRect().right,
      viewport: window.innerWidth,
    }));
    assert.ok(bounds.right <= bounds.viewport, `${uiStyle} live meter remains visible`);
    await page.screenshot({ path: path.join(output, `${uiStyle}-streaming.png`) });
  }
  await meter.click();
  const popover = page.locator('.context-popover');
  assert.match(await popover.innerText(), /以下为 Pi 最近返回的会话统计/);
  assert.match(await popover.innerText(), /会话累计\s+120 tokens/);
  await page.screenshot({ path: path.join(output, 'streaming.png') });
  await meter.click();
  provider.releaseUsageResponses();
  await waitFor(async () => /累计 240 tokens/.test(await meter.innerText()));
  assert.doesNotMatch(await meter.innerText(), /累计约/);

  await invoke('send', fixture.sessionId, 'E2E_SLOW', [], 'steer');
  await waitFor(
    async () => provider.heldSlowResponseCount === 1 && (await meter.innerText()).includes('累计约'),
  );
  await invoke('stop', fixture.sessionId);
  const stopped = await invoke('bootstrap');
  assert.equal(stopped.runtime.status, 'stopped');
  assert.equal(stopped.runtime.liveUsage, undefined);
  await waitFor(async () => !(await meter.innerText()).includes('累计约'));
  assert.deepEqual(errors, []);
  console.log('PASS desktop live usage, confirmed details, final reconciliation and stop');
} finally {
  await closeApp(app);
  await provider.close();
}
