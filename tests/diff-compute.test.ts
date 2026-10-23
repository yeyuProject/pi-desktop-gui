import test from 'node:test';
import assert from 'node:assert/strict';
import { createTwoFilesPatch } from 'diff';
import { computeDiff } from '../electron/diff-compute';

test('background diff preserves Unicode, filenames, context and no-newline markers', async () => {
  const before = '这是原内容\nsecond line',
    after = '这是新内容\nsecond line';
  assert.equal(
    await computeDiff('中文 文件.ts', before, after),
    createTwoFilesPatch('中文 文件.ts', '中文 文件.ts', before, after, '原内容', '当前内容', { context: 4 }),
  );
});

test('large rewrites let the calling event loop continue while computing the exact diff', async () => {
  const before = Array.from({ length: 3000 }, (_, i) => `original_${i} = ${i};`).join('\n');
  const after = Array.from({ length: 3000 }, (_, i) => `replacement_${i} = ${i + 1};`).join('\n');
  let ticks = 0;
  const timer = setInterval(() => ticks++, 5);
  try {
    const patch = await computeDiff('rewrite.ts', before, after);
    assert.ok(ticks > 1, 'the event loop must remain available during the rewrite');
    assert.match(patch, /-original_2999 = 2999;/);
    assert.match(patch, /\+replacement_2999 = 3000;/);
  } finally {
    clearInterval(timer);
  }
});

test('cancelled previews stop promptly and do not affect the following request', async () => {
  const controller = new AbortController();
  const before = 'before\n'.repeat(10000),
    after = 'after\n'.repeat(10000);
  const cancelled = computeDiff('old.ts', before, after, controller.signal);
  const rejected = assert.rejects(cancelled, { name: 'AbortError' });
  controller.abort();
  await rejected;
  assert.match(await computeDiff('new.ts', 'one\n', 'two\n'), /\+two/);
  assert.throws(() => computeDiff('old.ts', before, after, controller.signal), { name: 'AbortError' });
});

test('oversized patches keep the existing explicit truncation notice', async () => {
  const patch = await computeDiff('added.txt', '', 'line of generated content\n'.repeat(15000));
  assert.match(patch, /差异已截断，请在编辑器中查看完整内容$/);
  assert.ok(patch.length < 257 * 1024);
});
