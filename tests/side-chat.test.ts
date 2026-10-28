import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { streamSideChat } from '../electron/pi-side-chat';
import { SideChats } from '../electron/side-chats';
import { sideChatContext, validateSideChatInput, type SideChat } from '../shared/side-chat';
import { removeSessionScratch } from '../electron/local-data';
import { Store } from '../electron/store';
import { composeQuotedInput, type DraftQuote } from '../shared/message-content';
import { matchesDraft } from '../shared/draft';
import { aggregateUsage } from '../shared/usage';
import type { Message } from '../shared/types';
import { validateBridgeResult } from '../electron/pi/protocol';

const messages: Message[] = [
  { role: 'user', content: 'first question', timestamp: 1 },
  {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'SECRET_THOUGHT' },
      { type: 'text', text: 'first answer' },
    ],
    timestamp: 2,
    stopReason: 'stop',
  },
  { role: 'user', content: 'second question', timestamp: 3 },
  {
    role: 'assistant',
    content: [
      {
        type: 'toolCall',
        id: 'read',
        name: 'read',
        arguments: { path: 'src/file.ts', secret: 'SECRET_ARGS' },
      },
    ],
    stopReason: 'toolUse',
  },
  { role: 'toolResult', toolCallId: 'read', toolName: 'read', content: 'SECRET_OUTPUT' },
  { role: 'assistant', content: 'second answer', timestamp: 4, stopReason: 'stop' },
  { role: 'user', content: 'current request', timestamp: 5 },
  { role: 'assistant', content: 'UNFINISHED_REPLY', timestamp: 6 },
];
test('side contexts respect reply cutoffs, exclude thinking/raw tools and trim whole earliest turns', () => {
  assert.deepEqual(sideChatContext(messages, { scope: 'quotes' }, undefined, true), {
    messages: [],
    omittedTurns: 0,
  });
  const reply = sideChatContext(messages, { scope: 'reply', replyTimestamp: 2 }, 32768, true);
  assert.deepEqual(reply.messages, [
    { role: 'user', content: 'first question' },
    { role: 'assistant', content: 'first answer' },
  ]);
  const all = sideChatContext(messages, { scope: 'all' }, 32768, true);
  const text = all.messages.map((m) => m.content).join('\n');
  assert.match(text, /second answer/);
  assert.match(text, /read.*src\/file.ts/);
  assert.doesNotMatch(text, /SECRET|UNFINISHED|current request/);
  const thoughtOnly = sideChatContext(
    [
      ...messages.slice(0, -1),
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'SECRET_ONLY' }], stopReason: 'stop' },
    ],
    { scope: 'all' },
    32768,
    false,
  );
  assert.ok(thoughtOnly.messages.some((m) => m.content === 'current request'));
  assert.doesNotMatch(JSON.stringify(thoughtOnly.messages), /SECRET_ONLY/);
  assert.equal(sideChatContext(messages, { scope: 'all' }, 120, true).omittedTurns, 1);
  assert.equal(sideChatContext(messages, { scope: 'all' }, 1, true).messages.length, 0);
  assert.throws(
    () => sideChatContext(messages, { scope: 'reply', replyTimestamp: 999 }, 32768, false),
    /当前分支/,
  );
  assert.throws(() => sideChatContext(messages, { scope: 'all' }, undefined, false), /上下文窗口/);
});
test('bridge side input rejects invalid IDs, tool roles and oversized payloads', () => {
  assert.throws(
    () =>
      validateBridgeResult('side_chat', { text: 'answer', aborted: false, usage: { tokens: NaN, cost: 0 } }),
    /费用/,
  );
  assert.throws(() => validateSideChatInput({ id: '../escape', messages: [] }), /无效/);
  assert.throws(
    () => validateSideChatInput({ id: 'ok', messages: [{ role: 'tool', content: 'run' }] }),
    /无效/,
  );
  assert.throws(() => validateSideChatInput({ id: 'ok', messages: [{ role: 'user', content: 4 }] }), /无效/);
  assert.throws(
    () =>
      validateSideChatInput({ id: 'ok', messages: [{ role: 'user', content: 'x'.repeat(4 * 1024 * 1024) }] }),
    /过长/,
  );
});
test('side streaming uses model registry auth and no tools or session-writing APIs', async () => {
  const deltas: string[] = [];
  const controller = new AbortController();
  const result = {
    content: [{ type: 'text', text: 'hello world' }],
    stopReason: 'stop',
    usage: { totalTokens: 15, cost: { total: 0.05 } },
  };
  const ctx = {
    model: { id: 'fixture', provider: 'local', api: 'openai-completions' },
    modelRegistry: {
      stream(
        model: unknown,
        context: { tools?: unknown; messages: unknown[] },
        options: { signal: AbortSignal },
      ) {
        assert.equal(model, ctx.model);
        assert.equal(context.tools, undefined);
        assert.equal(options.signal, controller.signal);
        assert.equal(context.messages.length, 1);
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: 'text_delta', delta: 'hello ' };
            yield { type: 'text_delta', delta: 'world' };
          },
          result: async () => result,
        };
      },
    },
    sessionManager: {
      appendMessage() {
        throw new Error('Side chats must not write main history');
      },
    },
  } as unknown as ExtensionContext;
  assert.deepEqual(
    await streamSideChat(
      ctx,
      { id: 'test', messages: [{ role: 'user', content: 'question' }] },
      controller.signal,
      (text) => deltas.push(text),
    ),
    { text: 'hello world', aborted: false, usage: { tokens: 15, cost: 0.05 } },
  );
  assert.deepEqual(deltas, ['hello ', 'world']);
  controller.abort();
  assert.equal(
    (
      await streamSideChat(
        ctx,
        { id: 'test', messages: [{ role: 'user', content: 'question' }] },
        controller.signal,
        () => {},
      )
    ).aborted,
    true,
  );
});
test('side history retains fifty question/answer pairs, saves atomically and follows session scratch deletion', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-side-chat-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new SideChats(directory);
  const chat: SideChat = {
    sessionId: 'session',
    omittedTurns: 0,
    messages: Array.from({ length: 120 }, (_, i) => ({
      id: String(i),
      role: i % 2 ? 'assistant' : 'user',
      content: String(i),
      timestamp: i,
    })),
  };
  await store.save(chat);
  const saved = await new SideChats(directory).read(chat.sessionId);
  assert.equal(saved.messages.length, 100);
  assert.equal(saved.messages[0].id, '20');
  await assert.rejects(store.read('../escape'), /标识/);
  await removeSessionScratch(directory, chat.sessionId);
  assert.equal((await store.read(chat.sessionId)).messages.length, 0);
  await store.save(chat);
  await store.remove(chat.sessionId);
  assert.equal((await store.read(chat.sessionId)).messages.length, 0);
});
test('quotes survive desktop restart and participate in exact draft consumption; side costs remain separate from main stats', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-quoted-draft-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new Store(directory);
  await store.load();
  const session = store.createSession();
  const quote: DraftQuote = {
    id: 'quote',
    role: 'assistant',
    turn: 1,
    messageTimestamp: 1,
    section: 'text',
    text: 'quoted text',
  };
  session.draft = 'question';
  session.draftQuotes = [quote];
  session.stats = { tokens: 100, cost: 1 };
  session.sideUsage = { tokens: 20, cost: 0.5, updatedAt: Date.now() };
  await store.save();
  const restored = new Store(directory);
  await restored.load();
  const loaded = restored.session(session.id);
  assert.deepEqual(loaded.draftQuotes, [quote]);
  assert.equal(matchesDraft(loaded, composeQuotedInput('question', [quote]), [], []), true);
  assert.equal(matchesDraft(loaded, 'question', [], []), false);
  const usage = aggregateUsage([loaded], []);
  assert.equal(usage.all.tokens, 120);
  assert.equal(usage.all.cost, 1.5);
  assert.equal(usage.all.sessions, 1);
  assert.deepEqual(usage.all.sideChat, { tokens: 20, cost: 0.5 });
  assert.deepEqual(loaded.stats, { tokens: 100, cost: 1 });
});
