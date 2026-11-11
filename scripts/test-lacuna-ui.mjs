// 知溯术语解释：真实 Electron 渲染进程，模拟的知溯知识库。
// 检查：助手回复里问过的词带下划线（代码和链接里的不标）、悬停显示简短解释、点击打开解释卡片、
// 卡片里的词能接着点开并显示路径、在卡片和对话里选中文字问“这是什么意思”会把问题填进输入框、
// 顶栏打开知识图（默认关系图，可切到大纲）并从中打开卡片、切换会话时知识图不关、
// 窗口窄时知识图盖在对话上面、关掉设置后不再标。
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
      '**变分自编码器**也就是 VAE。\n\n' +
      '实验记录在[这份报告](file:///tmp/lacuna-report.md)里。',
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
    dependedBy: [
      { id: 'vae', title: '变分自编码器' },
      { id: 'zero', title: '零样本' },
    ],
  },
  zero: {
    id: 'zero',
    title: '零样本',
    aliases: ['zero-shot'],
    type: 'concept',
    summary: '不针对目标专门训练，只凭一段参考样例就完成任务。',
    body: '不针对目标专门训练，只凭一段参考样例就完成任务。',
    dependsOn: [{ id: 'latent', title: '隐变量' }],
    dependedBy: [{ id: 'topic', title: '如何优化 GPT-SoVITS 的效果？' }],
  },
  topic: {
    id: 'topic',
    title: '如何优化 GPT-SoVITS 的效果？',
    aliases: [],
    type: 'topic',
    summary: '选题。',
    body: '选题。',
    dependsOn: [
      { id: 'vae', title: '变分自编码器' },
      { id: 'zero', title: '零样本' },
    ],
    dependedBy: [],
  },
};
// 知识图面板的数据：选题 → 变分自编码器 → 隐变量，选题 → 零样本 → 隐变量。
const item = (id, children = []) => ({ id, title: nodes[id].title, type: nodes[id].type, children });
const graph = {
  outline: {
    topics: [
      item('topic', [item('vae', [item('latent')]), item('zero', [{ ...item('latent'), repeated: true }])]),
    ],
    loose: [],
  },
  nodes: Object.values(nodes).map(({ id, title, type }) => ({ id, title, type })),
  edges: [
    { from: 'topic', to: 'vae' },
    { from: 'vae', to: 'latent' },
    { from: 'topic', to: 'zero' },
    { from: 'zero', to: 'latent' },
  ],
};

