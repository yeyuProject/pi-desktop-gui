import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { listPiSessions, searchSessionContents } from '../electron/history';
import { readSessionFile } from '../electron/store';
import { pathKey } from '../electron/platform';
import type { Session } from '../shared/types';

async function sandbox() {
  const root = path.resolve('work/tests');
  await fs.mkdir(root, { recursive: true });
  return fs.mkdtemp(path.join(root, 'history-'));
}

test('native transcript preserves visible extension messages and branch summaries', async () => {
  const dir = await sandbox(),
    file = path.join(dir, 'native.jsonl');
  const timestamp = '2026-10-19T00:00:00.000Z';
  await fs.writeFile(
    file,
    [
      { type: 'session', cwd: dir },
      { type: 'message', id: 'a', parentId: null, message: { role: 'user', content: 'question' } },
      {
        type: 'custom_message',
        id: 'b',
        parentId: 'a',
        timestamp,
        customType: 'extension-status',
        content: 'extension output',
        display: true,
      },
      { type: 'branch_summary', id: 'c', parentId: 'b', timestamp, fromId: 'old', summary: 'branch context' },
      { type: 'message', id: 'd', parentId: 'c', message: { role: 'assistant', content: 'final reply' } },
    ]
      .map((record) => JSON.stringify(record))
      .join('\n') + '\n',
  );
  const { messages } = await readSessionFile(file);
  assert.deepEqual(
    messages.map((message) => message.role),
    ['user', 'custom', 'branchSummary', 'assistant'],
  );
  assert.equal(messages[1].content, 'extension output');
  assert.equal(messages[1].timestamp, Date.parse(timestamp));
  assert.equal(messages[2].summary, 'branch context');
  assert.equal(messages[3].content, 'final reply');
});

test('content search matches decoded Windows paths and quoted text', async () => {
  const dir = await sandbox();
  const file = path.join(dir, 'search.jsonl');
  const text = 'Open C:\\sample\\report.txt and find "quoted value"';
  await fs.writeFile(
    file,
    JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n',
  );
  const session: Session = {
    id: 'search-session',
    title: 'Search',
    file,
    draft: '',
    attachments: [],
    updatedAt: 0,
    lastStatus: 'idle',
  };
  for (const query of ['c:\\sample\\report.txt', '"quoted value"']) {
    const matches = await searchSessionContents([session], query);
    assert.equal(matches.length, 1, query);
    assert.equal(matches[0].sessionId, session.id);
    assert.ok(matches[0].snippet.toLowerCase().includes(query));
  }
  assert.deepEqual(await searchSessionContents([session], 'not present'), []);
});

test('Pi history keeps complete image records and sessions without a text preview', async () => {
  const dir = await sandbox();
  // History reads image data as opaque text; exceed the 64 KiB preview budget without a docs asset.
  const data = Buffer.alloc(64 * 1024, 1).toString('base64');
  assert.ok(data.length > 64 * 1024);
  const image = { type: 'image', mimeType: 'image/png', data };
  for (const [name, content] of [
    ['with-text', [{ type: 'text', text: 'Find this screenshot' }, image]],
    ['image-only', [image]],
  ] as const) {
    await fs.writeFile(
      path.join(dir, name + '.jsonl'),
      [
        { type: 'session', version: 3, id: name, cwd: dir },
        { type: 'message', message: { role: 'user', content } },
      ]
        .map((entry) => JSON.stringify(entry))
        .join('\n') + '\n',
    );
  }
  await fs.writeFile(
    path.join(dir, 'empty.jsonl'),
    JSON.stringify({ type: 'session', version: 3, id: 'empty', cwd: dir }) + '\n',
  );
  const sessions = await listPiSessions([dir], new Set());
  assert.equal(sessions.length, 2);
  assert.equal(
    sessions.find((session) => path.basename(session.file) === 'with-text.jsonl')?.preview,
    'Find this screenshot',
  );
  assert.equal(sessions.find((session) => path.basename(session.file) === 'image-only.jsonl')?.preview, '');
  const known = new Set(sessions.map((session) => pathKey(session.file)));
  assert.deepEqual(await listPiSessions([dir], known), []);
});

test('cached transcripts are isolated between readers and invalidated after append and replacement', async () => {
  const dir = await sandbox(),
    file = path.join(dir, 'cached.jsonl');
  const record = (id: string, content: string, parentId: string | null = null) =>
    JSON.stringify({ type: 'message', id, parentId, message: { role: 'user', content } }) + '\n';
  const header = JSON.stringify({ type: 'session', cwd: dir }) + '\n';
  await fs.writeFile(file, header + record('a', 'first'));
  const [first, concurrent] = await Promise.all([readSessionFile(file), readSessionFile(file)]);
  first.messages[0].content = 'mutated by live stream';
  assert.equal(concurrent.messages[0].content, 'first');
  assert.equal((await readSessionFile(file)).messages[0].content, 'first');
  await fs.appendFile(file, record('b', 'appended', 'a'));
  assert.equal((await readSessionFile(file)).messages.at(-1)?.content, 'appended');
  await fs.writeFile(file + '.new', header + record('a', 'other'));
  await fs.rename(file + '.new', file);
  assert.equal((await readSessionFile(file)).messages[0].content, 'other');
});

test('search cache refreshes edited contents and cancelled searches do no more work', async () => {
  const dir = await sandbox(),
    file = path.join(dir, 'search-cache.jsonl');
  const session = { id: 'cache', file } as Session;
  const record = (text: string) =>
    JSON.stringify({ type: 'message', message: { role: 'user', content: text } });
  await fs.writeFile(file, record('original needle'));
  assert.equal((await searchSessionContents([session], 'needle')).length, 1);
  await fs.writeFile(file, record('replacement text'));
  assert.equal((await searchSessionContents([session], 'needle')).length, 0);
  assert.equal((await searchSessionContents([session], 'replacement')).length, 1);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(searchSessionContents([session], 'needle', controller.signal), { name: 'AbortError' });
});
