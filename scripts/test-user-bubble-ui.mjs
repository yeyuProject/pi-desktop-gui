// Real Electron renderer, deterministic messages and recorded action arguments.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'playwright/test';
import { launchApp, closeApp } from '../tests/support/desktop-app.mjs';
import { workbenchFixture } from '../tests/support/workbench-fixture.mjs';
import { startReadmeServer } from './readme-server.mjs';

const output = path.resolve('test-results');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-user-bubble-'));
const entry = path.join(dir, 'main.cjs');
await fs.mkdir(output, { recursive: true });
await fs.writeFile(
  entry,
  `const { app, BrowserWindow } = require('electron');
app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 1440, height: 1100, x: -3000, y: -2000,
    useContentSize: true, frame: false, show: false, webPreferences: { contextIsolation: true } });
  win.loadURL('about:blank'); win.showInactive();
});`,
);
const server = await startReadmeServer();
let app, page;
const errors = [];
const report = [];
const short = '我记得jb公司也出了几款轻量的编辑器';
const thirty = '春夏秋冬风雨雷电山川湖海日月星辰花草树木飞鸟游鱼清风明月远山';
assert.equal(thirty.length, 30);
const skill = '<skill name="bubble" location="/fixture/SKILL.md">\n检查代码\n</skill>\n\n请用这个技能检查';
const messages = [
  { role: 'user', content: short },
  { role: 'user', content: thirty },
  { role: 'user', content: '这是一条较长的消息，用来检查气泡宽度和自动换行。'.repeat(5) },
  { role: 'user', content: skill },
  {
    role: 'user',
    content: '请检查文件\n\n<project_file path="src/example.ts">\nconst answer = 42;\n</project_file>',
  },
  {
    role: 'user',
    content: [
      { type: 'text', text: '请检查图片' },
      {
        type: 'image',
        mimeType: 'image/png',
        data: '',
      },
    ],
  },
  { role: 'assistant', content: '第一条回复。' },
  { role: 'assistant', content: '第二条回复。' },
].map((message, index) => ({ ...message, timestamp: 1800000000000 + index }));

