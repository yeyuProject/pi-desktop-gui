import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../electron/store';

const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
test('typing is coalesced, flush saves immediately, and images survive a restart without rewriting', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-draft-storage-'));
  const store = new Store(dir);
  t.after(async () => {
    await store.flush();
    await fs.rm(dir, { recursive: true, force: true });
  });
  await store.load();
  const session = store.createSession();
  session.images = [{ id: 'picture', name: 'picture.png', mimeType: 'image/png', data: png }];
  let stateWrites = 0,
    imageWrites = 0;
  const write = fs.writeFile;
  t.mock.method(fs, 'writeFile', async (...args: Parameters<typeof fs.writeFile>) => {
    if (String(args[0]) === path.join(dir, 'state.json.tmp')) stateWrites++;
    if (String(args[0]).endsWith('.bin.tmp')) imageWrites++;
    return write(...args);
  });
  const acknowledgments = [];
  for (const text of ['a', 'ab', 'abc']) {
    session.draft = text;
    acknowledgments.push(store.scheduleSave());
  }
  assert.equal(stateWrites, 0);
  await store.flush();
  await Promise.all(acknowledgments);
  assert.equal(stateWrites, 1);
  assert.equal(imageWrites, 1);
  const raw = JSON.parse(await fs.readFile(path.join(dir, 'state.json'), 'utf8'));
  assert.equal(raw.version, 2);
  assert.equal(raw.sessions[0].images[0].data, undefined);
  assert.match(raw.sessions[0].images[0].file, /^[a-f0-9]{64}\.bin$/);
  const restarted = new Store(dir);
  await restarted.load();
  assert.equal(restarted.session(session.id).draft, 'abc');
  assert.deepEqual(restarted.session(session.id).images, session.images);
  assert.equal(restarted.session(session.id).images?.[0].data, undefined);
  assert.equal((await restarted.draftImages(session.id))[0].data, png);
  session.draft = 'next';
  await store.scheduleSave();
  assert.equal(stateWrites, 2);
  assert.equal(imageWrites, 1);
});

test('legacy inline images migrate only after a successful save and backup remains readable', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-draft-upgrade-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const seed = new Store(dir);
  const session = seed.createSession();
  session.images = [{ id: 'image', name: 'image.png', mimeType: 'image/png', data: png }];
  await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify(seed.state));
  const store = new Store(dir);
  await store.load();
  assert.deepEqual(store.session(session.id).images, session.images);
  await store.save();
  await fs.writeFile(path.join(dir, 'state.json'), 'broken');
  const restored = new Store(dir);
  await restored.load();
  assert.ok(restored.storage.recovery?.recoveredFrom);
  assert.deepEqual(await restored.draftImages(session.id), session.images);
});

for (const currentIndex of ['present', 'missing', 'corrupt'] as const) {
  test(`missing image keeps ${currentIndex} index and backups read-only`, async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-draft-missing-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const store = new Store(dir);
    await store.load();
    const session = store.createSession();
    session.images = [{ id: 'image', name: 'image.png', mimeType: 'image/png', data: png }];
    await store.save();
    const backup = await fs.readFile(path.join(dir, 'state.backup-1.json'), 'utf8');
    const image = JSON.parse(backup).sessions[0].images[0].file;
    await fs.unlink(path.join(dir, 'draft-images', image));
    if (currentIndex === 'missing') await fs.unlink(path.join(dir, 'state.json'));
    if (currentIndex === 'corrupt') await fs.writeFile(path.join(dir, 'state.json'), '{broken');
    const restored = new Store(dir);
    await restored.load();
    assert.equal(restored.storage.writable, false);
    assert.match(restored.storage.problem!, /草稿图片/);
    await assert.rejects(restored.save(), /草稿图片/);
    assert.equal(await fs.readFile(path.join(dir, 'state.backup-1.json'), 'utf8'), backup);
  });
}

test('state snapshots omit image bodies, persisted references consume only the same image bytes', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-draft-references-'));
  const store = new Store(dir);
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await store.load();
  const session = store.createSession();
  const image = { id: 'same-id', name: 'picture.png', mimeType: 'image/png', data: png };
  session.images = [image];
  assert.equal('data' in store.visibleState().sessions[0].images![0], false);
  await store.save();
  assert.equal(session.images[0].data, undefined);
  assert.deepEqual(await store.draftImages(session.id), [image]);
  assert.equal(store.matchesDraft(session, '', [], [image]), true);
  const changed = Buffer.concat([Buffer.from(png, 'base64'), Buffer.from('changed')]).toString('base64');
  assert.equal(store.matchesDraft(session, '', [], [{ ...image, data: changed }]), false);
  assert.equal(store.matchesDraft(session, '', [], []), false);
  const restarted = new Store(dir);
  await restarted.load();
  assert.equal(restarted.state.sessions[0].images?.[0].data, undefined);
  assert.deepEqual(await restarted.draftImages(session.id), [image]);
  await fs.writeFile(path.join(dir, 'draft-images', session.images[0].file!), 'tampered');
  await assert.rejects(restarted.draftImages(session.id), /校验失败/);
});
