import test from 'node:test';
import assert from 'node:assert/strict';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import { streamingMarkdown, type MarkdownParts } from '../src/lib/streaming-markdown';
const parse = (text: string) =>
  fromMarkdown(text, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }).children;
const clean = (value: unknown) =>
  JSON.parse(JSON.stringify(value, (key, item) => (key === 'position' ? undefined : item)));

test('incremental Markdown preserves root syntax through lists, tables, fences and setext headings', () => {
  const prefix = 'A **formatted** paragraph with [a link](https://example.invalid).\n\n'.repeat(160);
  let text = prefix,
    previous: MarkdownParts | undefined;
  for (const addition of [
    '- first\n',
    '\n- second\n',
    '\n\nHeading\n',
    '---\n\n',
    '| a | b |\n',
    '| - | - |\n',
    '| 1 | 2 |\n\n',
    '```js\n',
    'const a = 1;\n',
    '```\n\nDone.',
  ]) {
    text += addition;
    const result = streamingMarkdown(text, previous);
    assert.equal(result.blocks.join('') + result.tail, text);
    assert.deepEqual(clean([...result.blocks.flatMap(parse), ...parse(result.tail)]), clean(parse(text)));
    if (previous?.blocks.length) assert.equal(result.blocks[0], previous.blocks[0]);
    previous = result;
  }
  assert.ok(previous!.blocks.length > 0);
  assert.ok(previous!.tail.length < 8192);
});

test('reference definitions and rewritten content cannot reuse stale Markdown blocks', () => {
  const before = 'Paragraph.\n\n'.repeat(1000);
  const split = streamingMarkdown(before);
  assert.ok(split.blocks.length);
  for (const suffix of [
    '\n[reference]\n\n[reference]: https://example.invalid',
    '\n[^note]\n\n[^note]: Footnote',
  ]) {
    const result = streamingMarkdown(before + suffix, split);
    assert.equal(result.blocks.length, 0);
    assert.equal(result.tail, before + suffix);
  }
  assert.deepEqual(streamingMarkdown('Replaced', split), streamingMarkdown('Replaced'));
});

test('a very long unfinished block streams as text and preserves its complete source', () => {
  const text = '```txt\n' + 'large block\n'.repeat(2500);
  const first = streamingMarkdown(text);
  const second = streamingMarkdown(text + 'next token', first);
  assert.equal(second.plain, true);
  assert.equal(second.blocks.join('') + second.tail, text + 'next token');
});
