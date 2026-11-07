// 知溯术语解释：真实 Electron 渲染进程，模拟的知溯知识库。
// 检查：助手回复里问过的词带下划线（代码和链接里的不标）、悬停显示简短解释、点击打开解释卡片、
// 卡片里的词能接着点开并显示路径、在卡片和对话里选中文字问“这是什么意思”会把问题填进输入框、关掉设置后不再标。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'playwright/test';
import { launchApp, closeApp } from '../tests/support/desktop-app.mjs';
import { workbenchFixture } from '../tests/support/workbench-fixture.mjs';
import { startReadmeServer } from './readme-server.mjs';

const output = path.resolve('test-results');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-lacuna-ui-'));
const entry = path.join(dir, 'main.cjs');
await fs.mkdir(output, { recursive: true });
await fs.writeFile(
  entry,
  `const { app, BrowserWindow } = require('electron');
app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 1440, height: 1000, x: -3000, y: -2000,
    useContentSize: true, frame: false, show: false, webPreferences: { contextIsolation: true } });
  win.loadURL('about:blank'); win.showInactive();
});`,
);
const server = await startReadmeServer();
let app, page;
const errors = [];
const messages = [
  { role: 'user', content: '如何优化 GPT-SoVITS 的效果？' },
  {
    role: 'assistant',
    content:
      'SoVITS 解码器的核心是一个 VAE，它的隐变量带着音色信息。\n\n' +
      '代码里写成 `VAE()`，链接 [VAE](https://example.com) 里的不标。\n\n' +
      '**变分自编码器**也就是 VAE。',
  },
].map((message, index) => ({ ...message, timestamp: 1800000000000 + index }));
const nodes = {
  vae: {
    id: 'vae',
    title: '变分自编码器',
    aliases: ['VAE'],
    type: 'concept',
    summary: '把数据压成隐变量的分布，再从隐变量还原出数据。',
    body: '把数据压成隐变量的分布，再从隐变量还原出数据。\n\n训练时用变分推断求近似。',
    dependsOn: [{ id: 'latent', title: '隐变量' }],
    dependedBy: [{ id: 'topic', title: '如何优化 GPT-SoVITS 的效果？' }],
  },
  latent: {
    id: 'latent',
    title: '隐变量',
    aliases: ['latent variable'],
    type: 'concept',
    summary: '没有直接观测到、由模型自己学出来的变量。',
    body: '没有直接观测到、由模型自己学出来的变量。',
    dependsOn: [],
    dependedBy: [{ id: 'vae', title: '变分自编码器' }],
  },
};

