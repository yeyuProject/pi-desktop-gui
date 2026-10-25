import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Configuration } from '../electron/configuration';
import { Store } from '../electron/store';
import { lock } from 'proper-lockfile';

// Exercise the same persistence/apply method as the IPC handler with real files and synthetic errors.
async function fixture(t: test.TestContext) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-config-save-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = new Store(dir);
  await store.load();
  store.state.settings.agentDir = path.join(dir, 'agent');
  const session = store.createSession();
  const config = new Configuration(store);
  await fs.mkdir(store.state.settings.agentDir);
  const file = path.join(store.state.settings.agentDir, 'settings.json');
  const original = '{"retry":{"enabled":true},"apiKey":"private-fixture-secret"}';
  await fs.writeFile(file, original);
  const document = await config.read(session.id, 'settings', false);
  const updated = JSON.parse(document.text);
  updated.retry.enabled = false;
  return { config, file, original, session, document: { ...document, text: JSON.stringify(updated) } };
}

test('configuration persists and backs up before applying, preserving masked secrets', async (t) => {
  const f = await fixture(t);
  const calls: string[] = [];
  const result = await f.config.saveAndApply(f.session.id, 'settings', false, f.document, async () => {
    calls.push('apply');
    const saved = JSON.parse(await fs.readFile(f.file, 'utf8'));
    assert.equal(saved.retry.enabled, false);
    assert.equal(saved.apiKey, 'private-fixture-secret');
    assert.equal(await fs.readFile(f.file + '.desktop-backup', 'utf8'), f.original);
    return { applied: true };
  });
  assert.deepEqual(result, { applied: true });
  assert.deepEqual(calls, ['apply']);
});

test('failed reconnect returns saved-but-not-applied and redacts the warning', async (t) => {
  const f = await fixture(t);
  const result = await f.config.saveAndApply(f.session.id, 'settings', false, f.document, async () => {
    throw new Error('Cannot connect: Authorization: Bearer private-token API_KEY="private-key"');
  });
  assert.equal(result.applied, false);
  assert.match(result.warning!, /Cannot connect/);
  assert.ok(!JSON.stringify(result).includes('private-token'));
  assert.ok(!JSON.stringify(result).includes('private-key'));
  assert.ok(!JSON.stringify(result).includes('private-fixture-secret'));
  assert.equal(JSON.parse(await fs.readFile(f.file, 'utf8')).retry.enabled, false);
  assert.equal(await fs.readFile(f.file + '.desktop-backup', 'utf8'), f.original);
  const refreshed = await f.config.read(f.session.id, 'settings', false);
  assert.notEqual(refreshed.revision, f.document.revision);
  const next = { ...refreshed, text: JSON.stringify({ ...JSON.parse(refreshed.text), nextEdit: true }) };
  assert.deepEqual(
    await f.config.saveAndApply(f.session.id, 'settings', false, next, async () => ({ applied: true })),
    { applied: true },
  );
  assert.equal(JSON.parse(await fs.readFile(f.file, 'utf8')).nextEdit, true);
});

test('save rejection remains a failure and does not reconnect or overwrite the original', async (t) => {
  const f = await fixture(t);
  let connected = false;
  await assert.rejects(
    f.config.saveAndApply(f.session.id, 'settings', false, { ...f.document, revision: 'stale' }, async () => {
      connected = true;
      return { applied: true };
    }),
    /其他程序修改/,
  );
  assert.equal(connected, false);
  assert.equal(await fs.readFile(f.file, 'utf8'), f.original);
});

test('a running session can defer loading after the file has been saved', async (t) => {
  const f = await fixture(t);
  const result = await f.config.saveAndApply(f.session.id, 'settings', false, f.document, async () => ({
    applied: false,
    deferred: true,
  }));
  assert.deepEqual(result, { applied: false, deferred: true });
  assert.equal(JSON.parse(await fs.readFile(f.file, 'utf8')).retry.enabled, false);
  assert.equal(await fs.readFile(f.file + '.desktop-backup', 'utf8'), f.original);
});

test('the native Pi file lock prevents a config save from overwriting a concurrent settings update', async (t) => {
  const f = await fixture(t);
  const release = await lock(f.file, {
    realpath: false,
    retries: { retries: 0, minTimeout: 10, maxTimeout: 10 },
  });
  let finished = false;
  const saving = f.config.save(f.session.id, 'settings', false, f.document).finally(() => {
    finished = true;
  });
  const rejected = assert.rejects(saving, /其他程序修改/);
  try {
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(finished, false, 'desktop save must wait while native Pi owns the file lock');
    await fs.writeFile(f.file, JSON.stringify({ retry: { enabled: true }, nativeUpdate: true }));
  } finally {
    await release();
  }
  await rejected;
  assert.equal(JSON.parse(await fs.readFile(f.file, 'utf8')).nativeUpdate, true);
});

test('BOM config files remain readable and save without losing masked credentials', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.file, '\uFEFF' + f.original);
  const document = await f.config.read(f.session.id, 'settings', false);
  assert.equal(document.error, undefined);
  assert.ok(!document.text.includes('private-fixture-secret'));
  await f.config.save(f.session.id, 'settings', false, document);
  assert.equal(JSON.parse(await fs.readFile(f.file, 'utf8')).apiKey, 'private-fixture-secret');
  assert.equal(await fs.readFile(f.file + '.desktop-backup', 'utf8'), '\uFEFF' + f.original);
});

test('malformed config exposes its repair document and path, retaining backup and revision protection', async (t) => {
  const f = await fixture(t);
  const broken = '{"unknownSetting":true, "client_secret":"local-test-value",}';
  await fs.writeFile(f.file, broken);
  const document = await f.config.read(f.session.id, 'settings', false);
  assert.equal(document.path, f.file);
  assert.equal(document.text, broken);
  assert.match(document.error!, /原文.*密钥/);
  await assert.rejects(f.config.save(f.session.id, 'settings', false, document), /有效的 JSON/);
  assert.equal(await fs.readFile(f.file, 'utf8'), broken);
  await f.config.save(f.session.id, 'settings', false, { ...document, text: broken.replace(',}', '}') });
  assert.equal(await fs.readFile(f.file + '.desktop-backup', 'utf8'), broken);
  assert.equal(JSON.parse(await fs.readFile(f.file, 'utf8')).client_secret, 'local-test-value');
  await assert.rejects(
    f.config.save(f.session.id, 'settings', false, { ...document, text: '{}' }),
    /其他程序修改/,
  );
});