try {
  ({ app, page } = await launchApp({ args: [entry], errors }));
  messages[5].content[1].data = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 160;
    canvas.height = 64;
    const context = canvas.getContext('2d');
    context.fillStyle = '#386e5a';
    context.fillRect(0, 0, 160, 64);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  const installMessages = ({ messages }) => {
    const original = window.desktop.invoke;
    window.bubbleCopies = [];
    window.desktop.invoke = async (method, ...args) => {
      if (method === 'selectSession' || method === 'readHistory') return messages;
      if (method === 'checkpoints')
        return [{ id: 'bubble-checkpoint', timestamp: messages[3].timestamp, turn: 4, available: true }];
      if (method === 'changes') {
        const value = await original(method, ...args);
        value.checkpoints = [
          { id: 'bubble-checkpoint', timestamp: messages[3].timestamp, turn: 4, available: true },
        ];
        return value;
      }
      if (method === 'copy') {
        window.bubbleCopies.push(args[0]);
        return;
      }
      if (method === 'bootstrap') {
        const value = await original(method, ...args);
        value.runtime.tools = [];
        value.runtime.messages = messages;
        value.state.settings.uiStyle = new URLSearchParams(location.search).get('style');
        value.state.settings.theme = new URLSearchParams(location.search).get('theme');
        return value;
      }
      return original(method, ...args);
    };
  };
  await page.addInitScript({
    content: `(${workbenchFixture.toString()})({}); (${installMessages.toString()})(${JSON.stringify({ messages })});`,
  });
  for (const style of ['classic', 'codex', 'claude']) {
    for (const theme of ['light', 'dark']) {
      await page.goto(`${server.url}?style=${style}&theme=${theme}`);
      const users = page.locator('.message.user');
      await expect(users).toHaveCount(6);
      await expect(page.locator('html')).toHaveAttribute('data-style', style);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(users.nth(4).locator('details.message-attachment')).toHaveCount(1);
      await expect(
        users.nth(4).getByRole('button', { name: '更多消息操作', includeHidden: true }),
      ).toHaveCount(1);
      await expect(users.nth(5).getByRole('img', { name: '附件图片 1' })).toBeVisible();
      await expect
        .poll(() =>
          users
            .nth(5)
            .locator('img')
            .evaluate((node) => node.naturalWidth),
        )
        .toBe(160);
      await page.getByRole('button', { name: '查看项目变更', exact: true }).first().click();
      await page.mouse.move(1, 1);
      const measurements = {};
      for (const width of [1200, 1440]) {
        // Use exact CSS viewport sizes; off-screen Windows native bounds can include frame offsets.
        await page.setViewportSize({ width, height: 1100 });
        await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width);
        await page.evaluate(
          () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        );
        measurements[width] = await users.evaluateAll((nodes) =>
          nodes.map((node) => {
            const bubble = node.querySelector('.message-content');
            const text = node.querySelector('.user-message-text');
            const box = bubble.getBoundingClientRect();
            return {
              width: box.width,
              height: box.height,
              lineHeight: parseFloat(getComputedStyle(bubble).lineHeight),
              fontSize: parseFloat(getComputedStyle(bubble).fontSize),
              padding:
                parseFloat(getComputedStyle(bubble).paddingTop) +
                parseFloat(getComputedStyle(bubble).paddingBottom),
              column: node.getBoundingClientRect().width,
              lines: text.getBoundingClientRect().height / parseFloat(getComputedStyle(bubble).lineHeight),
              right: Math.abs(box.right - node.getBoundingClientRect().right),
              overflow: bubble.scrollWidth - bubble.clientWidth,
            };
          }),
        );
        console.log(style, theme, width, measurements[width].slice(0, 2));
        for (const bubble of measurements[width]) {
          assert.ok(bubble.width <= Math.min(620, bubble.column * 0.8) + 1);
          if (bubble.lines > 1.1)
            assert.ok(
              bubble.width >= Math.min(620, bubble.column * 0.8) - bubble.fontSize,
              'wrapped text fills the available bubble width',
            );
          assert.ok(bubble.right <= 1);
          assert.ok(bubble.overflow <= 1);
        }
        assert.ok(Math.abs(measurements[width][0].lines - 1) < 0.1, 'reported short sentence fits one line');
        const single = measurements[width][0];
        assert.ok(
          Math.abs(single.height - single.lineHeight - single.padding) <= 1,
          'short bubble height is one line plus padding',
        );
      }
      assert.ok(
        Math.abs(measurements[1440][1].lines - 1) < 0.1,
        '30 Chinese characters fit one line at 1440px',
      );
      await page.setViewportSize({ width: 1200, height: 1100 });
      await page.getByRole('button', { name: '收起变更面板', exact: true }).click();
      const exampleA = await users.nth(1).evaluate((node) => ({
        column: node.getBoundingClientRect().width,
        lines:
          node.querySelector('.user-message-text').getBoundingClientRect().height /
          parseFloat(getComputedStyle(node.querySelector('.message-content')).lineHeight),
      }));
      assert.ok(
        exampleA.column >= 600 && Math.abs(exampleA.lines - 1) < 0.1,
        'example A: 30 characters fit when the changes panel is closed',
      );
      assert.ok(measurements[1200][1].lines > 1.1, 'example B: 30 characters wrap in a narrow column');
      measurements.exampleA = exampleA;
      await page.getByRole('button', { name: '查看项目变更', exact: true }).first().click();
      await page.setViewportSize({ width: 1440, height: 1100 });
      await expect(users.first().locator('.message-footer')).toBeHidden();
      await expect(
        users.first().getByRole('button', { name: '更多消息操作', includeHidden: true }),
      ).toHaveCount(0);
      const gaps = await page.evaluate(() => {
        const gap = (selector) => {
          const nodes = document.querySelectorAll(selector);
          return nodes[1].getBoundingClientRect().top - nodes[0].getBoundingClientRect().bottom;
        };
        return { user: gap('.message.user'), assistant: gap('.message.assistant') };
      });
      assert.ok(Math.abs(gaps.user - gaps.assistant) <= 8, JSON.stringify(gaps));
      const rich = users.nth(3);
      await page.locator('.thread').evaluate((node) => {
        node.scrollTop = 0;
      });
      await page.screenshot({ path: path.join(output, `user-bubble-${style}-${theme}.png`) });
      await rich.hover();
      const footer = rich.locator('.message-footer');
      await expect(footer).toBeVisible();
      const buttons = footer.getByRole('button');
      const order = [
        '复制消息',
        '撤销此轮起的文件修改',
        '编辑后重新发送',
        '从这里分支到新会话',
        '更多消息操作',
      ];
      assert.deepEqual(
        await buttons.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('title'))),
        order,
      );
      const position = await rich.evaluate((node) => {
        const bubble = node.querySelector('.message-content').getBoundingClientRect();
        const footer = node.querySelector('.message-footer').getBoundingClientRect();
        return { below: footer.top - bubble.bottom, right: Math.abs(footer.right - bubble.right) };
      });
      assert.ok(position.below >= 0 && position.below <= 3 && position.right <= 1);
      await page.screenshot({ path: path.join(output, `user-bubble-${style}-${theme}-hover.png`) });
      await page.mouse.move(1, 1);
      await expect(footer).toBeHidden();
      await rich.focus();
      await page.keyboard.press('Tab');
      await expect(rich.locator('.skill-toggle')).toBeFocused();
      await page.keyboard.press('Tab');
      for (let index = 0; index < order.length; index++) {
        await expect(buttons.nth(index)).toBeFocused();
        await expect(footer).toBeVisible();
        if (index < order.length - 1) await page.keyboard.press('Tab');
      }
      await buttons.first().click();
      await expect
        .poll(() => page.evaluate(() => window.bubbleCopies.at(-1)))
        .toBe('/skill:bubble 请用这个技能检查');
      await buttons.last().click();
      await rich.getByRole('menuitem', { name: '复制完整内容' }).click();
      await expect.poll(() => page.evaluate(() => window.bubbleCopies.at(-1))).toBe(skill);
      await users.first().hover();
      await users.first().getByRole('button', { name: '复制消息', exact: true }).click();
      await expect.poll(() => page.evaluate(() => window.bubbleCopies.at(-1))).toBe(short);
      report.push({ style, theme, measurements, gaps, position, order });
    }
  }
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(output, 'user-bubble-ui.json'), JSON.stringify(report, null, 2) + '\n');
  console.log('PASS user bubbles in all six appearances, copy actions, hover and keyboard navigation');
} finally {
  await closeApp(app);
  await server.close();
}
