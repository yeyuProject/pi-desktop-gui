import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveHistory, HistoryDeriver } from '../src/lib/history-derive';
import type { Message } from '../shared/types';
import { ConversationDeriver } from '../src/lib/conversation-derive';
import { conversationTurns, groupConversation, turnThinking } from '../src/lib/conversation-layout';
import { TranscriptIndex } from '../src/lib/transcript-index';
test('rewritten prefixes invalidate derived history and indexes', () => {
  assert.deepEqual(turnThinking([]), []);
  const history = new HistoryDeriver();
  const index = new TranscriptIndex();
  const messages: Message[] = [
    { role: 'user', content: 'old' },
    { role: 'assistant', content: 'done' },
    { role: 'user', content: 'last' },
    { role: 'assistant', content: 'tail' },
  ];
  history.derive(messages);
  index.derive(messages);
  const changed = [{ ...messages[0], content: 'rewritten' }, ...messages.slice(1)];
  assert.deepEqual(history.derive(changed), deriveHistory(changed));
  assert.deepEqual(index.derive(changed).prompts, ['rewritten', 'last']);
  index.derive([{ role: 'assistant', content: 'first', timestamp: 1 }]);
  const source = index.derive([{ role: 'assistant', content: 'replacement', timestamp: 2 }]).sources;
  assert.ok(source.has('assistant:2'));
  assert.ok(!source.has('assistant:1'));
});
test('cached grouping and turn summaries equal complete derivation through streaming and edits', () => {
  const cache = new ConversationDeriver();
  const toolFor = (message: Message) => ({
    id: message.toolCallId ?? '',
    name: 'read',
    args: {},
    status: 'done' as const,
    output: '',
    startedAt: 0,
  });
  let messages: Message[] = [];
  for (let turn = 0; turn < 20; turn++) {
    for (const message of [
      { role: 'user', content: 'question' },
      { role: 'assistant', content: 'answer' },
    ]) {
      messages = [...messages, message];
      const result = cache.derive(messages, [], toolFor, [], true);
      assert.deepEqual(result.items, groupConversation(messages, toolFor, []));
      assert.deepEqual(result.turns, conversationTurns(messages, toolFor, true));
    }
  }
});
test('cached complete turns equal full history through streaming, recovery, navigation and hidden tools', () => {
  const cache = new HistoryDeriver();
  let messages: Message[] = [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'done', stopReason: 'stop' },
  ];
  for (const message of [
    { role: 'custom', content: '', customType: 'desktop-goal-start', display: false },
    { role: 'user', content: 'second' },
    { role: 'assistant', content: '', stopReason: 'error', errorMessage: 'failed' },
    { role: 'assistant', content: 'recovered', stopReason: 'stop' },
    { role: 'user', content: 'third' },
  ]) {
    messages = [...messages, message];
    assert.deepEqual(cache.derive(messages), deriveHistory(messages));
  }
  for (let i = 0; i < 50; i++) {
    messages = [...messages.slice(0, -1), { ...messages.at(-1)!, content: 'stream' + i }];
    assert.deepEqual(cache.derive(messages), deriveHistory(messages));
  }
  assert.deepEqual(cache.derive(messages.slice(0, 2)), deriveHistory(messages.slice(0, 2)));
});
