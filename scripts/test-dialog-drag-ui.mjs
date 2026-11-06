import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { launchApp, closeApp } from '../tests/support/desktop-app.mjs';
import { createLocalProvider, prepareRealPiFixture } from '../tests/support/local-provider.ts';
const provider = await createLocalProvider();
const f = await prepareRealPiFixture(provider.baseUrl, 'dialog-drag-ui');
let app;
try {
  const launched = await launchApp({ dataDir: f.dataDir });
  app = launched.app;
  const page = launched.page;
  await page.getByRole('textbox', { name: '任务输入' }).waitFor();
  await page.locator('.sidebar-footer').getByRole('button', { name: '设置', exact: true }).click();
  const modal = page.locator('.modal').last();
  await modal.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
  await page.waitForTimeout(300);
  const before = await modal.boundingBox();
  const header = await modal.locator(':scope > header').boundingBox();
  await page.mouse.move(header.x + 60, header.y + 25);
  await page.mouse.down();
  await page.mouse.move(header.x + 210, header.y + 65, { steps: 12 });
  await page.mouse.up();
  await page.evaluate(() => new Promise(requestAnimationFrame));
  const after = await modal.boundingBox();
  assert.ok(after.x > before.x + 100, `dialog follows pointer: ${JSON.stringify({ before, after })}`);
  assert.equal(await modal.count(), 1, 'release does not dismiss modal');
  const movedHeader = await modal.locator(':scope > header').boundingBox();
  await page.mouse.dblclick(movedHeader.x + 60, movedHeader.y + 25);
  await page.waitForTimeout(400);
  const reset = await modal.boundingBox();
  assert.ok(Math.abs(reset.x - before.x) < 2, 'double click centers dialog');
  await fs.mkdir('test-results/dialog-drag', { recursive: true });
  await page.screenshot({ path: 'test-results/dialog-drag/reset.png' });
  await modal.locator(':scope > header').getByRole('button', { name: '关闭', exact: true }).click();
  // Exercise all seven dynamically supplied levels with the production stylesheet.
  await page.evaluate(() => {
    const panel = document.createElement('div');
    panel.id = 'thinking-layout-fixture';
    panel.style.cssText =
      'position:fixed;left:40px;top:100px;width:360px;background:var(--surface);z-index:2000';
    panel.innerHTML =
      '<div class="thinking-row"><span>推理级别</span><div role="radiogroup">' +
      ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
        .map((level) => `<button role="radio" aria-checked="${level === 'xhigh'}">${level}</button>`)
        .join('') +
      '</div></div>';
    document.body.append(panel);
  });
  for (const style of ['default', 'codex', 'claude']) {
    for (const theme of ['light', 'dark']) {
      await page.evaluate(
        ({ style, theme }) => {
          document.documentElement.dataset.style = style;
          document.documentElement.dataset.theme = theme;
        },
        { style, theme },
      );
      const fixture = page.locator('#thinking-layout-fixture');
      assert.equal(await fixture.evaluate((el) => el.scrollWidth <= el.clientWidth), true);
      await fixture.screenshot({ path: `test-results/dialog-drag/thinking-${style}-${theme}.png` });
    }
  }
  assert.deepEqual(launched.errors, []);
  console.log('Dialog drag UI passed');
} finally {
  await closeApp(app);
  await provider.close();
}
