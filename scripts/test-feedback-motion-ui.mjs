// UI13: real Electron renderer with isolated IPC fixtures. No model or user data access.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect } from 'playwright/test';
import { launchApp, closeApp } from '../tests/support/desktop-app.mjs';
import { workbenchFixture } from '../tests/support/workbench-fixture.mjs';
import { startReadmeServer } from './readme-server.mjs';

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-feedback-ui-'));
const entry = path.join(temp, 'main.cjs');
await fs.writeFile(
  entry,
  `const {app,BrowserWindow}=require('electron');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.whenReady().then(()=>{const win=new BrowserWindow({width:1600,height:1000,frame:false,show:false,x:-3000,y:-2000,webPreferences:{contextIsolation:true}});win.loadURL('about:blank');win.showInactive();});`,
);
const output = path.resolve('test-results');
await fs.mkdir(output, { recursive: true });
const server = await startReadmeServer();
let app, page;
const errors = [],
  report = [];
function installFixture() {
  const invoke = window.desktop.invoke;
  const listeners = new Set();
  let revision = 100,
    notification = 0;
  window.feedbackCopies = [];
  window.feedbackFailSave = false;
  window.feedbackHoldSave = false;
  window.desktop.onEvent = (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const emit = (event) => {
    for (const listener of listeners) listener(structuredClone(event));
  };
  window.desktop.invoke = async (method, ...args) => {
    if (method === 'bootstrap') {
      const value = await invoke(method, ...args);
      value.revision = ++revision;
      value.runtime.messages = [1, 2, 3].map((turn) => ({
        role: 'user',
        content: `反馈检查 ${turn}`,
        timestamp: 1800000000000 + turn,
      }));
      value.runtime.tools = [];
      value.runtime.notifications = [];
      value.runtime.dialogs = [];
      window.feedbackSnapshot = value;
      return structuredClone(value);
    }
    if (method === 'readHistory' || method === 'selectSession')
      return window.feedbackSnapshot.runtime.messages;
    if (method === 'copy') {
      window.feedbackCopies.push(args[0]);
      return;
    }
    if (method === 'saveSettings') {
      if (window.feedbackHoldSave)
        await new Promise((resolve) => {
          window.feedbackReleaseSave = resolve;
        });
      if (window.feedbackFailSave) throw new Error('EACCES: settings write denied');
      Object.assign(window.feedbackSnapshot.state.settings, args[0]);
      emit({ type: 'state', state: window.feedbackSnapshot.state, revision: ++revision });
      return;
    }
    if (method === 'respond') {
      window.feedbackSnapshot.runtime.dialogs = [];
      emit({ type: 'runtime', runtime: window.feedbackSnapshot.runtime });
      return;
    }
    if (method === 'revokeApproval') {
      window.feedbackRevoked = args;
      return;
    }
    return invoke(method, ...args);
  };
  window.feedbackNotify = (text, level = 'info') => {
    const runtime = window.feedbackSnapshot.runtime;
    runtime.notifications = [...runtime.notifications, { id: ++notification, text, level }];
    emit({ type: 'runtime', runtime });
  };
  window.feedbackApproval = () => {
    const runtime = window.feedbackSnapshot.runtime;
    runtime.status = 'waiting';
    runtime.dialogs = [
      {
        id: 'feedback-approval',
        method: 'select',
        title: '__PI_DESKTOP_APPROVAL__',
        options: ['允许一次', '本会话总是允许', '拒绝'],
        approval: {
          toolName: 'bash',
          kind: 'shell',
          summary: 'npm test',
          grant: {
            id: 'shell-exact:bash:npm test',
            kind: 'shell-exact',
            toolName: 'bash',
            command: 'npm test',
          },
        },
      },
    ];
    emit({ type: 'runtime', runtime });
  };
}
async function dismissAll() {
  for (let count = 0; count < 12 && (await page.locator('.toast').count()); count++) {
    const button = page.locator('.toast:not([data-leaving]) button[title="关闭通知"]').first();
    if (await button.count()) await button.click();
    await page.clock.fastForward(160);
  }
  await expect(page.locator('.toast-stack')).toHaveCount(0);
}
async function notify(text, level) {
  await page.evaluate(({ text, level }) => window.feedbackNotify(text, level), { text, level });
  await expect(page.locator('.toast').filter({ hasText: text })).toBeVisible();
}
async function animatedProperties(selector) {
  return page
    .locator(selector)
    .first()
    .evaluate((node) => ({
      transition: getComputedStyle(node).transitionProperty,
      keys: node
        .getAnimations()
        .flatMap((animation) =>
          animation.effect
            .getKeyframes()
            .flatMap((frame) =>
              Object.keys(frame).filter(
                (key) => !['offset', 'computedOffset', 'easing', 'composite'].includes(key),
              ),
            ),
        ),
    }));
}
// Replay the production CSS animation after flushing its initial DOM layout. The store's
// clock is paused by the caller so the exit timer cannot remove the node during capture.
async function traceMotion(selector, label) {
  const node = page.locator(selector).first();
  await node.evaluate((element) => {
    const animation = element.getAnimations()[0];
    if (!animation) throw new Error('Expected a running feedback animation');
    animation.pause();
    animation.currentTime = 0;
    element.getBoundingClientRect();
  });
  const session = await page.context().newCDPSession(page);
  const events = [];
  session.on('Tracing.dataCollected', ({ value }) => events.push(...value));
  await session.send('Tracing.start', {
    categories: 'devtools.timeline,blink.user_timing',
    transferMode: 'ReportEvents',
  });
  await node.evaluate((element) => {
    console.timeStamp('UI13-motion-start');
    element.getAnimations()[0].play();
  });
  await delay(80);
  await page.evaluate(() => console.timeStamp('UI13-motion-end'));
  const complete = new Promise((resolve) => session.once('Tracing.tracingComplete', resolve));
  await session.send('Tracing.end');
  await complete;
  await session.detach();
  const start = events.find(
    (event) => event.name === 'TimeStamp' && event.args?.data?.message === 'UI13-motion-start',
  );
  const end = events.find(
    (event) => event.name === 'TimeStamp' && event.args?.data?.message === 'UI13-motion-end',
  );
  assert.ok(start && end, 'Trace must contain the animation interval');
  const layouts = events.filter(
    (event) => event.name === 'Layout' && event.ts > start.ts && event.ts < end.ts,
  );
  await fs.writeFile(
    path.join(output, `feedback-${label}-trace.json`),
    JSON.stringify({ traceEvents: events }),
  );
  assert.equal(layouts.length, 0, `${label}: animation must not cause Layout after DOM insertion`);
}
try {
  ({ app, page } = await launchApp({ args: [entry], errors }));
  await page.clock.install();
  await page.addInitScript({
    content: `const options=JSON.parse(new URLSearchParams(location.search).get('fixture')||'{}');(${workbenchFixture.toString()})(options);(${installFixture.toString()})();`,
  });
  for (const uiStyle of ['classic', 'codex', 'claude']) {
    for (const theme of ['light', 'dark']) {
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await page.setViewportSize({ width: 1600, height: 1000 });
      await page.goto(server.url + '?fixture=' + encodeURIComponent(JSON.stringify({ uiStyle, theme })));
      await expect(page.locator('.message.user')).toHaveCount(3);
      await page.getByRole('button', { name: '设置', exact: true }).click();
      const save = page.locator('.settings-save');
      const idleWidth = (await save.boundingBox()).width;
      await page.evaluate(() => {
        window.feedbackHoldSave = true;
      });
      await save.click();
      await expect(save).toBeDisabled();
      await expect(save.locator('.spin')).toHaveCount(1);
      await expect(save).toHaveText('保存设置');
      assert.equal((await save.boundingBox()).width, idleWidth);
      await page.evaluate(() => {
        window.feedbackHoldSave = false;
        window.feedbackReleaseSave();
      });
      await expect(save).toHaveText('已保存');
      assert.equal((await save.boundingBox()).width, idleWidth);
      await expect(page.locator('.toast')).toHaveCount(0);
      await page.clock.fastForward(1600);
      await expect(save).toHaveText('保存设置');
      await page.evaluate(() => {
        window.feedbackFailSave = true;
      });
      await save.click();
      await expect(page.locator('.modal .error-banner')).toBeVisible();
      await expect(save).toHaveText('保存设置');
      const errorProperties = await animatedProperties('.modal .error-banner');
      assert.ok(errorProperties.keys.every((key) => ['opacity', 'transform'].includes(key)));
      await page.screenshot({ path: path.join(output, `feedback-${uiStyle}-${theme}-save-error.png`) });
      await page.getByRole('button', { name: '关闭设置错误', exact: true }).click();
      await expect(page.locator('.modal .error-banner')).toHaveAttribute('data-leaving', 'true');
      await page.clock.fastForward(160);
      await expect(page.locator('.modal .error-banner')).toHaveCount(0);
      await page.locator('.modal footer').getByRole('button', { name: '关闭', exact: true }).click();
      await page.clock.pauseAt(await page.evaluate(() => Date.now() + 100));
      await notify('动效录制', 'info');
      const entering = await animatedProperties('.toast');
      assert.ok(entering.keys.includes('opacity') && entering.keys.includes('transform'));
      assert.ok(entering.transition.split(',').every((key) => ['opacity', 'transform'].includes(key.trim())));
      await traceMotion('.toast', `${uiStyle}-${theme}-enter`);
      await page.locator('.toast button[title="关闭通知"]').click();
      await expect(page.locator('.toast')).toHaveAttribute('data-leaving', 'true');
      await traceMotion('.toast', `${uiStyle}-${theme}-exit`);
      await page.clock.fastForward(160);
      await expect(page.locator('.toast-stack')).toHaveCount(0);
      await page.clock.resume();
      const message = page.locator('.message.user').first();
      await message.hover();
      const copy = message.locator('button[title="复制消息"]');
      await copy.click();
      await expect(copy).toHaveAttribute('data-copied', '1');
      await expect(copy).toHaveAttribute('aria-label', /已复制/);
      await copy.click();
      await expect(copy).toHaveAttribute('data-copied', '2');
      await expect(page.locator('.toast')).toHaveCount(0);
      await notify('相同提示', 'info');
      const firstId = Number(await page.locator('.toast').getAttribute('data-notice-id'));
      await page.evaluate(() => window.feedbackNotify('相同提示'));
      await expect(page.locator('.toast')).toHaveCount(2);
      assert.ok(Number(await page.locator('.toast').last().getAttribute('data-notice-id')) > firstId);
      await dismissAll();
      for (const width of [900, 1600]) {
        await page.setViewportSize({ width, height: 1000 });
        for (const sidebar of [true, false]) {
          const toggle = page.locator('button[aria-controls="project-sidebar"]').first();
          if ((await toggle.getAttribute('aria-expanded')) !== String(sidebar)) await toggle.click();
          await page.evaluate(() => window.feedbackApproval());
          await page.locator('.thread').evaluate((node) => {
            node.scrollTop = 0;
          });
          await notify('位置检查', 'info');
          const overlap = await page.locator('.toast-stack').evaluate((node) => {
            const a = node.getBoundingClientRect();
            return [...document.querySelectorAll('.composer, .send-button, .approval-card')].some((other) => {
              const b = other.getBoundingClientRect();
              return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
            });
          });
          assert.equal(overlap, false, `${uiStyle}/${theme}/${width}/sidebar=${sidebar}`);
          await dismissAll();
        }
      }
      await page.setViewportSize({ width: 1600, height: 1000 });
      // The sidebar state persists across reloads; the next appearance opens settings from it.
      const sidebarToggle = page.locator('button[aria-controls="project-sidebar"]').first();
      if ((await sidebarToggle.getAttribute('aria-expanded')) !== 'true') await sidebarToggle.click();
      await notify('暂停检查', 'info');
      const toast = page.locator('.toast').filter({ hasText: '暂停检查' });
      const properties = await animatedProperties('.toast');
      assert.ok(properties.keys.every((key) => ['opacity', 'transform'].includes(key)));
      await toast.hover();
      await page.clock.fastForward(10000);
      await expect(toast).toBeVisible();
      await toast.locator('button').focus();
      await page.mouse.move(1, 1);
      await page.clock.fastForward(10000);
      await expect(toast).toBeVisible();
      await page.getByRole('textbox', { name: '任务输入' }).focus();
      // Leaving the stack restarts the full info duration (5 s), as in UI11.
      // The clock keeps running in real time here, so leave a margin on both sides of 5 s.
      await page.clock.fastForward(4000);
      await expect(toast).toBeVisible();
      await page.clock.fastForward(1400);
      await expect(toast).toHaveCount(0);
      await page.getByRole('button', { name: '本会话总是允许此完整命令', exact: true }).click();
      const actionToast = page
        .locator('.toast')
        .filter({ has: page.getByRole('button', { name: '撤销', exact: true }) });
      await expect(actionToast).toBeVisible();
      await page.mouse.move(1, 1);
      await page.getByRole('textbox', { name: '任务输入' }).focus();
      // The exact 6 s minimum is covered by notice-store.test.ts; leave real-time margin for the click.
      await page.clock.fastForward(5500);
      await expect(actionToast).toBeVisible();
      await actionToast.hover();
      await actionToast.getByRole('button', { name: '撤销', exact: true }).click();
      await expect
        .poll(() => page.evaluate(() => window.feedbackRevoked))
        .toEqual(['s1', 'shell-exact:bash:npm test']);
      await dismissAll();
      await page.evaluate(() => {
        window.feedbackToastPeak = 0;
        const observer = new MutationObserver(() => {
          window.feedbackToastPeak = Math.max(
            window.feedbackToastPeak,
            document.querySelectorAll('.toast').length,
          );
        });
        observer.observe(document.body, { childList: true, subtree: true });
        window.feedbackPeakObserver = observer;
        for (let index = 0; index < 5; index++) window.feedbackNotify('突发 ' + index);
      });
      await page.clock.fastForward(200);
      assert.ok(await page.evaluate(() => window.feedbackToastPeak <= 3));
      await page.screenshot({ path: path.join(output, `feedback-${uiStyle}-${theme}.png`) });
      await page.evaluate(() => window.feedbackPeakObserver.disconnect());
      await dismissAll();
      await page.emulateMedia({ reducedMotion: 'reduce' });
      // A pointer resting on the stack holds every timer (UI11), so keep it away from the toasts.
      await page.mouse.move(1, 1);
      await notify('减少动态效果', 'info');
      await page.clock.fastForward(5200);
      await expect(page.locator('.toast-stack')).toHaveCount(0);
      await notify('错误不会自动关闭', 'error');
      await page.clock.fastForward(30000);
      await expect(page.locator('.toast')).toBeVisible();
      await dismissAll();
      report.push({
        uiStyle,
        theme,
        saveWidth: idleWidth,
        errorProperties,
        toastProperties: properties,
        layouts: 4,
      });
    }
  }
  assert.deepEqual(errors, []);
  await fs.writeFile(
    path.join(output, 'feedback-motion-ui.json'),
    JSON.stringify({ report, errors }, null, 2) + '\n',
  );
  console.log(
    'PASS UI13 local feedback, notice limits, placement, pauses, actions, reduced motion and six appearances',
  );
} finally {
  await closeApp(app);
  await server.close();
}
