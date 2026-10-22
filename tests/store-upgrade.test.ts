import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../electron/store';

test('upgrading saves the exact previous index before changing its writer version', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-upgrade-state-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const previous = new Store(dir, '0.8.0');
  await previous.load();
  const session = previous.createSession();
  session.draft = '升级前的草稿';
  session.approvalMode = 'confirm';
  await previous.save();
  const original = await fs.readFile(path.join(dir, 'state.json'), 'utf8');
  const upgraded = new Store(dir, '0.9.0');
  await upgraded.load();
  assert.equal(await fs.readFile(path.join(dir, 'state.pre-0.8.0.json'), 'utf8'), original);
  assert.equal(await fs.readFile(path.join(dir, 'state.json'), 'utf8'), original);
  await upgraded.save();
  assert.equal(upgraded.session(session.id).draft, session.draft);
  assert.equal(upgraded.session(session.id).approvalMode, 'confirm');
  assert.equal(JSON.parse(await fs.readFile(path.join(dir, 'state.json'), 'utf8')).appVersion, '0.9.0');
});

test('an unknown newer index opens read-only without renaming, backing up or overwriting it', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-downgrade-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const original = JSON.stringify({ version: 3, appVersion: '0.10.0', changedSchema: 'keep all bytes' });
  await fs.writeFile(path.join(dir, 'state.json'), original);
  const store = new Store(dir, '0.9.0');
  await store.load();
  assert.equal(store.storage.writable, false);
  assert.match(store.storage.problem!, /v0\.10\.0/);
  assert.equal(store.storage.recovery, undefined);
  await assert.rejects(store.save(), /只读/);
  assert.deepEqual(await fs.readdir(dir), ['state.json']);
  assert.equal(await fs.readFile(path.join(dir, 'state.json'), 'utf8'), original);
});

test('downgrading with a known index format keeps data usable and records the actual writer', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-known-downgrade-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const newer = new Store(dir, '0.9.1');
  await newer.load();
  const session = newer.createSession();
  session.draft = '仍可读取';
  await newer.save();
  const older = new Store(dir, '0.9.0');
  await older.load();
  assert.equal(older.storage.writable, true);
  assert.equal(older.session(session.id).draft, session.draft);
  await older.save();
  assert.equal(older.state.appVersion, '0.9.0');
});

test('pre-upgrade backups retain the three newest versions and handle unversioned indexes', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-pre-upgrade-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const legacy = new Store(dir);
  await legacy.load();
  legacy.createSession();
  await legacy.save();
  for (const version of ['0.8.0', '0.9.0', '0.10.0', '0.11.0']) {
    const store = new Store(dir, version);
    await store.load();
    await store.save();
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  assert.deepEqual((await fs.readdir(dir)).filter((name) => name.startsWith('state.pre-')).sort(), [
    'state.pre-0.10.0.json',
    'state.pre-0.8.0.json',
    'state.pre-0.9.0.json',
  ]);
});

test('a failed pre-upgrade backup keeps the original index intact and makes the app read-only', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-upgrade-backup-failure-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const old = new Store(dir, '0.8.0');
  await old.load();
  old.createSession();
  await old.save();
  const before = await fs.readFile(path.join(dir, 'state.json'), 'utf8');
  // A directory at the temporary backup path produces the same write failure on all platforms.
  await fs.mkdir(path.join(dir, 'state.pre-0.8.0.json.tmp'));
  const next = new Store(dir, '0.9.0');
  await next.load();
  assert.equal(next.storage.writable, false);
  await assert.rejects(next.save(), /无法写入/);
  assert.equal(await fs.readFile(path.join(dir, 'state.json'), 'utf8'), before);
});
