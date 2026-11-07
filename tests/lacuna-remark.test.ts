import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { lacunaQuestion, type LacunaMatch } from '../shared/lacuna';
import { remarkLacuna } from '../src/lib/lacuna-remark';

/** 在 source 里找到 text 第 nth 次出现的位置，造一个认词结果。 */
function at(source: string, text: string, ids = ['vae'], kind: LacunaMatch['kind'] = 'term', nth = 0) {
  let start = -1;
  for (let i = 0; i <= nth; i++) start = source.indexOf(text, start + 1);
  assert.ok(start >= 0, `${source} 里没有第 ${nth + 1} 个「${text}」`);
  return { start, end: start + text.length, text, ids, kind };
}

function render(source: string, matches: LacunaMatch[]) {
  const annotation = { matches, terms: {} };
  return renderToStaticMarkup(
    createElement(
      Markdown,
      { remarkPlugins: [remarkGfm, [remarkLacuna, { annotation, source }]], skipHtml: true },
      source,
    ),
  );
}

test('认出的词换成带 data-lacuna-ids 的 span，其余文字不变', () => {
  const source = 'VITS 的主体是 **VAE**，还有 VAE 和流。';
  assert.equal(
    render(source, [at(source, 'VAE'), at(source, 'VAE', ['vae', 'vae-2'], 'term', 1)]),
    '<p>VITS 的主体是 <strong><span class="lacuna-term" data-lacuna-ids="vae">VAE</span></strong>，还有 ' +
      '<span class="lacuna-term" data-lacuna-ids="vae vae-2">VAE</span> 和流。</p>',
  );
});

test('代码和链接里的词不标', () => {
  const source = 'VAE 和 `VAE` 和 [VAE](https://example.com)';
  const html = render(source, [
    at(source, 'VAE'),
    at(source, 'VAE', ['vae'], 'term', 1),
    at(source, 'VAE', ['vae'], 'term', 2),
  ]);
  assert.equal(html.match(/lacuna-term/g)?.length, 1);
  assert.match(html, /<code>VAE<\/code>/);
});

test('[[id|原文]] 显示成原文', () => {
  const source = '见 [[vae|变分自编码器]]。';
  const start = source.indexOf('[[');
  const html = render(source, [
    { start, end: source.indexOf(']]') + 2, text: '变分自编码器', ids: ['vae'], kind: 'link' },
  ]);
  assert.equal(html, '<p>见 <span class="lacuna-term" data-lacuna-ids="vae">变分自编码器</span>。</p>');
});

test('文字节点和原文对不上时（比如有转义字符）宁可不标，也不标错位置', () => {
  const source = 'a \\* VAE';
  assert.equal(render(source, [at(source, 'VAE')]), '<p>a * VAE</p>');
});

test('“这是什么意思”的问题带上在哪个解释里问的', () => {
  assert.equal(lacunaQuestion('  变分\n推断 '), '「变分 推断」是什么意思？');
  assert.equal(
    lacunaQuestion('潜变量', { id: 'vae', title: '变分自编码器' }),
    '「潜变量」是什么意思？（在「变分自编码器」的解释里问的，节点 id：vae）',
  );
});
