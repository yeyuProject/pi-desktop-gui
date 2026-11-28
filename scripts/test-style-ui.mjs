// Real Electron renderer acceptance with deterministic conversation data.
// Native settings persistence and titlebar APIs are covered by test-theme-ui.mjs.
import { launchApp, closeApp } from '../tests/support/desktop-app.mjs';
import { expect } from 'playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startReadmeServer } from './readme-server.mjs';
import { workbenchFixture } from '../tests/support/workbench-fixture.mjs';
import { UI_STYLES, STYLE_META } from '../shared/window-theme.ts';

const uiStyle = process.argv[process.argv.indexOf('--style') + 1];
const record = process.argv.includes('--record-baseline');
assert.ok(UI_STYLES.includes(uiStyle), 'Use --style classic|codex|claude');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-style-ui-'));
const entry = path.join(dir, 'main.cjs');
await fs.writeFile(
  entry,
  `
const { app, BrowserWindow } = require('electron');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 1440, height: 900, x: -3000, y: -2000,
    useContentSize: true, show: false, webPreferences: { contextIsolation: true } });
  win.loadURL('about:blank');
  win.showInactive();
});
`,
);
const server = await startReadmeServer(process.env.PI_STYLE_DIST || 'dist');
let app, page;
const errors = [];
const output = path.resolve('test-results');
await fs.mkdir(output, { recursive: true });
const report = { contrast: {}, screenshots: [], overflow: [] };
const ratio = (a, b) => {
  const light = (hex) =>
    (hex.length === 4
      ? hex
          .slice(1)
          .split('')
          .map((x) => x + x)
          .join('')
      : hex.slice(1)
    )
      .match(/../g)
      .map((value) => parseInt(value, 16) / 255)
      .map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4))
      .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
  const x = light(a),
    y = light(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
async function tokens() {
  return page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    return Object.fromEntries(
      [
        'bg',
        'surface',
        'rail',
        'hover',
        'selected',
        'bubble',
        'code',
        'accent-soft',
        'ink',
        'muted',
        'accent',
        'primary',
        'on-accent',
        'on-primary',
        'success',
        'red',
        'warning',
        'syntax-keyword',
        'syntax-string',
        'syntax-number',
        'syntax-function',
        'syntax-comment',
      ].map((name) => [name, style.getPropertyValue('--' + name).trim()]),
    );
  });
}
async function contrast(theme) {
  const colors = await tokens(),
    samples = [];
  for (const foreground of ['ink', 'muted', 'accent', 'success', 'red', 'warning']) {
    for (const background of [
      'bg',
      'surface',
      'rail',
      'hover',
      'selected',
      'bubble',
      'code',
      'accent-soft',
    ]) {
      samples.push({ foreground, background, ratio: ratio(colors[foreground], colors[background]) });
    }
  }
  for (const [foreground, background] of [
    ['on-accent', 'accent'],
    ['on-primary', 'primary'],
    ...['keyword', 'string', 'number', 'function', 'comment'].map((name) => ['syntax-' + name, 'code']),
  ])
    samples.push({ foreground, background, ratio: ratio(colors[foreground], colors[background]) });
  for (const [foreground, background] of [
    ['primary', 'bg'],
    ['primary', 'surface'],
    ['accent', 'bg'],
  ])
    samples.push({
      foreground,
      background,
      ratio: ratio(colors[foreground], colors[background]),
      minimum: 3,
    });
  report.contrast[theme] = samples;
}
async function noOverflow(label) {
  const composer = uiStyle === 'claude' ? ', .composer, .composer-toolbar > div' : '';
  let values;
  // Resizing updates the responsive panels and toolbar through ResizeObserver.
  await expect
    .poll(
      async () => {
        values = await page
          .locator('.thread, .message.user .message-content' + composer)
          .evaluateAll((nodes) =>
            nodes.map((node) => ({
              selector: node.className,
              width: node.clientWidth,
              scroll: node.scrollWidth,
            })),
          );
        assert.ok(values.length >= 2);
        return values.filter((value) => value.scroll > value.width + 1);
      },
      { message: `${label}: horizontal overflow` },
    )
    .toEqual([]);
  report.overflow.push({ label, values });
}
async function screenshot(mode, name) {
  const file = `${uiStyle}-${mode}-${name}.png`;
  await page.mouse.move(1, 1);
  await page.screenshot({ path: path.join(output, file), animations: 'disabled' });
  report.screenshots.push(file);
}
async function semantics() {
  await page.getByRole('textbox', { name: '任务输入' }).fill('继续检查');
  await expect(page.locator('.send-button')).toBeEnabled();
  const actual = await page.evaluate(() => {
    const css = (selector, pseudo) => getComputedStyle(document.querySelector(selector), pseudo);
    const probe = document.createElement('i');
    document.body.append(probe);
    const color = (value) => {
      probe.style.color = value;
      return getComputedStyle(probe).color;
    };
    probe.style.boxShadow = 'var(--shadow-soft)';
    const shadow = getComputedStyle(probe).boxShadow;
    const result = {
      selected: css('.session-row.active').backgroundColor === color('var(--selected)'),
      stripe: css('.session-row.active', '::before').content === 'none',
      send:
        css('.send-button').backgroundColor === color('var(--primary)') &&
        css('.send-button').color === color('var(--on-primary)'),
      brand: css('.brand-mark').backgroundColor === color('var(--primary)'),
      connection: css('.connection-dot.ready').backgroundColor === color('var(--success)'),
      tool: css('.tool-card.done summary', '::before').backgroundColor === color('var(--success)'),
      additions: css('.line-delta ins').color === color('var(--success)'),
      radius: css('.composer').borderRadius === '20px',
      shadow: css('.composer').boxShadow === shadow,
      focus: css('.composer').borderColor === color('var(--line-strong)'),
      avatar: [...document.querySelectorAll('.message.assistant .avatar')].every(
        (node) => getComputedStyle(node).display === 'none',
      ),
      names: [...document.querySelectorAll('.message-heading > strong')].every(
        (node) =>
          getComputedStyle(node).display !== 'none' && getComputedStyle(node).clipPath === 'inset(50%)',
      ),
      bubble: [...document.querySelectorAll('.message.user .message-content')].every((node) => {
        const style = getComputedStyle(node),
          box = node.getBoundingClientRect(),
          parent = node.parentElement.getBoundingClientRect();
        return (
          style.backgroundColor === color('var(--bubble)') &&
          style.borderRadius === '12px' &&
          box.width <= Math.min(parent.width * 0.8, 620) + 1 &&
          Math.abs(box.right - parent.right) <= 1
        );
      }),
    };
    probe.style.background = 'color-mix(in srgb, var(--success) 9%, transparent)';
    result.added = css('.diff-row.added').backgroundColor === getComputedStyle(probe).backgroundColor;
    probe.remove();
    return result;
  });
  for (const [check, passed] of Object.entries(actual)) assert.equal(passed, true, check);
  assert.match(await page.locator('.message.user').first().ariaSnapshot(), /你/);
  assert.match(await page.locator('.message.assistant').first().ariaSnapshot(), /Pi/);
  await expect(page.locator('.goal-message-badge')).toBeVisible();
  await page.keyboard.press('Tab');
  await page.locator('.send-button').focus();
  const focus = await page.locator('.send-button').evaluate((node) => ({
    visible: node.matches(':focus-visible'),
    width: getComputedStyle(node).outlineWidth,
    color: getComputedStyle(node).outlineColor,
  }));
  assert.equal(focus.visible, true);
  assert.notEqual(focus.width, '0px');
  assert.equal(
    focus.color,
    await page.evaluate(() => {
      const node = document.createElement('i');
      node.style.color = 'var(--accent)';
      document.body.append(node);
      const value = getComputedStyle(node).color;
      node.remove();
      return value;
    }),
  );
}
async function typography() {
  const fonts = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    const get = (selector) => {
      const node = document.querySelector(selector);
      assertNode(node, selector);
      const style = getComputedStyle(node);
      return { family: style.fontFamily, size: parseFloat(style.fontSize) };
    };
    function assertNode(node, selector) {
      if (!node) throw new Error(`Missing typography fixture: ${selector}`);
    }
    return {
      reply: root.getPropertyValue('--font-reply').trim(),
      interface: root.fontFamily,
      assistant: get('.message.assistant .message-content'),
      user: get('.message.user .message-content'),
      code: get('.message.assistant .message-content code'),
      block: get('.message.assistant .code-block pre'),
      table: get('.message.assistant .message-content table'),
      thinking: get('.thinking'),
      tool: get('.tool-card'),
      sendRadius: getComputedStyle(document.querySelector('.send-button')).borderRadius,
    };
  });
  assert.match(fonts.user.family, /sans-serif$/);
  assert.equal(fonts.tool.family, fonts.interface);
  assert.equal(fonts.thinking.family, fonts.interface);
  assert.match(fonts.code.family, /ui-monospace/);
  assert.match(fonts.block.family, /ui-monospace/);
  if (fonts.reply) {
    assert.match(fonts.assistant.family, /^ui-serif/);
    assert.equal(fonts.assistant.size, 15);
    assert.equal(fonts.table.family, fonts.interface);
    assert.equal(fonts.sendRadius, '8px');
  } else assert.equal(fonts.assistant.family, fonts.user.family);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '外观与编辑器', exact: true }).click();
  const scale = page.getByRole('slider', { name: '字号比例', exact: true });
  await scale.focus();
  await scale.press('End');
  await expect
    .poll(() =>
      page
        .locator('.message.assistant .message-content')
        .first()
        .evaluate((node) => parseFloat(getComputedStyle(node).fontSize)),
    )
    .toBe(fonts.assistant.size * 2);
  await noOverflow(`${uiStyle}: 200% font scale`);
  await scale.press('Home');
  await expect
    .poll(() =>
      page
        .locator('.message.assistant .message-content')
        .first()
        .evaluate((node) => parseFloat(getComputedStyle(node).fontSize)),
    )
    .toBe(fonts.assistant.size);
  await page
    .getByRole('dialog', { name: '设置', exact: true })
    .locator(':scope > footer')
    .getByRole('button', { name: '关闭', exact: true })
    .click();
}
const selectors = {
  session: '.session-row.active',
  send: '.send-button',
  added: '.diff-row.added',
  removed: '.diff-row.removed',
  connection: '.connection-dot.ready',
  tool: '.tool-card.done',
  goal: '.goal-card',
  user: '.message.user .message-content',
  composer: '.composer',
  code: '.code-block',
  branch: '.breadcrumb .branch',
  model: '.model-pill',
  thinkingLevel: '.model-pill > em',
  goalButton: '.goal-button',
  permission: '.approval-pill',
  inspectorTab: '.inspector-tabs > button:not(.icon-button)',
  changeCount: '.inspector-tabs .count',
  inlineCode: '.message.assistant .message-content :not(pre) > code',
  toolbarIcon: '.composer-toolbar > div > .icon-button:not(.send-button)',
};
async function computed(selector) {
  const node = page.locator(selector).first();
  await node.waitFor({ state: 'attached' });
  return node.evaluate((element) => {
    const style = getComputedStyle(element);
    return Object.fromEntries(
      [
        'color',
        'background-color',
        'border-color',
        'border-width',
        'box-shadow',
        'border-radius',
        'padding',
        'margin',
        'font-size',
        'line-height',
      ].map((key) => [key, style.getPropertyValue(key)]),
    );
  });
}
async function load(options) {
  await page.goto(server.url + '?fixture=' + encodeURIComponent(JSON.stringify(options)));
  await page.getByRole('textbox', { name: '任务输入' }).waitFor();
  await page.getByRole('button', { name: '查看项目变更', exact: true }).first().click();
  await page.locator('aside').getByText('src/auth/validate.ts').click();
  await page.locator('.diff-row.added').first().waitFor();
}
async function collectBaseline(style) {
  const baseline = {};
  for (const theme of ['light', 'dark']) {
    await load({ theme, uiStyle: style, goal: true, stress: true });
    await page.getByRole('textbox', { name: '任务输入' }).fill('继续检查');
    await expect(page.locator('.send-button')).toBeEnabled();
    await page.mouse.move(1, 1);
    baseline[theme] = {};
    for (const [name, selector] of Object.entries(selectors))
      baseline[theme][name] = await computed(selector);
    const shell = '.tool-card:has(summary code[title="npm test -- validate"])';
    if (!record) {
      await page.locator(shell + ' > summary').hover();
      await expect(page.locator(shell)).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    }
    await page.locator(shell + ' > summary').click();
    const body = page.locator(shell + ' > .tool-body');
    await body.waitFor();
    await page.mouse.move(1, 1);
    baseline[theme].toolOpen = await computed(shell);
    baseline[theme].toolSummary = await computed(shell + ' > summary');
    baseline[theme].toolOutput = await computed(shell + ' > .tool-body');
    baseline[theme].toolCopy = await computed(shell + ' .tool-actions .icon-button');
    baseline[theme].toolRerun = await computed(shell + ' .tool-rerun button');
    if (!record) {
      const copy = body.getByRole('button', { name: '复制输出', exact: true });
      const actions = body.locator('.tool-actions');
      await expect(actions).toHaveCSS('opacity', '0');
      await copy.focus();
      await expect(actions).toHaveCSS('opacity', '1');
      await copy.blur();
      await body.hover();
      await expect(actions).toHaveCSS('opacity', '1');
      await expect(actions).toHaveCSS('position', 'absolute');
      const [headingBox, outputBox, copyBox] = await Promise.all([
        page.locator(shell + ' > summary').boundingBox(),
        body.boundingBox(),
        copy.boundingBox(),
      ]);
      assert.equal(headingBox.y + headingBox.height, outputBox.y, 'tool header meets its output');
      assert.ok(
        copyBox.y - outputBox.y <= 5 && outputBox.x + outputBox.width - copyBox.x - copyBox.width <= 5,
      );
      await expect(page.locator(shell + ' .tool-rerun button').first()).toHaveCSS('height', '22px');
    }
    await page.getByRole('button', { name: '选择模型', exact: true }).click();
    baseline[theme].modelPopover = await computed('.model-picker');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '设置', exact: true }).click();
    baseline[theme].primary = await computed('.modal .primary');
    baseline[theme].modal = await computed('.modal');
    baseline[theme].modalItem = await computed('.settings-layout > nav > button');
    if (!record && style === 'classic') {
      const navigation = await computed('.settings-layout > nav');
      assert.ok(
        Math.abs(
          parseFloat(baseline[theme].modal['border-radius']) -
            parseFloat(baseline[theme].modalItem['border-radius']) -
            parseFloat(navigation.padding.split(' ').at(1)) -
            parseFloat(baseline[theme].modal['border-width']),
        ) <= 1,
        'modal list rows follow the outside corner',
      );
      const toolbar = await computed('.composer-toolbar');
      assert.equal(
        parseFloat(baseline[theme].composer['border-radius']) -
          parseFloat(baseline[theme].toolbarIcon['border-radius']),
        parseFloat(toolbar.padding.split(' ').at(-1)),
      );
    }
  }
  return baseline;
}

