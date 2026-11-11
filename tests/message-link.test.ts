import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { planLocalFile, planMessageLink } from '../electron/message-link';

Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: { desktop: { platform: 'darwin', invoke: async () => {} } },
});
const { RichText } = await import('../src/components/conversation/Markdown');

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'message-link-')));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const folder = path.join(dir, '洛茜 报告');
  await fs.mkdir(folder);
  const report = path.join(folder, 'report.html');
  const script = path.join(dir, 'run.command');
  await fs.writeFile(report, '<h1>report</h1>');
  await fs.writeFile(script, 'echo unsafe');
  await fs.mkdir(path.join(dir, 'Tool.app'));
  return { dir, folder, report, script };
}

test('reply links open web pages and passive local documents, including encoded and file URLs', async (t) => {
  const { folder, report } = await fixture(t);
  assert.deepEqual(await planMessageLink('https://example.com/a b'), {
    action: 'web',
    url: 'https://example.com/a%20b',
  });
  for (const href of [report, encodeURI(report), pathToFileURL(report).href, `${encodeURI(report)}#summary`])
    assert.deepEqual(await planMessageLink(href), { action: 'open', path: report }, href);
  assert.deepEqual(await planMessageLink(folder), { action: 'open', path: folder });
});

test('reply links never launch scripts or packages and reject relative or unsupported targets', async (t) => {
  const { dir, script } = await fixture(t);
  assert.deepEqual(await planMessageLink(script), { action: 'reveal', path: script });
  assert.deepEqual(await planMessageLink(script, '/Applications/Editor.app'), {
    action: 'editor',
    path: script,
  });
  const bundle = path.join(dir, 'Tool.app');
  assert.deepEqual(await planMessageLink(bundle, '/Applications/Editor.app'), {
    action: 'reveal',
    path: bundle,
  });
  const disguised = path.join(dir, 'report.html');
  try {
    await fs.symlink(script, disguised);
  } catch (error) {
    if (process.platform !== 'win32') throw error;
  }
  if (process.platform !== 'win32')
    assert.deepEqual(await planMessageLink(disguised), { action: 'reveal', path: disguised });
  await assert.rejects(planMessageLink(path.join(dir, 'missing.html')), /找不到文件/);
  for (const href of ['report.html', './report.html', 'javascript:alert(1)', 'mailto:a@example.com'])
    await assert.rejects(planMessageLink(href), /只能打开网页链接或本地文件的完整路径/, href);
});

test('rendered replies keep local link targets but still drop unsafe schemes', () => {
  const html = renderToStaticMarkup(
    React.createElement(RichText, {
      text: [
        '[可视化报告](</Users/yeyu/洛茜 报告/report.html>)',
        '[结论](file:///Users/yeyu/findings.md)',
        '[危险](javascript:alert(1))',
      ].join('\n\n'),
    }),
  );
  assert.match(html, /title="\/Users\/yeyu\/洛茜 报告\/report.html"/);
  assert.match(html, /title="file:\/\/\/Users\/yeyu\/findings.md"/);
  assert.doesNotMatch(html, /javascript:/);
});

test('project files opened from the file menu use the same rules without decoding their names', async (t) => {
  const { dir, folder, report, script } = await fixture(t);
  const literal = path.join(dir, 'a%20b.md');
  await fs.writeFile(literal, '# literal');
  assert.deepEqual(await planLocalFile(literal), { action: 'open', path: literal });
  assert.deepEqual(await planLocalFile(report), { action: 'open', path: report });
  assert.deepEqual(await planLocalFile(folder), { action: 'open', path: folder });
  assert.deepEqual(await planLocalFile(script), { action: 'reveal', path: script });
  assert.deepEqual(await planLocalFile(script, '/editor'), { action: 'editor', path: script });
  const bundle = path.join(dir, 'Tool.app');
  assert.deepEqual(await planLocalFile(bundle), { action: 'reveal', path: bundle });
});
