import test from 'node:test';
import assert from 'node:assert/strict';
import { messageWindow, windowConversation } from '../src/lib/message-window';
import { turnThinking, type ConversationItem } from '../src/lib/conversation-layout';

test('history jumps include the target within at most 80 messages, including edges and truncation', () => {
  for (const total of [0, 1, 79, 80, 81, 200, 5000]) {
    for (const index of [-1, 0, 79, 80, 160, 2499, 4999, 5000]) {
      const range = messageWindow(total, index);
      assert.ok(range.start >= 0 && range.end <= total && range.end - range.start <= 80);
      if (total) {
        const target = Math.max(0, Math.min(index, total - 1));
        assert.ok(range.start <= target && range.end > target);
      }
    }
  }
  assert.deepEqual(messageWindow(5000, 0), { start: 0, end: 80 });
  assert.deepEqual(messageWindow(5000, 4999), { start: 4920, end: 5000 });
});

test('groups crossing a history window cannot mount hidden messages or hide the target', () => {
  const items: ConversationItem[] = [
    { kind: 'message', index: 0 },
    { kind: 'group', id: 'tools', indices: Array.from({ length: 199 }, (_, i) => i + 1) },
    { kind: 'errors', id: 'errors', indices: [200, 201, 202] },
  ];
  const original = structuredClone(items);
  const visible = windowConversation(items, 80, 160);
  assert.deepEqual(visible, [{ ...items[1], visibleIndices: Array.from({ length: 80 }, (_, i) => i + 80) }]);
  assert.deepEqual(windowConversation(items, 201, 202), [{ ...items[2], visibleIndices: [201] }]);
  assert.deepEqual(items, original);
});

test('an earlier window retains its thinking prefix without later thinking leaking into it', () => {
  const messages = [
    { role: 'user', content: 'task' },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'before' }] },
    { role: 'toolResult', content: 'result' },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'after' }] },
  ];
  const groups = turnThinking(messages, 2, 3);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].owner, 1);
  assert.equal(groups[0].text, 'before');
  assert.equal(groups[0].end, 2);
});
