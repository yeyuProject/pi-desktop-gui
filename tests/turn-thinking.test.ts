import test from 'node:test';
import assert from 'node:assert/strict';
import { turnThinking } from '../src/lib/conversation-layout';
import type { Message } from '../shared/types';

test('thinking spans tools and retries, retains block offsets and separates user turns without mutation', () => {
  const messages: Message[] = [
    { role: 'user', content: 'one' },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '先分析' },
        { type: 'text', text: '正文' },
        { type: 'thinking', thinking: '再检查' },
      ],
    },
    { role: 'toolResult', content: 'result' },
    { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'retry' },
    { role: 'assistant', content: [{ type: 'thinking', thinking: '最后验证' }] },
    { role: 'assistant', content: 'final' },
    { role: 'user', content: 'two' },
    { role: 'assistant', content: [{ type: 'thinking', thinking: '第二轮' }] },
  ];
  const before = JSON.stringify(messages);
  const groups = turnThinking(messages);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].text, '先分析\n\n再检查\n\n最后验证');
  assert.deepEqual(groups[0].parts, [
    { index: 1, block: 0, offset: 0 },
    { index: 1, block: 1, offset: 5 },
    { index: 4, block: 0, offset: 10 },
  ]);
  assert.equal(groups[0].end, 5);
  assert.equal(groups[1].owner, 7);
  assert.equal(turnThinking(messages, 4)[0].owner, 1);
  assert.equal(turnThinking(messages, 6).length, 1);
  assert.equal(JSON.stringify(messages), before);
});

test('pagination retains the full current turn and search offsets for every original thinking block', async () => {
  const { SessionSearch } = await import('../src/lib/session-search');
  const messages: Message[] = [
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'orphan' }] },
    { role: 'user', content: 'start' },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'needle one' },
        { type: 'thinking', thinking: 'needle two' },
      ],
    },
    ...Array.from({ length: 85 }, (): Message => ({ role: 'toolResult', content: 'result' })),
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'needle three' }] },
  ];
  const groups = turnThinking(messages, 80);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].owner, 2);
  const matches = new SessionSearch().search(messages, [], 'needle');
  for (let index = 0; index < matches.length; index++) {
    const match = matches.at(index)!;
    const part = groups[0].parts.find((p) => p.index === match.messageIndex && p.block === match.blockIndex)!;
    assert.ok(part);
    assert.equal(groups[0].text.slice(part.offset + match.start, part.offset + match.start + 6), 'needle');
  }
  assert.equal(
    turnThinking([{ role: 'assistant', content: [{ type: 'thinking', thinking: '' }] }]).length,
    0,
  );
  assert.equal(turnThinking(messages, messages.length).length, 0);
});
