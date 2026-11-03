import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Message } from '../shared/types';
import type { MessageContext } from '../src/components/conversation/ChatMessage';

Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: { desktop: { platform: 'linux' } },
});
// Bundle the production component; CSS has no role in server-rendered markup.
const built = buildSync({
  entryPoints: [path.resolve('src/components/conversation/ChatMessage.tsx')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  packages: 'external',
  write: false,
  loader: { '.css': 'empty' },
});
const loaded = { exports: {} };
new Function('require', 'module', 'exports', built.outputFiles[0].text)(
  createRequire(import.meta.url),
  loaded,
  loaded.exports,
);
const { ChatMessage } = loaded.exports as typeof import('../src/components/conversation/ChatMessage');
const ctx: MessageContext = {
  running: false,
  locked: false,
  expanded: [],
  liveToolIds: new Set(),
  toolFor() {
    throw new Error('No tools in thinking-only reply');
  },
  toggleTool() {},
  openFile() {},
  async copy() {
    return true;
  },
  act() {},
};
const message: Message = {
  role: 'assistant',
  timestamp: 1234,
  content: [{ type: 'thinking', thinking: 'THINKING_ONLY_CONTENT' }],
  model: 'thinking-model',
  provider: 'local-test',
  usage: { totalTokens: 130, input: 100, output: 30, cost: { total: 0.05 } },
};
const render = (stopReason: string, last = true) =>
  renderToStaticMarkup(
    React.createElement(ChatMessage, { m: { ...message, stopReason }, last, ctx, hideThinking: true }),
  );
for (const reason of ['stop', 'aborted', 'length'])
  test(`${reason}: grouped thinking retains terminal reply metadata and regenerate action`, () => {
    const html = render(reason);
    assert.match(html, /class="message assistant"/);
    assert.match(html, /thinking-model/);
    assert.match(html, /130 tokens/);
    assert.match(html, /\$0\.05/);
    assert.equal((html.match(/aria-label="重新生成这条回复"/g) ?? []).length, 1);
    assert.doesNotMatch(html, /THINKING_ONLY_CONTENT|class="thinking"/);
    const history = render(reason, false);
    assert.match(history, /130 tokens/);
    assert.doesNotMatch(history, /重新生成这条回复/);
  });
test('tool-continuation thinking stays compact when displayed in the group', () => {
  assert.equal(render('toolUse'), '');
});
