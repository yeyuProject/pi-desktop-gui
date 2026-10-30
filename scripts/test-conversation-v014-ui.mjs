import { launchApp, closeApp } from '../tests/support/desktop-app.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { emptyRuntime } from '../shared/types.ts';
import { createLocalProvider, prepareRealPiFixture } from '../tests/support/local-provider.ts';

// All messages, images and commands are local fixtures. Command reruns are captured, never executed.
const provider = await createLocalProvider();
const fixture = await prepareRealPiFixture(provider.baseUrl, 'conversation-v014-ui');
for (const name of ['alpha.ts', 'beta.ts', 'gamma.ts'])
  await fs.writeFile(path.join(fixture.projectDir, name), 'line1\nline2\nline3\nline4\nline5\n');
const runtime = {
  ...emptyRuntime(),
  sessionId: fixture.sessionId,
  connected: true,
  status: 'completed',
  stats: {
    tokens: 12000,
    inputTokens: 4000,
    outputTokens: 2000,
    cacheReadTokens: 5000,
    cacheWriteTokens: 1000,
    contextPercent: 80,
    contextTokens: 8000,
    contextWindow: 10000,
    cost: 0.02,
  },
  commands: [
    { name: 'check-diff', source: 'prompt', argumentHint: '<模块名> [关注点]', description: '检查模块' },
  ],
};
for (let index = 0; index < 500; index++)
  runtime.messages.push({
    role: index % 2 ? 'assistant' : 'user',
    content: `历史消息 ${index}`,
    timestamp: 1700000000000 + index,
  });
runtime.messages[9].content = 'EARLY_NEEDLE';
runtime.messages[11].content = [
  { type: 'thinking', thinking: 'HIDDEN_THINKING_NEEDLE' },
  { type: 'text', text: '想好了' },
];
runtime.messages[12].content =
  '提问\n\n<project_file path="alpha.ts" lines="3-4">\nREFERENCE_NEEDLE\n</project_file>';
