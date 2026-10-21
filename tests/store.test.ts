import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../electron/store';

async function fixture(t: TestContext) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-index-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = new Store(dir);
  await store.load();
  const session = store.createSession();
  session.draft = '备份中的草稿';
  await store.save();
  return { dir, store, session, file: (name: string) => path.join(dir, name) };
}

test('damaged index restores the latest valid backup and preserves the original bytes', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.file('state.json'), '{ interrupted');
  const restored = new Store(f.dir);
  const status = await restored.load();
  assert.equal(status.writable, true);
  assert.equal(restored.session(f.session.id).draft, '备份中的草稿');
  assert.equal(status.recovery?.recoveredFrom, f.file('state.backup-1.json'));
  assert.equal(await fs.readFile(status.recovery!.corruptFile!, 'utf8'), '{ interrupted');
  assert.equal(status.recovery?.restarted, false);
});

test('an interrupted recovery with no current index still restores the existing backup', async (t) => {
  const f = await fixture(t);
  await fs.rename(f.file('state.json'), f.file('state.corrupt-interrupted.json'));
  const restored = new Store(f.dir);
  await restored.load();
  assert.equal(restored.session(f.session.id).draft, '备份中的草稿');
  assert.equal(restored.storage.recovery?.recoveredFrom, f.file('state.backup-1.json'));
  assert.equal(restored.storage.recovery?.corruptFile, undefined);
});

test('bad backups are skipped and no usable backup starts an empty index without deleting Pi history', async (t) => {
  const f = await fixture(t);
  await fs.copyFile(f.file('state.backup-1.json'), f.file('state.backup-2.json'));
  await fs.writeFile(f.file('state.backup-1.json'), 'broken backup');
  await fs.writeFile(f.file('state.json'), 'broken current');
  const restored = new Store(f.dir);
  await restored.load();
  assert.equal(restored.storage.recovery?.recoveredFrom, f.file('state.backup-2.json'));
  await fs.writeFile(f.file('state.json'), 'broken again');
  await fs.writeFile(f.file('state.backup-2.json'), JSON.stringify({ version: 9 }));
  await fs.mkdir(f.file('sessions'));
  await fs.writeFile(f.file('sessions/keep.jsonl'), 'untouched Pi history');
  const empty = new Store(f.dir);
  await empty.load();
  assert.equal(empty.storage.recovery?.restarted, true);
  assert.equal(empty.state.sessions.length, 0);
  assert.equal(await fs.readFile(f.file('sessions/keep.jsonl'), 'utf8'), 'untouched Pi history');
});

test('accent defaults to black-and-white, keeps valid choices and repairs unknown values', async (t) => {
  const f = await fixture(t);
  assert.equal(f.store.state.settings.accent, 'mono');
  for (const [accent, expected, repaired] of [
    ['blue', 'blue', undefined],
    ['orange', 'mono', 1],
  ] as const) {
    const data = { ...f.store.state, settings: { ...f.store.state.settings, accent } };
    await fs.writeFile(f.file('state.json'), JSON.stringify(data));
    const restored = new Store(f.dir);
    await restored.load();
    assert.equal(restored.state.settings.accent, expected);
    assert.equal(restored.storage.recovery?.repairedSettings, repaired);
  }
});

test('invalid rows are discarded individually while healthy drafts and settings remain', async (t) => {
  const f = await fixture(t);
  const invalid = { ...f.session, id: undefined };
  const data = {
    ...f.store.state,
    sessions: [invalid, f.session],
    settings: { ...f.store.state.settings, fontScale: 'bad' },
  };
  await fs.writeFile(f.file('state.json'), JSON.stringify(data));
  const restored = new Store(f.dir);
  await restored.load();
  assert.equal(restored.state.sessions.length, 1);
  assert.equal(restored.session(f.session.id).draft, f.session.draft);
  assert.equal(restored.storage.recovery?.discardedSessions, 1);
  assert.equal(restored.storage.recovery?.repairedSettings, 1);
  assert.equal(restored.state.settings.fontScale, 1);
  assert.equal(
    restored.storage.recovery?.recoveredFrom,
    undefined,
    'healthy current rows take priority over older backups',
  );
});

test('frequent saves keep older backups; rotation preserves three separate snapshots', async (t) => {
  const f = await fixture(t);
  const first = await fs.readFile(f.file('state.backup-1.json'), 'utf8');
  f.session.draft = '马上更新';
  await f.store.save();
  assert.equal(await fs.readFile(f.file('state.backup-1.json'), 'utf8'), first);
  for (const draft of ['十分钟后', '二十分钟后', '三十分钟后']) {
    const older = new Date(Date.now() - 11 * 60 * 1000);
    await fs.utimes(f.file('state.backup-1.json'), older, older);
    f.session.draft = draft;
    await f.store.save();
  }
  const drafts = await Promise.all(
    [1, 2, 3].map(
      async (i) => JSON.parse(await fs.readFile(f.file(`state.backup-${i}.json`), 'utf8')).sessions[0].draft,
    ),
  );
  assert.deepEqual(drafts, ['三十分钟后', '二十分钟后', '十分钟后']);
  assert.equal((await fs.readdir(f.dir)).filter((n) => /^state.backup-\d.json$/.test(n)).length, 3);
});

test('startup write failure exposes read-only storage and leaves the valid index intact', async (t) => {
  const f = await fixture(t);
  const original = await fs.readFile(f.file('state.json'), 'utf8');
  const write = fs.writeFile;
  t.mock.method(fs, 'writeFile', async (...args: Parameters<typeof fs.writeFile>) => {
    if (String(args[0]).startsWith(f.file('.write-probe-')))
      throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return write(...args);
  });
  const restored = new Store(f.dir);
  await restored.load();
  assert.equal(restored.storage.writable, false);
  assert.match(restored.storage.problem!, /无法写入本地数据目录/);
  assert.equal(restored.session(f.session.id).draft, f.session.draft);
  await assert.rejects(restored.save(), /发送与保存已暂停/);
  assert.equal(await fs.readFile(f.file('state.json'), 'utf8'), original);
});

test('disk-full errors notify the running UI and retain the last committed index', async (t) => {
  const f = await fixture(t);
  const original = await fs.readFile(f.file('state.json'), 'utf8');
  const write = fs.writeFile;
  t.mock.method(fs, 'writeFile', async (...args: Parameters<typeof fs.writeFile>) => {
    if (String(args[0]) === f.file('state.json.tmp'))
      throw Object.assign(new Error('full'), { code: 'ENOSPC' });
    return write(...args);
  });
  let notified = false;
  f.store.on('storage', (status) => {
    notified = !status.writable;
  });
  f.session.draft = '不能假装保存成功';
  await assert.rejects(f.store.save(), /ENOSPC/);
  assert.equal(notified, true);
  assert.equal(await fs.readFile(f.file('state.json'), 'utf8'), original);
});
