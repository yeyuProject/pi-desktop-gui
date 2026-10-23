import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationTurns, groupConversation, hideRecoveredErrors } from '../src/lib/conversation-layout';
import { SessionSearch } from '../src/lib/session-search';
import type { Message, ToolActivity } from '../shared/types';

const failure = (errorMessage = 'Connection error.', content: Message['content'] = []): Message => ({
  role: 'assistant',
  content,
  stopReason: 'error',
  errorMessage,
});
const toolFor = (message: Message): ToolActivity => ({
  id: String(message.toolCallId),
  name: 'read',
  args: {},
  output: '',
  status: message.isError ? 'error' : 'done',
  startedAt: 0,
});
const group = (messages: Message[]) => groupConversation(hideRecoveredErrors(messages), toolFor, []);

test('unresolved repeated or mixed failures form one display group without rewriting history', () => {
  for (const errors of [
    ['Connection error.', 'Connection error.', 'Connection error.'],
    ['Request timed out.', 'Connection error.', 'Request timed out.'],
  ]) {
    const messages: Message[] = [
      { role: 'user', content: 'Try this' },
      ...errors.map((text) => failure(text)),
    ];
    const before = structuredClone(messages);
    const items = group(messages);
    assert.equal(items.length, 2, 'failed attempts must not each create a full visible reply');
    assert.equal(items[1].kind, 'errors');
    assert.deepEqual('indices' in items[1] && items[1].indices, [1, 2, 3]);
    assert.equal(conversationTurns(messages, toolFor)[0].failed, true);
    assert.equal(
      new SessionSearch().search(messages, [], errors[0]).length,
      errors.filter((v) => v === errors[0]).length,
    );
    assert.deepEqual(messages, before);
  }
});

test('only blank text errors group; partial replies, thinking, tools and images remain separate', () => {
  const contentBoundaries: Message[] = [
    failure('Partial failure', 'Partial response'),
    failure('Thinking failure', [{ type: 'thinking', thinking: 'Working through it' }]),
    failure('Tool failure', [{ type: 'toolCall', id: 'read-1', name: 'read' }]),
    failure('Image failure', [{ type: 'image', data: 'fixture', mimeType: 'image/png' }]),
    failure('Unknown content', [{ type: 'future-content', value: 'preserve' }]),
    { role: 'toolResult', content: 'Tool failed', toolCallId: 'read-1', isError: true },
    { role: 'custom', content: 'Extension notice' },
    { role: 'user', content: 'Another turn' },
    { role: 'assistant', content: [], stopReason: 'aborted' },
    { role: 'assistant', content: [] },
    { role: 'assistant', content: [], stopReason: 'error' },
  ];
  for (const boundary of contentBoundaries) {
    const messages = [failure(), failure('Connection error.', ''), boundary, failure(), failure()];
    const groups = group(messages).filter((item) => item.kind === 'errors');
    assert.equal(groups.length, 2, `must not cross ${JSON.stringify(boundary)}`);
    assert.deepEqual(
      groups.map((item) => 'indices' in item && item.indices),
      [
        [0, 1],
        [3, 4],
      ],
    );
  }
  assert.equal(
    group([failure(), failure('Connection error.', [{ type: 'text', text: '' }])])[0].kind,
    'errors',
  );
  assert.equal(group([failure()])[0].kind, 'message');
});

test('successful recovery removes the group while prior turns and cancellation retain their failures', () => {
  const previous = [failure('Previous failure'), failure('Previous failure')];
  const current = [failure(), failure()];
  const messages: Message[] = [
    { role: 'user', content: 'Earlier turn' },
    ...previous,
    { role: 'user', content: 'Current turn' },
    ...current,
  ];
  assert.equal(group(messages).filter((item) => item.kind === 'errors').length, 2);
  const cancelled = [...messages, { role: 'assistant', content: [], stopReason: 'aborted' }];
  assert.equal(group(cancelled).filter((item) => item.kind === 'errors').length, 2);
  const recovered = [...messages, { role: 'assistant', content: 'Recovered', stopReason: 'stop' }];
  const display = hideRecoveredErrors(recovered);
  assert.equal(group(recovered).filter((item) => item.kind === 'errors').length, 1);
  for (const message of previous) assert.ok(display.includes(message));
  for (const message of current) assert.ok(!display.includes(message));
  assert.deepEqual(
    conversationTurns(display, toolFor).map((turn) => turn.failed),
    [true, false],
  );
});

// Render the real group with message children. Full chat interactions are covered by test-retry-ui.mjs.
const React = await import('react');
const { renderToStaticMarkup } = await import('react-dom/server');
const { RetryErrorGroup } = await import('../src/components/conversation/RetryErrorGroup');
function markup(errors: string[], activeIndex?: number, start = 0, end = errors.length) {
  const messages = errors.map((error, index) => ({ ...failure(error), timestamp: index + 1 }));
  return renderToStaticMarkup(
    React.createElement(RetryErrorGroup, {
      messages,
      indices: messages.map((_, index) => index),
      visibleIndices: messages.map((_, index) => index).slice(start, end),
      activeIndex,
      renderMessage: (index) =>
        React.createElement('p', { key: index, 'data-message-index': index }, errors[index]),
    }),
  );
}

test('the collapsed card renders only the latest child and the total failure count', () => {
  const identical = markup(['Connection error.', 'Connection error.', 'Connection error.']);
  assert.equal(identical.match(/data-message-index=/g)?.length, 1);
  assert.match(identical, /相同错误 ×3/);
  assert.match(identical, /Connection error\./);
  assert.doesNotMatch(identical, /<details[^>]+open/);
  const mixed = markup(['Request timed out.', 'Connection error.', 'Latest failure.']);
  assert.equal(mixed.match(/data-message-index=/g)?.length, 1);
  assert.match(mixed, /请求失败记录 · 3 次/);
  assert.match(mixed, /Latest failure\./);
  assert.doesNotMatch(mixed, /Request timed out\.|Connection error\./);
});

test('searching a prior failure reveals its original child without duplicating the latest', () => {
  const expanded = markup(['Request timed out.', 'Connection error.', 'Latest failure.'], 0);
  assert.equal(expanded.match(/data-message-index=/g)?.length, 3);
  assert.match(expanded, /<details[^>]+open/);
  assert.match(expanded, /Request timed out\./);
  assert.match(expanded, /Connection error\./);
  assert.equal(expanded.match(/Latest failure\./g)?.length, 1);
  assert.equal(markup(['Previous', 'Latest'], 1).match(/data-message-index=/g)?.length, 1);
});

test('a paged retry group preserves the full count while mounting only the selected page', () => {
  const html = markup(
    Array.from({ length: 90 }, (_, i) => `Failure ${i}`),
    12,
    10,
    90,
  );
  assert.match(html, /请求失败记录 · 90 次/);
  assert.match(html, /本页 80 条/);
  assert.equal(html.match(/data-message-index=/g)?.length, 80);
  assert.doesNotMatch(html, /data-message-index="0"/);
  assert.match(html, /data-message-index="89"/);
});