runtime.messages.push({ role: 'user', content: '最后一轮检查', timestamp: 1700000100000 });
for (let index = 0; index < 5; index++) {
  const tool = {
    id: `read-${index}`,
    name: index % 2 ? 'grep' : 'read',
    args: { path: 'alpha.ts' },
    status: 'done',
    output:
      index === 3 ? 'GROUP_NEEDLE first\n' + 'output line\n'.repeat(250) + 'GROUP_NEEDLE last' : 'success',
    startedAt: 1,
    durationMs: 200,
  };
  runtime.tools.push({ ...tool, output: tool.output.split('\n').slice(-200).join('\n') });
  runtime.messages.push(
    {
      role: 'assistant',
      content: [{ type: 'toolCall', id: tool.id, name: tool.name, arguments: tool.args }],
    },
    { role: 'toolResult', toolCallId: tool.id, toolName: tool.name, content: tool.output },
  );
}
runtime.messages.push({
  role: 'assistant',
  content: '```ts\nconst value = "hello";\nconsole.log(value);\n```',
});
runtime.tools.push({
  id: 'shell',
  name: 'bash',
  args: { command: 'npm test' },
  status: 'done',
  output: '\x1b[32mPASS\x1b[0m\nprogress 1%\r\x1b[2Kprogress 100%',
  startedAt: 2,
  durationMs: 300,
});
const output = path.resolve('test-results', 'conversation-v014');
await fs.mkdir(output, { recursive: true });
let app, page;
const errors = [];
const waitSaved = async (predicate) => {
  for (let index = 0; index < 150; index++) {
    const state = JSON.parse(await fs.readFile(path.join(fixture.dataDir, 'state.json'), 'utf8'));
    if (predicate(state.sessions.find((item) => item.id === fixture.sessionId))) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error('Draft did not persist');
};
const waitSettings = async (key, expected) => {
  for (let index = 0; index < 150; index++) {
    const state = JSON.parse(await fs.readFile(path.join(fixture.dataDir, 'state.json'), 'utf8'));
    if (state.settings[key] === expected) {
      await page.waitForFunction(
        ({ label, expected }) =>
          document
            .querySelector(`[role="separator"][aria-label="${label}"]`)
            ?.getAttribute('aria-valuenow') === String(expected),
        { label: key === 'sidebarWidth' ? '项目侧栏宽度' : '文件面板宽度', expected },
      );
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`${key} did not persist as ${expected}`);
};
try {
  ({ app, page } = await launchApp({ dataDir: fixture.dataDir, pageTimeout: 10000, errors: errors }));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900));

  await page.getByRole('textbox', { name: '任务输入' }).waitFor();
  await app.evaluate(({ ipcMain }, runtime) => {
    globalThis.conversationCalls = [];
    globalThis.conversationRuntime = runtime;
    const handler = ipcMain._invokeHandlers.get('desktop:invoke');
    ipcMain.removeHandler('desktop:invoke');
    ipcMain.handle('desktop:invoke', async (event, method, args) => {
      if (method === 'readHistory') return globalThis.conversationRuntime.messages;
      if (['send', 'copy', 'copyImage', 'compact', 'branchSession'].includes(method)) {
        globalThis.conversationCalls.push({ method, args });
        return method === 'compact' ? { tokensBefore: 8000 } : undefined;
      }
      const result = await handler(event, method, args);
      return method === 'bootstrap' ? { ...result, runtime: globalThis.conversationRuntime } : result;
    });
  }, runtime);
  await page.reload();
  await page.bringToFront();
  const input = page.getByRole('textbox', { name: '任务输入' });
  await input.waitFor();
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
  const leftSash = page.getByRole('separator', { name: '项目侧栏宽度' });
  await leftSash.waitFor();
  await leftSash.press('Home');
  await waitSettings('sidebarWidth', 240);
  await leftSash.evaluate((element) => {
    for (let count = 0; count < 3; count++)
      element.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  });
  await waitSettings('sidebarWidth', 270);
  await leftSash.press('Home');
  await waitSettings('sidebarWidth', 240);
  await leftSash.press('ArrowRight');
  await waitSettings('sidebarWidth', 250);
  let bounds = await leftSash.boundingBox();
  await page.mouse.move(bounds.x + 2, bounds.y + 200);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 32, bounds.y + 200, { steps: 8 });
  await page.mouse.up();
  await waitSettings('sidebarWidth', 280);
  await page.reload();
  await leftSash.waitFor();
  assert.equal(await leftSash.getAttribute('aria-valuenow'), '280');
  await leftSash.dblclick();
  await waitSettings('sidebarWidth', 240);
  await input.press(modifier + '+j');
  const rightSash = page.getByRole('separator', { name: '文件面板宽度' });
  await rightSash.waitFor();
  await rightSash.press('Home');
  await waitSettings('inspectorWidth', 380);
  await rightSash.press('ArrowLeft');
  await waitSettings('inspectorWidth', 390);
  bounds = await rightSash.boundingBox();
  await page.mouse.move(bounds.x + 2, bounds.y + 180);
  await page.mouse.down();
  await page.mouse.move(bounds.x - 38, bounds.y + 180, { steps: 8 });
  await page.mouse.up();
  await waitSettings('inspectorWidth', 430);
  await page.reload();
  await input.waitFor();
  await input.press(modifier + '+j');
  await rightSash.waitFor();
  assert.equal(await rightSash.getAttribute('aria-valuenow'), '430');
  await rightSash.dblclick();
  await waitSettings('inspectorWidth', 380);
  await input.press('Alt+2');
  assert.ok(await page.locator('.inspector-tabs button.active').filter({ hasText: '文件' }).count());
  await input.press('Alt+3');
  assert.ok(await page.locator('.inspector-tabs button.active').filter({ hasText: '输出' }).count());
  await input.press('Alt+1');
  assert.ok(await page.locator('.inspector-tabs button.active').filter({ hasText: '变更' }).count());
  await input.press(modifier + '+j');
  await rightSash.waitFor({ state: 'detached' });
  console.log(
    'PASS both width separators drag, keyboard, reload persistence, double-click reset and panel shortcuts',
  );
  assert.equal(await page.locator('[data-message-index="9"]').count(), 0);
  await input.press(process.platform === 'darwin' ? 'Meta+f' : 'Control+f');
  const find = page.getByRole('textbox', { name: '查找当前会话' });
  await find.fill('EARLY_NEEDLE');
  await page.locator('[data-message-index="9"].search-active').waitFor();
  assert.ok(await page.locator('[data-message-index="9"]').isVisible());
  await find.fill('HIDDEN_THINKING_NEEDLE');
  await page.locator('.thinking[open]').waitFor();
  await find.fill('REFERENCE_NEEDLE');
  await page.locator('.message-attachment[open]').waitFor();
  await find.fill('GROUP_NEEDLE');
  await page.locator('.tool-group[open] .tool-card[open]').waitFor();
  assert.match(await page.locator('.search-active .tool-body').textContent(), /GROUP_NEEDLE first/);
  await find.press('Enter');
  await page.waitForFunction(
    () => document.querySelector('.search-active .search-current')?.parentElement?.scrollTop > 0,
  );
  // Both timed hits share the first page; observe an unrelated row on that page.
  await find.fill('EARLY_NEEDLE');
  await page.locator('[data-message-index="9"].search-active').waitFor();
  const searchTiming = await page.evaluate(async () => {
    const input = document.querySelector('[aria-label="查找当前会话"]');
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    const durations = [];
    let unrelatedMutations = 0;
    const history = document.querySelector('[data-message-index="40"]');
    const historyObserver = new MutationObserver((records) => {
      unrelatedMutations += records.length;
    });
    historyObserver.observe(history, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });
    for (let index = 0; index < 30; index++) {
      const needle = index % 2 ? 'EARLY_NEEDLE' : 'HIDDEN_THINKING_NEEDLE';
      const started = performance.now();
      await new Promise((resolve) => {
        const observer = new MutationObserver(() => {
          if (!document.querySelector('.search-active')?.textContent.includes(needle)) return;
          observer.disconnect();
          resolve();
        });
        observer.observe(document.querySelector('.thread'), {
          subtree: true,
          childList: true,
          attributes: true,
          characterData: true,
        });
        set.call(input, needle);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      durations.push(performance.now() - started);
    }
    historyObserver.disconnect();
    durations.sort((a, b) => a - b);
    return { medianMs: durations[15], p95Ms: durations[28], unrelatedMutations };
  });
  console.log('Search/highlight UI performance', searchTiming);
  assert.equal(searchTiming.unrelatedMutations, 0);
  assert.ok(searchTiming.medianMs < 16, `Search/highlight median ${searchTiming.medianMs}ms exceeds 16ms`);
  await find.press('Escape');
  assert.equal(await find.count(), 0);
  console.log('PASS search across 500 messages, thinking, attachments and grouped tools');

  await page.getByRole('button', { name: '回到最新', exact: true }).click();
  await page.locator('.tool-group').waitFor();
  const groups = page.locator('.tool-group');
  assert.equal(await groups.count(), 1);
  assert.match(await groups.locator('summary').first().textContent(), /已探索 5 项/);
  assert.equal(await page.locator('.tool-rerun').count(), 1);
  await page.getByTitle('本地重跑（不发给模型）').click();
  await page.getByTitle('重跑并发给 Pi', { exact: true }).click();
  const reruns = await app.evaluate(() =>
    globalThis.conversationCalls.filter((call) => call.method === 'send'),
  );
  assert.equal(reruns.at(-2).args[1], '!!npm test');
  assert.equal(reruns.at(-1).args[1], '!npm test');
  const outline = page.getByRole('navigation', { name: '对话轮次' });
  await outline.locator('button[data-outline-index]').first().focus();
  await page.keyboard.press('Home');
  await outline.getByRole('button', { name: /^第 2 轮：/ }).click();
  await page.waitForFunction(
    () => document.querySelector('[data-message-index="2"]')?.getBoundingClientRect().top < 250,
  );
  console.log('PASS tool groups, turn navigation and both explicit command reruns');

  await page.getByRole('button', { name: '回到最新', exact: true }).click();
  const code = page.locator('.code-block').last();
  await code.waitFor();
  assert.match(await code.locator('.code-header').textContent(), /ts · 2 行/);
  assert.equal(await code.locator('.syntax-keyword').count(), 1);
  await code.getByRole('button', { name: '自动换行' }).click();
  assert.equal(await code.getAttribute('class'), 'code-block code-wrap');
  await code.getByRole('button', { name: '复制代码' }).click();
  await code.getByText('已复制', { exact: true }).waitFor();
  const shell = page.locator('.tool-card').filter({ hasText: 'npm test' });
  await shell.locator('summary').click();
  await shell.locator('.ansi-green').waitFor();
  assert.match(await shell.locator('.ansi-output').textContent(), /PASS\nprogress 100%/);
  await shell.getByRole('button', { name: '复制输出', exact: true }).click();
  const copied = await app.evaluate(() =>
    globalThis.conversationCalls.filter((call) => call.method === 'copy').at(-1),
  );
  assert.equal(copied.args[0].includes('\x1b'), false);
  console.log('PASS code header, syntax, wrapping, copy feedback and clean ANSI output');

  await input.fill('@');
  await page.getByRole('option').nth(2).waitFor();
  const third = await page.locator('.file-picker [role="option"]').nth(2).innerText();
  await input.press('ArrowDown');
  await input.press('ArrowDown');
  await input.press('Tab');
  await page.locator('.attachments').getByRole('button', { name: third.trim(), exact: true }).waitFor();
  await input.fill('@alpha.ts:3-4');
  await page.locator('.file-picker [role="option"]').first().waitFor();
  await input.press('Enter');
  await page.getByRole('button', { name: 'alpha.ts#L3-L4', exact: true }).waitFor();
  while (await page.getByTitle(/^移除引用 /).count())
    await page
      .getByTitle(/^移除引用 /)
      .first()
      .click();
  await input.fill('before ');
  const pasted = Array.from({ length: 60 }, (_, index) => `log ${index}`).join('\n');
  await input.evaluate((element, text) => {
    element.setSelectionRange(element.value.length, element.value.length);
    const data = new DataTransfer();
    data.setData('text/plain', text);
    element.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
  }, pasted);
  await page.getByRole('button', { name: /^粘贴片段 · 60 行/ }).waitFor();
  assert.equal(await input.inputValue(), 'before ');
  await input.focus();
  await page.keyboard.insertText(' after');
  await waitSaved(
    (session) => session.draftSnippets?.[0]?.text === pasted && session.draft === 'before  after',
  );
  await page.reload();
  await page.getByRole('button', { name: /^粘贴片段 · 60 行/ }).waitFor();
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  const sent = await app.evaluate(() =>
    globalThis.conversationCalls.filter((call) => call.method === 'send').at(-1),
  );
  assert.equal(sent.args[1], 'before ' + pasted + ' after');
  await page.getByRole('button', { name: /^粘贴片段 · 60 行/ }).click();
  await page.getByRole('button', { name: '展开到输入框' }).click();
  assert.equal(await input.inputValue(), 'before ' + pasted + ' after');
  const heightHandle = page.getByRole('separator', { name: '调整输入框高度' });
  await heightHandle.evaluate((element) => {
    for (let index = 0; index < 7; index++)
      element.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
  });
  await page.waitForFunction(
    () => document.querySelector('[aria-label="调整输入框高度"]')?.getAttribute('aria-valuenow') === '55',
  );
  const composerBounds = await page.evaluate(() => ({
    inputHeight: document.querySelector('[aria-label="任务输入"]').getBoundingClientRect().height,
    bottom: document.querySelector('.composer-bottom').getBoundingClientRect().bottom,
    viewport: innerHeight,
  }));
  assert.ok(
    composerBounds.inputHeight >= composerBounds.viewport * 0.5 &&
      composerBounds.bottom <= composerBounds.viewport,
    JSON.stringify(composerBounds),
  );
  await heightHandle.evaluate((element) => {
    for (let index = 0; index < 7; index++)
      element.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  });
  console.log('PASS @ keyboard choice/ranges and long paste persistence, ordering and expansion');

  await input.fill('');
  for (const bytes of [550 * 1024, 600 * 1024]) {
    await input.evaluate((element, bytes) => {
      const data = new DataTransfer();
      data.setData('text/plain', 'x'.repeat(bytes));
      element.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
      );
    }, bytes);
    await waitSaved(
      (session) => (session.draftSnippets ?? []).reduce((sum, item) => sum + item.text.length, 0) >= bytes,
    );
  }
  await page.locator('.attachment-capacity.over').waitFor();
  assert.match(await page.locator('.attachment-capacity.over').textContent(), /占用最多：粘贴片段/);
  assert.equal(await page.getByRole('button', { name: '发送任务', exact: true }).isDisabled(), true);
  while (await page.getByTitle('移除粘贴片段', { exact: true }).count())
    await page.getByTitle('移除粘贴片段', { exact: true }).first().click();
  console.log('PASS capacity warning, largest attachment and 1 MiB send limit');

  await input.fill('/check-diff');
  await page.getByRole('textbox', { name: '模板参数：模块名' }).fill('src/hello world');
  await page.getByRole('textbox', { name: '模板参数：关注点' }).fill('errors');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  for (let attempt = 0; attempt < 100; attempt++) {
    const sent = await app.evaluate(
      () => globalThis.conversationCalls.filter((call) => call.method === 'send').at(-1)?.args[1],
    );
    if (sent === '/check-diff "src/hello world" errors') break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const template = await app.evaluate(() =>
    globalThis.conversationCalls.filter((call) => call.method === 'send').at(-1),
  );
  assert.equal(template.args[1], '/check-diff "src/hello world" errors');
  assert.match(
    await page.locator('.context-meter').textContent(),
    /上下文 80% \(8k \/ 10k\).*累计 12,000 tokens/,
  );
  await page.locator('.context-meter.mid').click();
  const usageText = await page.locator('.context-popover').innerText();
  for (const text of [
    '8,000 / 10,000 tokens (80.0%)',
    '窗口剩余 2,000 tokens',
    '会话累计 12,000 tokens',
    '累计缓存读取 5,000 tokens',
    '累计缓存写入 1,000 tokens',
    '缓存读取占输入 50.0%',
    '估算费用 $0.0200',
  ])
    assert.ok(usageText.includes(text), text);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.context-popover').count(), 0);
  await page.locator('.context-meter.mid').click();
  await input.click();
  assert.equal(await page.locator('.context-popover').count(), 0);
  await page.locator('.context-meter.mid').click();
  await page.getByRole('button', { name: '查看会话与本地用量' }).click();
  const usageDialog = page.getByRole('dialog', { name: 'Pi 功能' });
  await usageDialog.getByLabel('当前会话用量').waitFor();
  assert.match(await usageDialog.getByLabel('当前会话用量').innerText(), /8,000 \/ 10,000 tokens \(80\.0%\)/);
  assert.match(
    await usageDialog.getByLabel('当前会话用量').innerText(),
    /累计输入（不含缓存）\s+4,000 tokens/,
  );
  await usageDialog.getByRole('button', { name: '关闭', exact: true }).last().click();
  assert.equal(await page.locator('.context-popover').count(), 0);
  const showStats = async (stats) => {
    await app.evaluate(
      ({ BrowserWindow }, runtime) =>
        BrowserWindow.getAllWindows()[0].webContents.send('desktop:event', { type: 'runtime', runtime }),
      { ...runtime, stats },
    );
  };
  await showStats({ tokens: 12000, contextWindow: 10000 });
  await page.locator('.context-meter').filter({ hasText: '上下文 未知 / 10k' }).waitFor();
  await page.locator('.context-meter').click();
  assert.match(await page.locator('.context-popover').innerText(), /累计缓存读取 未知 tokens/);
  assert.match(await page.locator('.context-popover').innerText(), /缓存读取占输入 未知/);
  assert.match(await page.locator('.context-popover').innerText(), /估算费用 未知/);
  assert.equal(await page.locator('.context-meter .meter').count(), 0);
  await page.keyboard.press('Escape');
  await showStats({
    tokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cost: 0,
    contextTokens: 0,
    contextPercent: 0,
    contextWindow: 10000,
  });
  await page.locator('.context-meter').filter({ hasText: '上下文 0% (0 / 10k)' }).waitFor();
  assert.match(await page.locator('.context-meter').innerText(), /累计 0 tokens/);
  await page.locator('.context-meter').click();
  assert.match(await page.locator('.context-popover').innerText(), /缓存读取占输入 未知/);
  assert.match(await page.locator('.context-popover').innerText(), /估算费用 \$0\.0000/);
  await page.keyboard.press('Escape');
  await showStats(runtime.stats);
  await page.locator('.context-meter.mid').click();
  await page.getByRole('button', { name: '立即压缩上下文' }).click();
  assert.equal(
    await app.evaluate(() => globalThis.conversationCalls.some((call) => call.method === 'compact')),
    true,
  );
  console.log('PASS template parameters, labeled context/cache usage, popover dismissal and compact action');

  const pixel =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1XkAAAAASUVORK5CYII=';
  await page.evaluate(
    ({ id, pixel }) =>
      window.desktop.invoke(
        'saveDraft',
        id,
        '',
        [],
        [
          { id: 'pixel1', name: '第一张', mimeType: 'image/png', data: pixel },
          { id: 'pixel2', name: '第二张', mimeType: 'image/png', data: pixel },
        ],
        [],
      ),
    { id: fixture.sessionId, pixel },
  );
  // This fixture writes through IPC directly; normal composer edits already own their local state.
  await page.reload();
  await input.waitFor();
  await page.getByRole('button', { name: '查看图片 第一张' }).click();
  const lightbox = page.getByRole('dialog', { name: '图片查看器' });
  await lightbox.waitFor();
  await lightbox.getByRole('button', { name: '下一张图片' }).click();
  assert.match(await lightbox.textContent(), /第二张 · 2 \/ 2/);
  await lightbox.getByRole('button', { name: '放大图片' }).click();
  await lightbox.getByRole('button', { name: '复制图片', exact: true }).click();
  await lightbox.getByText('图片已复制').waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await lightbox.count(), 0);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: path.join(output, 'conversation-v014.png'), animations: 'disabled' });
  console.log('PASS image lightbox zoom, navigation, clipboard IPC and Escape');

  // Codemode children emit live tool events, but only their parent has a transcript result.
  const nestedTools = ['script', 'script/1', 'script/2'].map((id, index) => ({
    id,
    ...(index ? { parentToolCallId: 'script' } : {}),
    name: index ? 'bash' : 'codemode',
    args: index ? { command: `echo NESTED_COMMAND_${index}` } : { code: 'local fixture' },
    status: 'done',
    output: index ? `NESTED_OUTPUT_${index}` : 'Script completed',
    startedAt: index + 1,
    durationMs: 100,
  }));
  const ordered = {
    ...runtime,
    messages: [
      { role: 'user', content: 'Check both sources' },
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'script', name: 'codemode', arguments: nestedTools[0].args }],
      },
      {
        role: 'toolResult',
        toolCallId: 'script',
        toolName: 'codemode',
        content: 'Script completed',
        nestedCalls: {
          complete: true,
          calls: nestedTools.slice(1).map((tool) => ({
            id: tool.id,
            name: tool.name,
            arguments: tool.args,
            status: 'ok',
          })),
        },
      },
      { role: 'assistant', content: 'TOOL_ORDER_FINAL' },
      { role: 'user', content: 'Next question' },
      { role: 'assistant', content: 'TOOL_ORDER_FOLLOWUP' },
    ],
    tools: nestedTools,
  };
  const showRuntime = (runtime) =>
    app.evaluate(({ BrowserWindow }, runtime) => {
      globalThis.conversationRuntime = runtime;
      BrowserWindow.getAllWindows()[0].webContents.send('desktop:event', { type: 'runtime', runtime });
    }, runtime);
  const assertToolOrder = async () => {
    await page.getByText('TOOL_ORDER_FINAL', { exact: true }).waitFor();
    assert.equal(await page.locator('.tool-card').count(), 3, 'each tool appears exactly once');
    const displayed = await page
      .locator('.thread .tool-card > summary, .thread .message-content')
      .allTextContents();
    const positions = [
      'codemode',
      'NESTED_COMMAND_1',
      'NESTED_COMMAND_2',
      'TOOL_ORDER_FINAL',
      'TOOL_ORDER_FOLLOWUP',
    ].map((text) => displayed.findIndex((value) => value.includes(text)));
    assert.ok(
      positions.every((index, position) => index >= 0 && (!position || index > positions[position - 1])),
      `Commands must precede answers: ${JSON.stringify(displayed)}`,
    );
  };
  await showRuntime({
    ...ordered,
    status: 'running',
    messages: ordered.messages.slice(0, 2),
    tools: nestedTools.map((tool) => ({ ...tool, status: 'running' })),
  });
  await page.locator('.tool-card.running').nth(2).waitFor();
  assert.equal(await page.getByText('TOOL_ORDER_FINAL', { exact: true }).count(), 0);
  await showRuntime(ordered);
  await assertToolOrder();
  await page.reload();
  await input.waitFor();
  await assertToolOrder();
  await page.screenshot({ path: path.join(output, 'nested-tool-order.png'), animations: 'disabled' });
  console.log('PASS nested commands stay before final answers and later turns through completion and reload');

  await showRuntime({
    ...ordered,
    messages: ordered.messages.concat(
      Array.from({ length: 100 }, (_, index) => ({
        role: 'assistant',
        content: `Later history ${index}`,
      })),
    ),
  });
  await page.reload();
  await input.waitFor();
  assert.equal(await page.locator('[data-message-index="2"]').count(), 0);
  await input.press(modifier + '+f');
  await page.getByRole('textbox', { name: '查找当前会话' }).fill('NESTED_COMMAND_1');
  await page.locator('[data-message-index="2"] .search-active > .tool-card[open]').waitFor();
  assert.match(await page.locator('.search-active > .tool-card > summary').textContent(), /NESTED_COMMAND_1/);
  assert.equal(await page.locator('.tool-card').count(), 3);
  assert.deepEqual(errors, []);
  console.log('PASS search loads the owning history page and highlights only the matching nested command');
  const pagedTools = Array.from({ length: 100 }, (_, i) => ({
    id: `page-tool-${i}`,
    name: 'read',
    args: { path: `file-${i}.ts` },
    status: 'done',
    output: i === 0 ? 'EARLY_GROUP_RESULT' : `File ${i}`,
    startedAt: i,
    durationMs: 1,
  }));
  await showRuntime({
    ...ordered,
    tools: pagedTools,
    messages: [
      { role: 'user', content: 'Read many files' },
      ...pagedTools.flatMap((tool) => [
        {
          role: 'assistant',
          content: [{ type: 'toolCall', id: tool.id, name: tool.name, arguments: tool.args }],
        },
        { role: 'toolResult', toolCallId: tool.id, toolName: tool.name, content: tool.output },
      ]),
      { role: 'assistant', content: 'GROUP_COMPLETE' },
    ],
  });
  await page.reload();
  await input.waitFor();
  await page.locator('.tool-group > summary').waitFor();
  assert.match(await page.locator('.tool-group > summary').textContent(), /已探索 100 项/);
  await page.locator('.tool-group > summary').click();
  await page.locator('.tool-card').first().waitFor();
  assert.equal(await page.locator('.tool-card').count(), 40);
  await input.press(modifier + '+f');
  await page.getByRole('textbox', { name: '查找当前会话' }).fill('EARLY_GROUP_RESULT');
  await page.locator('[data-message-index="2"].search-active').waitFor();
  assert.match(await page.locator('.tool-group > summary').textContent(), /已探索 100 项.*本页 39 项/);
  assert.equal(await page.locator('.tool-card').count(), 39);
  assert.deepEqual(errors, []);
  console.log('PASS large tool groups retain total counts and render only the current history page');
} catch (error) {
  if (page && !page.isClosed()) {
    await page.screenshot({ path: path.join(output, 'failed.png'), animations: 'disabled' });
    console.error(
      await page
        .locator('.error-banner, .attachments, .file-picker, [aria-label="任务输入"]')
        .allTextContents(),
    );
  }
  throw error;
} finally {
  await closeApp(app);
  await provider.close();
}