async function checkRadiusBaseline(style) {
  const baseline = await collectBaseline(style);
  assert.deepEqual(baseline, JSON.parse(await fs.readFile(`tests/fixtures/${style}-style.json`, 'utf8')));
  for (const samples of Object.values(baseline)) {
    const radius = (name) => samples[name]['border-radius'];
    assert.equal(samples.toolOpen['border-width'], '1px');
    assert.equal(radius('toolOpen'), style === 'classic' ? '14px' : '12px');
    assert.equal(samples.toolOpen['background-color'], samples.code['background-color']);
    assert.equal(samples.toolSummary['border-width'], '0px');
    assert.equal(samples.toolOutput['border-width'], '1px 0px 0px');
    assert.equal(samples.toolOutput['border-color'].split(')')[0] + ')', samples.toolOpen['border-color']);
    assert.equal(samples.toolOutput['background-color'], 'rgba(0, 0, 0, 0)');
    assert.equal(radius('toolRerun'), '999px');
    assert.equal(samples.toolRerun['font-size'], '11px');
    assert.equal(samples.toolRerun['background-color'], 'rgba(0, 0, 0, 0)');
    if (style === 'classic') {
      assert.equal(radius('send'), '50%');
      assert.equal(radius('user'), '22px 22px 6px');
      continue;
    }
    assert.equal(radius('composer'), '20px');
    assert.equal(radius('user'), '12px');
    assert.equal(radius('code'), '12px');
    if (style === 'claude') assert.equal(radius('send'), '8px');
    const tiers = new Set(['0px', '50%', '4px', '8px', '12px', '20px', '999px']);
    for (const name of Object.keys(samples)) {
      assert.ok(
        radius(name)
          .split(' ')
          .every((corner) => tiers.has(corner)),
        `${style} ${name} uses a radius tier: ${radius(name)}`,
      );
    }
  }
  console.log(`PASS ${STYLE_META[style].label} light/dark computed styles and UI19 corners.`);
}
try {
  ({ app, page } = await launchApp({ args: [entry], colorScheme: null, pageTimeout: 15000, errors: errors }));

  await page.emulateMedia({ reducedMotion: 'reduce' });

  await page.addInitScript({
    content: `(${workbenchFixture.toString()})(JSON.parse(new URLSearchParams(location.search).get('fixture') || '{}'))`,
  });
  if (record) {
    const baseline = await collectBaseline(uiStyle);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify(baseline, null, 2));
  } else {
    if (uiStyle === 'codex') await checkRadiusBaseline('classic');
    await checkRadiusBaseline(uiStyle);
    assert.deepEqual(errors, []);
  }
  if (!record && uiStyle !== 'classic') {
    for (const theme of ['light', 'dark']) {
      const mode = theme;
      await load({ theme, uiStyle, goal: true });
      await contrast(theme);
      await semantics();
      await noOverflow(`${mode}: workspace`);
      await page.locator('.thread').evaluate((node) => {
        node.scrollTop = 0;
      });
      await screenshot(mode, 'workspace');

      await page.getByRole('button', { name: '设置', exact: true }).click();
      await page.getByRole('button', { name: '外观与编辑器', exact: true }).click();
      const primary = await computed('.modal .primary');
      assert.equal(primary['background-color'], (await computed('.send-button'))['background-color']);
      await screenshot(mode, 'settings');
      await page
        .getByRole('dialog', { name: '设置', exact: true })
        .locator(':scope > footer')
        .getByRole('button', { name: '关闭', exact: true })
        .click();

      // Use the fixture's platform, which can differ from the Electron host.
      const platform = await page.evaluate(() => window.desktop.platform);
      await page.keyboard.press(platform === 'darwin' ? 'Meta+k' : 'Control+k');
      await page.getByRole('textbox', { name: '搜索项目和会话' }).waitFor();
      await screenshot(mode, 'command');
      await page.keyboard.press('Escape');

      await page.getByRole('button', { name: '展开 Goal 详情', exact: true }).click();
      await noOverflow(`${mode}: goal`);
      await screenshot(mode, 'goal');
      await page.getByRole('button', { name: '收起 Goal 详情', exact: true }).click();
      await expect(page.locator('.diff-row.added').first()).toBeVisible();
      await screenshot(mode, 'diff');

      await page.getByRole('button', { name: '选择模型', exact: true }).click();
      await page.getByRole('dialog', { name: '模型与推理级别' }).waitFor();
      await screenshot(mode, 'model');
      await page.keyboard.press('Escape');

      await page.evaluate(() => window.dispatchEvent(new CustomEvent('pi:side', { detail: { show: true } })));
      await page.getByRole('textbox', { name: '侧边问题' }).waitFor();
      await expect(page.getByText('为什么要先 trim()？', { exact: true })).toBeVisible();
      await noOverflow(`${mode}: side chat`);
      await screenshot(mode, 'side-chat');

      await load({ theme, uiStyle, goal: true, approval: true });
      await expect(page.locator('.approval-card')).toBeVisible();
      await noOverflow(`${mode}: approval`);
      await screenshot(mode, 'approval');
      await page.getByRole('textbox', { name: '任务输入' }).focus();
      const running = await page.locator('.composer').evaluate((node) => ({
        border: getComputedStyle(node).borderColor,
        shadow: getComputedStyle(node).boxShadow,
      }));
      assert.equal(
        running.shadow,
        await page.evaluate(() => {
          const node = document.createElement('i');
          node.style.boxShadow = 'var(--shadow-soft)';
          document.body.append(node);
          const value = getComputedStyle(node).boxShadow;
          node.remove();
          return value;
        }),
      );
      assert.equal(
        running.border,
        await page.evaluate(() => {
          const node = document.createElement('i');
          node.style.color = 'color-mix(in srgb, var(--signal) 65%, var(--line))';
          document.body.append(node);
          const value = getComputedStyle(node).color;
          node.remove();
          return value;
        }),
      );

      await load({ theme, uiStyle, goal: 'completed', stress: true });
      await page.getByRole('button', { name: '查看上个 Goal 结果', exact: true }).click();
      assert.equal(
        await page.locator('.goal-icon').evaluate((node) => getComputedStyle(node).color),
        await page
          .locator('.connection-dot.ready')
          .evaluate((node) => getComputedStyle(node).backgroundColor),
      );
      await typography();
      await noOverflow(`${mode}: folded long prompt, quotes, files, images and wide code`);
      await page.locator('.user-message-expand').first().click();
      await page.locator('.skill-toggle').first().click();
      await page.locator('details.message-attachment > summary').first().click();
      await noOverflow(`${mode}: expanded prompt, skill and attachment`);
      await expect(page.locator('.message-quote')).toHaveCount(1);
      await expect(page.getByRole('img', { name: '附件图片 1' })).toHaveCount(1);
      assert.equal((await computed('.code-block'))['border-radius'], '12px');
      await page.locator('.turn-tick').first().hover();
      await noOverflow(`${mode}: expanded outline`);
      // A compact window also keeps the question bubble and its children inside the thread.
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(900, 760));
      await noOverflow(`${mode}: compact window`);
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900));
    }
    // Deterministically test media queries without changing the host's appearance.
    await page.emulateMedia({ colorScheme: 'dark' });
    for (const style of ['classic', uiStyle]) {
      await load({ theme: 'dark', uiStyle: style, goal: true });
      const explicit = await tokens();
      await load({ theme: 'system', uiStyle: style, goal: true });
      const colors = await tokens();
      assert.deepEqual(colors, explicit, `${style}: system dark tokens`);
      assert.ok(ratio(colors['syntax-keyword'], colors.code) >= 4.5);
    }
    assert.equal(report.screenshots.length, 16);
    for (const [theme, samples] of Object.entries(report.contrast)) {
      for (const sample of samples)
        assert.ok(sample.ratio >= (sample.minimum ?? 4.5), `${theme}: ${JSON.stringify(sample)}`);
    }
    assert.deepEqual(errors, []);
    await fs.writeFile(
      path.join(output, `${uiStyle}-style-ui.json`),
      JSON.stringify({ passed: true, ...report }, null, 2),
    );
    console.log(
      `PASS ${STYLE_META[uiStyle].label} contrast, geometry, typography, accessibility, overflow and 16 Electron screenshots.`,
    );
  }
} finally {
  await closeApp(app);
  await server.close();
  await fs.rm(dir, { recursive: true, force: true });
}
