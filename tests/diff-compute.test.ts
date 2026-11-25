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
  // 整段改写 1000 行本机约 150 ms，远低于工作线程 5 秒的上限；3000 行约 1.4 s，CI 繁忙时会超时。
  const lines = 1000;
  const before = Array.from({ length: lines }, (_, i) => `original_${i} = ${i};`).join('\n');
  const after = Array.from({ length: lines }, (_, i) => `replacement_${i} = ${i + 1};`).join('\n');
  let ticks = 0;
  const timer = setInterval(() => ticks++, 5);
  try {
    const patch = await computeDiff('rewrite.ts', before, after);
    assert.ok(ticks > 1, 'the event loop must remain available during the rewrite');
    assert.match(patch, new RegExp(`-original_${lines - 1} = ${lines - 1};`));
    assert.match(patch, new RegExp(`\\+replacement_${lines - 1} = ${lines};`));
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