// 模拟主进程的认词：最长的叫法优先，跳过反引号里的代码（真实规则在 lacuna 里，这里只要给出确定的结果）。
const install = ({ messages, nodes }) => {
  const original = window.desktop.invoke;
  const names = Object.values(nodes)
    .flatMap((node) => [node.title, ...node.aliases].map((name) => [name, node.id]))
    .sort((a, b) => b[0].length - a[0].length);
  const annotate = (text) => {
    const matches = [];
    for (const [name, id] of names) {
      for (let start = text.indexOf(name); start !== -1; start = text.indexOf(name, start + name.length)) {
        const end = start + name.length;
        const inCode = (text.slice(0, start).match(/`/g) ?? []).length % 2 === 1;
        if (inCode || matches.some((m) => start < m.end && end > m.start)) continue;
        matches.push({ start, end, text: name, ids: [id], kind: 'term' });
      }
    }
    matches.sort((a, b) => a.start - b.start);
    const terms = {};
    for (const { ids } of matches) {
      const node = nodes[ids[0]];
      terms[node.id] = { id: node.id, title: node.title, aliases: node.aliases, summary: node.summary };
    }
    return { matches, terms };
  };
  window.lacunaRequests = 0;
  window.desktop.invoke = async (method, ...args) => {
    if (method === 'selectSession' || method === 'readHistory') return messages;
    if (method === 'lacunaAnnotate') {
      window.lacunaRequests++;
      return args[1].map(annotate);
    }
    if (method === 'lacunaNode') return nodes[args[1]] ?? null;
    if (method === 'bootstrap') {
      const value = await original(method, ...args);
      const query = new URLSearchParams(location.search);
      value.runtime.tools = [];
      value.runtime.messages = messages;
      value.state.settings.uiStyle = query.get('style');
      value.state.settings.theme = query.get('theme');
      value.state.settings.lacunaTerms = query.get('terms') !== 'off';
      return value;
    }
    return original(method, ...args);
  };
};

/** 选中 element 里的一段文字，并像松开鼠标一样触发 pointerup。 */
async function select(locator, text) {
  await locator.evaluate((element, text) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const start = node.data.indexOf(text);
      if (start === -1) continue;
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, start + text.length);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      node.parentElement.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
      return;
    }
    throw new Error('没有找到要选中的文字：' + text);
  }, text);
}

try {
  ({ app, page } = await launchApp({ args: [entry], errors }));
  await page.addInitScript({
    content: `(${workbenchFixture.toString()})({}); (${install.toString()})(${JSON.stringify({ messages, nodes })});`,
  });
  for (const [style, theme] of [
    ['classic', 'light'],
    ['classic', 'dark'],
    ['codex', 'light'],
    ['claude', 'dark'],
  ]) {
    await page.goto(`${server.url}?style=${style}&theme=${theme}`);
    const reply = page.locator('.message.assistant').last();
    const terms = reply.locator('.lacuna-term');
    // VAE、隐变量、变分自编码器、VAE；代码和链接里的两个 VAE 不标。
    await expect(terms).toHaveText(['VAE', '隐变量', '变分自编码器', 'VAE']);
    await expect(reply.locator('code .lacuna-term, .inline-link .lacuna-term')).toHaveCount(0);

    await terms.first().hover();
    const preview = page.locator('.lacuna-preview');
    await expect(preview).toBeVisible();
    await expect(preview).toContainText('变分自编码器');
    await expect(preview).toContainText('把数据压成隐变量的分布');
    await page.screenshot({ path: path.join(output, `lacuna-hover-${style}-${theme}.png`) });

    await terms.first().click();
    const panel = page.locator('.lacuna-panel');
    await expect(panel.locator('h3')).toHaveText('变分自编码器');
    await expect(panel.getByText('也叫：VAE')).toBeVisible();
    await expect(panel.locator('.lacuna-refs button')).toHaveText(['隐变量', '如何优化 GPT-SoVITS 的效果？']);

    // 卡片里的词也能点开，路径变成两层；点路径回到上一层。
    await panel.locator('.lacuna-body .lacuna-term', { hasText: '隐变量' }).first().click();
    await expect(panel.locator('h3')).toHaveText('隐变量');
    await expect(panel.locator('nav button')).toHaveText(['变分自编码器']);
    await page.mouse.move(1, 1);
    await page.screenshot({ path: path.join(output, `lacuna-panel-${style}-${theme}.png`) });
    await panel.locator('nav button', { hasText: '变分自编码器' }).click();
    await expect(panel.locator('h3')).toHaveText('变分自编码器');

    // 在卡片里选中文字问“这是什么意思”：问题带上是在哪个词的解释里问的。
    const composer = page.getByLabel('任务输入');
    await select(panel.locator('.lacuna-body'), '变分推断');
    await panel.getByRole('button', { name: '这是什么意思' }).click();
    await expect(composer).toHaveValue(
      /「变分推断」是什么意思？（在「变分自编码器」的解释里问的，节点 id：vae）$/,
    );

    // 在对话里选中文字，选区菜单里也有“这是什么意思”。
    await select(reply, '音色信息');
    await page.locator('.selection-menu').getByRole('button', { name: '这是什么意思' }).click();
    await expect(composer).toHaveValue(/「音色信息」是什么意思？$/);

    await panel.getByRole('button', { name: '关闭知溯解释' }).click();
    await expect(panel).toHaveCount(0);
  }

  // 关掉设置后不认词，选区菜单里也没有“这是什么意思”。
  await page.goto(`${server.url}?style=classic&theme=light&terms=off`);
  const reply = page.locator('.message.assistant').last();
  await expect(reply).toContainText('音色信息');
  const before = await page.evaluate(() => window.lacunaRequests);
  await page.waitForTimeout(300);
  await expect(reply.locator('.lacuna-term')).toHaveCount(0);
  assert.equal(await page.evaluate(() => window.lacunaRequests), before);
  await select(reply, '音色信息');
  await expect(page.locator('.selection-menu')).toBeVisible();
  await expect(page.locator('.selection-menu').getByRole('button', { name: '这是什么意思' })).toHaveCount(0);

  assert.deepEqual(errors, []);
  console.log(
    'PASS lacuna terms: underline, hover, nested cards, ask from card and conversation, setting off',
  );
} finally {
  await closeApp(app);
  await server.close();
}