// 模拟主进程的认词：最长的叫法优先，跳过反引号里的代码（真实规则在 lacuna 里，这里只要给出确定的结果）。
const install = ({ messages, nodes, graph }) => {
  const original = window.desktop.invoke;
  // 和真实的 lacuna 一样，选题不参与认词。
  const names = Object.values(nodes)
    .filter((node) => node.type !== 'topic')
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
    if (method === 'readHistory') return messages;
    // 记下选中的会话，工作台确认选择时（navigationState）才会真的切过去。
    if (method === 'selectSession') {
      window.lacunaSelected = args[0];
      return messages;
    }
    if (method === 'navigationState') {
      const value = await original(method, ...args);
      if (window.lacunaSelected) value.state.selectedSessionId = window.lacunaSelected;
      return value;
    }
    if (method === 'lacunaAnnotate') {
      window.lacunaRequests++;
      return args[0].map(annotate);
    }
    if (method === 'lacunaNode') return nodes[args[0]] ?? null;
    if (method === 'lacunaGraph') return { graph };
    // 点会话时侧边栏会检查能否拖动；空字符串表示可以。
    if (method === 'sessionMoveStatus') return { reason: '' };
    if (method === 'send') window.lacunaSent = [...(window.lacunaSent ?? []), args[1]];
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
    content: `(${workbenchFixture.toString()})({}); (${install.toString()})(${JSON.stringify({ messages, nodes, graph })});`,
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
    // 开了认词的回复照样允许本地文件链接（v0.14.75 的 urlTransform），链接地址不能被清掉。
    await expect(reply.getByRole('button', { name: '这份报告' })).toHaveAttribute(
      'title',
      'file:///tmp/lacuna-report.md',
    );

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
    await expect(panel.locator('nav button')).toHaveText(['知识图', '变分自编码器']);
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

    // 知识图：顶栏的“知识图”打开，默认是关系图；关系图和大纲里点任何一个词都进入解释卡片。
    const toggle = page.locator('.workspace-header').getByRole('button', { name: '知识图', exact: true });
    await toggle.click();
    await expect(panel.getByRole('tab', { name: '关系图' })).toHaveAttribute('aria-selected', 'true');
    await expect(panel).toHaveClass(/wide/);
    await expect(panel).not.toHaveClass(/drawer/);
    const graphNodes = panel.locator('.lacuna-graph-node');
    await expect(graphNodes).toHaveCount(4);
    await expect(panel.locator('.lacuna-graph-edge')).toHaveCount(4);
    await graphNodes.filter({ hasText: '隐变量' }).hover();
    await expect(panel.locator('.lacuna-graph-node.dim')).toHaveCount(1);
    await page.screenshot({ path: path.join(output, `lacuna-graph-${style}-${theme}.png`) });
    await graphNodes.filter({ hasText: '变分自编码器' }).click();
    await expect(panel.locator('h3')).toHaveText('变分自编码器');
    await panel.locator('nav button', { hasText: '知识图' }).click();
    await expect(panel.getByRole('tab', { name: '关系图' })).toHaveAttribute('aria-selected', 'true');

    await panel.getByRole('tab', { name: '大纲' }).click();
    await expect(panel).not.toHaveClass(/wide/);
    const titles = panel.locator('.lacuna-outline-title');
    await expect(titles).toHaveText([
      '如何优化 GPT-SoVITS 的效果？',
      '变分自编码器',
      '隐变量',
      '零样本',
      '隐变量',
    ]);
    await panel.getByLabel('搜索问过的词').fill('零样');
    await expect(titles).toHaveText(['如何优化 GPT-SoVITS 的效果？', '零样本']);
    await panel.getByLabel('搜索问过的词').fill('');
    await panel.getByRole('button', { name: '收起「变分自编码器」' }).click();
    await expect(titles).toHaveText(['如何优化 GPT-SoVITS 的效果？', '变分自编码器', '零样本', '隐变量']);
    await page.mouse.move(1, 1);
    await page.screenshot({ path: path.join(output, `lacuna-outline-${style}-${theme}.png`) });

    await titles.filter({ hasText: '零样本' }).click();
    await expect(panel.locator('h3')).toHaveText('零样本');
    await expect(panel.locator('nav button')).toHaveText(['知识图']);
    await panel.locator('nav button', { hasText: '知识图' }).click();
    await expect(panel.getByRole('tab', { name: '大纲' })).toHaveAttribute('aria-selected', 'true');

    // 知识库只有一个，和会话无关：切换会话时知识图不关，看的还是大纲。
    const session = (id) => page.locator(`.session-row[data-session-id="${id}"] > button`).first();
    await session('s2').click();
    await expect(session('s2')).toHaveAttribute('aria-current', 'page');
    await expect(panel).toBeVisible();
    await expect(panel.getByRole('tab', { name: '大纲' })).toHaveAttribute('aria-selected', 'true');
    await session('s1').click();
    await expect(session('s1')).toHaveAttribute('aria-current', 'page');
    await expect(panel).toBeVisible();

    // 面板靠边显示时不是弹层：输入框照常回车发送；在面板里按 Esc 关掉面板。
    await composer.fill(`面板开着也能发送 ${style}-${theme}`);
    await composer.press('Enter');
    await expect
      .poll(() => page.evaluate(() => window.lacunaSent ?? []))
      .toContain(`面板开着也能发送 ${style}-${theme}`);
    await panel.getByLabel('搜索问过的词').press('Escape');
    await expect(panel).toHaveCount(0);
    await toggle.click();
    await expect(panel).toBeVisible();
    await toggle.click();
    await expect(panel).toHaveCount(0);
  }

  // 窗口窄、靠边显示会让对话窄于 520px 时，和侧边对话一样盖在对话上面：点旁边或按 Esc 关掉。
  await page.goto(`${server.url}?style=classic&theme=light`);
  const resize = (width) =>
    app.evaluate(
      ({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 1000),
      width,
    );
  {
    const panel = page.locator('.lacuna-panel');
    const toggle = page.locator('.workspace-header').getByRole('button', { name: '知识图', exact: true });
    await resize(900);
    await toggle.click();
    await expect(panel).toHaveClass(/drawer/);
    await expect(panel).toHaveAttribute('role', 'dialog');
    const conversation = await page.locator('.conversation').boundingBox();
    const box = await panel.boundingBox();
    assert.ok(box.x + box.width <= conversation.x + conversation.width + 1, '盖在对话上面，不占对话的宽度');
    await page.screenshot({ path: path.join(output, 'lacuna-graph-drawer.png') });
    await page.locator('.lacuna-backdrop').click({ position: { x: 10, y: 10 } });
    await expect(panel).toHaveCount(0);
    await toggle.click();
    await expect(panel).toHaveClass(/drawer/);
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
    // 窗口变宽后靠边显示，不再是弹层。
    await resize(1440);
    await toggle.click();
    await expect(panel).not.toHaveClass(/drawer/);
    await expect(page.locator('.lacuna-backdrop')).toHaveCount(0);
    await toggle.click();
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
    'PASS lacuna terms: underline, hover, nested cards, ask from card and conversation, knowledge graph, session switch, drawer, setting off',
  );
} finally {
  await closeApp(app);
  await server.close();
}
