import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionSearch } from '../src/lib/session-search';
import type { Message, ToolActivity } from '../shared/types';

test('native skill bodies, user arguments and referenced files have independent search offsets', () => {
  const body = '# Instructions\nneedle before\n' + 'a line\n'.repeat(300) + 'needle after';
  const content = `<skill name="review" location="/fixture/SKILL.md">\n${body}\n</skill>\n\nuser needle\n\n<project_file path="needle.ts">\nfile needle\n</project_file>`;
  const messages: Message[] = [{ role: 'user', content }];
  const search = new SessionSearch();
  const matches = search.search(messages, [], 'needle');
  assert.equal(matches.length, 5);
  assert.deepEqual(
    Array.from({ length: matches.length }, (_, i) => matches.at(i)!.section),
    ['skill', 'skill', 'text', 'attachment', 'attachment'],
  );
  const hit = matches.at(1)!;
  assert.equal(hit.start, body.lastIndexOf('needle'));
  assert.equal(hit.occurrence, 1);
  assert.equal(hit.text, body);
  assert.equal(hit.messageIndex, 0);
  assert.equal(matches.at(2)!.start, 'user '.length);
  assert.equal(search.search(messages, [], '/fixture/SKILL.md').length, 0);
  assert.equal(messages[0].content, content);
});

test('dense search keeps every occurrence accessible without eagerly creating match objects', () => {
  const search = new SessionSearch();
  const messages: Message[] = Array.from({ length: 1000 }, () => ({
    role: 'assistant',
    content: 'const x = 1;\n'.repeat(200),
  }));
  const result = search.search(messages, [], ' const ');
  assert.equal(result.length, 200_000);
  assert.equal(result.at(0)!.messageIndex, 0);
  assert.equal(result.at(199)!.occurrence, 199);
  assert.equal(result.at(200)!.messageIndex, 1);
  const last = result.at(199_999)!;
  assert.equal(last.messageIndex, 999);
  assert.equal(last.start, 'const x = 1;\n'.length * 199);
  assert.ok(last.snippet.includes('const'));
  assert.equal(result.at(-1), undefined);
  assert.equal(result.at(result.length), undefined);
  assert.equal(result.at(NaN), undefined);
});

test('streaming reuses static search text and the active hit, while replacement and query changes stay fresh', () => {
  const search = new SessionSearch();
  let reads = 0;
  const settled: Message = {
    role: 'user',
    content: [
      {
        type: 'text',
        get text() {
          reads++;
          return 'fixed needle text';
        },
      },
    ],
  };
  const streaming: Message = { role: 'assistant', content: 'no match' };
  const before = search.search([settled, streaming], [], 'needle');
  const hit = before.at(0),
    initialReads = reads;
  const updated: Message = { ...streaming, content: 'new needle' };
  const after = search.search([settled, updated], [], 'needle');
  assert.equal(after.length, 2);
  assert.equal(reads, initialReads);
  assert.equal(after.at(0), hit);
  assert.equal(after.at(1)!.messageIndex, 1);
  assert.equal(search.search([updated, settled], [], 'needle').at(0)!.messageIndex, 0);
  assert.equal(search.search([{ ...settled, content: 'rewritten' }], [], 'needle').length, 0);
  assert.equal(search.search([updated], [], 'new').at(0)!.start, 0);
  assert.equal(before.at(0)!.query, 'needle', 'old results retain their own offsets and query');
  assert.equal(search.search([updated], [], ' ').length, 0);
});

test('late tool results, changed arguments and replaced live outputs invalidate only their search parts', () => {
  const search = new SessionSearch();
  const call: Message = {
    role: 'assistant',
    content: [{ type: 'toolCall', id: 't', name: 'read', arguments: { path: 'before.ts' } }],
  };
  const result: Message = { role: 'toolResult', toolCallId: 't', content: 'done' };
  assert.equal(search.search([call, result], [], 'before').length, 1);
  const changed: Message = {
    ...call,
    content: [{ type: 'toolCall', id: 't', name: 'read', arguments: { path: 'after.ts' } }],
  };
  assert.equal(search.search([changed, result], [], 'before').length, 0);
  assert.equal(search.search([changed, result], [], 'after').length, 1);
  const tool: ToolActivity = {
    id: 't',
    name: 'read',
    args: { path: 'live.ts' },
    output: 'pending needle',
    status: 'running',
    startedAt: 0,
  };
  assert.equal(search.search([changed], [tool], 'needle').at(0)!.messageIndex, undefined);
  assert.equal(search.search([changed], [{ ...tool, output: 'finished' }], 'needle').length, 0);
  assert.equal(search.search([changed, result], [tool], 'live').at(0)!.messageIndex, 1);
  assert.equal(search.search([changed, result], [{ ...tool, patch: '+needle' }], 'needle').length, 1);
});
