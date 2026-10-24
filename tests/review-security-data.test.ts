import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, sign, randomUUID } from 'node:crypto';
import { verifyUpdateSignature, updateSigningPayload } from '../shared/update-signature';
import { readSignedUpdate, SignedUpdateProvider } from '../electron/signed-update-provider';
import { updateFeed, updateProxy } from '../electron/update-network';
import { launchHealthyUpdate } from '../electron/update-health';
import { Store, readSessionFile } from '../electron/store';
import { Checkpoints } from '../electron/checkpoints';
import { removeSessionScratch, clearDesktopRecords } from '../electron/local-data';
import { commonExecutableDirectories } from '../electron/platform';

async function fixture(t: test.TestContext) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-review-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const signed = (name: string, text: string) =>
  sign(null, updateSigningPayload(name, Buffer.from(text)), keys.privateKey).toString('base64');
const manifest = `version: 1.2.3\nfiles:\n  - url: Pi-Desktop-1.2.3-win-x64-setup.exe\n    size: 100\n    sha512: ${Buffer.alloc(64, 1).toString('base64')}\n`;
test('release authenticity rejects changed bytes, wrong publisher and cross-platform signatures', async () => {
  const sig = signed('latest.yml', manifest);
  verifyUpdateSignature('latest.yml', Buffer.from(manifest), sig, publicKey);
  assert.throws(
    () =>
      verifyUpdateSignature('latest.yml', Buffer.from(manifest.replace('1.2.3', '9.9.9')), sig, publicKey),
    /发布者签名/,
  );
  assert.throws(
    () => verifyUpdateSignature('latest-mac.yml', Buffer.from(manifest), sig, publicKey),
    /发布者签名/,
  );
  assert.throws(() => verifyUpdateSignature('latest.yml', Buffer.from(manifest), sig), /发布者签名/);
  const fetcher = async (url: string) => new Response(url.endsWith('.sig') ? sig : manifest);
  assert.equal(
    (await readSignedUpdate('https://mirror.example/pi/', 'win32', fetcher, publicKey)).version,
    '1.2.3',
  );
  const provider = new SignedUpdateProvider({ provider: 'custom' }, {} as never, {
    isUseMultipleRangeRequest: false,
    platform: 'win32',
    executor: {} as never,
  });
  const verified = await readSignedUpdate('https://mirror.example/pi/', 'win32', fetcher, publicKey);
  assert.equal(
    provider.resolveFiles(verified)[0].url.pathname,
    '/yeyuProject/pi-desktop-gui/releases/download/v1.2.3/Pi-Desktop-1.2.3-win-x64-setup.exe',
  );
  await assert.rejects(
    readSignedUpdate(
      'https://mirror.example/pi/',
      'win32',
      async (url) =>
        new Response(url.endsWith('.sig') ? '' : manifest, { status: url.endsWith('.sig') ? 404 : 200 }),
      publicKey,
    ),
    /发布者签名/,
  );
  await assert.rejects(
    readSignedUpdate(
      'https://mirror.example/pi/',
      'win32',
      async (url) => new Response(url.endsWith('.sig') ? sig : manifest.replace('1.2.3', '9.9.9')),
      publicKey,
    ),
    /发布者签名/,
  );
  const traversal = manifest.replace('Pi-Desktop-1.2.3-win-x64-setup.exe', '../bad.exe');
  await assert.rejects(
    readSignedUpdate(
      'https://mirror.example/pi/',
      'win32',
      async (url) => new Response(url.endsWith('.sig') ? signed('latest.yml', traversal) : traversal),
      publicKey,
    ),
    /文件名/,
  );
});
test('update transport normalizes mirror directories and honors explicit and inherited proxy preferences', () => {
  assert.equal(updateFeed('https://mirror.example/pi'), 'https://mirror.example/pi/');
  for (const url of [
    'http://mirror.example',
    'https://name:secret@mirror.example',
    'https://mirror.example/?token=secret',
  ])
    assert.throws(() => updateFeed(url));
  assert.deepEqual(updateProxy('', {}), { mode: 'system' });
  assert.equal(updateProxy('', { HTTPS_PROXY: 'http://127.0.0.1:7890' }).proxyRules, 'http://127.0.0.1:7890');
  assert.equal(
    updateProxy('socks5://127.0.0.1:1080', { HTTPS_PROXY: 'http://127.0.0.1:7890' }).proxyRules,
    'socks5://127.0.0.1:1080',
  );
  assert.throws(() => updateProxy('http://name:password@localhost:7890'));
});
test(
  'startup health requires the launched process, target version and fresh challenge',
  { skip: process.platform === 'win32' },
  async (t) => {
    const dir = await fixture(t),
      file = path.join(dir, 'health.json'),
      token = randomUUID();
    const script = path.join(dir, 'boot.cjs');
    await fs.writeFile(
      script,
      `require('fs').writeFileSync(process.env.PI_DESKTOP_UPDATE_HEALTH_FILE, JSON.stringify({token:process.env.PI_DESKTOP_UPDATE_HEALTH_TOKEN, version:'1.2.3', pid:process.pid})); setTimeout(()=>{},300);`,
    );
    await launchHealthyUpdate(process.execPath, file, token, '1.2.3', 3000, [script]);
    await fs.writeFile(script, 'process.exit(7)');
    await assert.rejects(
      launchHealthyUpdate(process.execPath, file, token, '1.2.3', 3000, [script]),
      /未能完成启动/,
    );
    await fs.writeFile(
      script,
      `require('fs').writeFileSync(process.env.PI_DESKTOP_UPDATE_HEALTH_FILE, JSON.stringify({token:'wrong', version:'1.2.3', pid:process.pid})); setTimeout(()=>{},30000);`,
    );
    await assert.rejects(
      launchHealthyUpdate(process.execPath, file, token, '1.2.3', 300, [script]),
      /未能完成启动/,
    );
  },
);
test('a transient save failure recovers the current draft without restarting or bypassing a damaged index', async (t) => {
  const dir = await fixture(t),
    store = new Store(dir);
  t.after(() => store.stopRecovery());
  await store.load();
  const session = store.createSession();
  session.draft = 'saved';
  await store.save();
  const write = fs.writeFile;
  let blocked = true;
  t.mock.method(fs, 'writeFile', async (...args: Parameters<typeof fs.writeFile>) => {
    if (String(args[0]) === path.join(dir, 'state.json.tmp') && blocked)
      throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    return write(...args);
  });
  session.draft = 'new draft';
  await assert.rejects(store.save(), /EBUSY/);
  assert.equal(store.storage.writable, false);
  session.draft = 'latest draft';
  blocked = false;
  await store.retrySave();
  assert.equal(store.storage.writable, true);
  assert.equal(
    JSON.parse(await fs.readFile(path.join(dir, 'state.json'), 'utf8')).sessions[0].draft,
    'latest draft',
  );
  store.storage = { writable: false, problem: 'damaged index' };
  await assert.rejects(store.retrySave(), /damaged index/);
});
test('automatic write recovery keeps the latest in-memory draft', async (t) => {
  const dir = await fixture(t),
    store = new Store(dir);
  t.after(() => store.stopRecovery());
  await store.load();
  const session = store.createSession();
  await store.save();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const write = fs.writeFile;
  let blocked = true;
  t.mock.method(fs, 'writeFile', async (...args: Parameters<typeof fs.writeFile>) => {
    if (String(args[0]) === path.join(dir, 'state.json.tmp') && blocked)
      throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    return write(...args);
  });
  session.draft = '自动恢复';
  await assert.rejects(store.save());
  blocked = false;
  const recovered = new Promise<void>((resolve) => store.once('storage', () => resolve()));
  t.mock.timers.tick(5000);
  await recovered;
  assert.equal(store.storage.writable, true);
  assert.equal(
    JSON.parse(await fs.readFile(path.join(dir, 'state.json'), 'utf8')).sessions[0].draft,
    '自动恢复',
  );
});
test('fallback executable discovery includes Homebrew, nvm, fnm, Volta and pnpm without evaluating shell code', async (t) => {
  const dir = await fixture(t);
  await fs.mkdir(path.join(dir, '.nvm/versions/node/v22.19.0'), { recursive: true });
  await fs.mkdir(path.join(dir, '.nvm/versions/node/v24.1.0'), { recursive: true });
  await fs.mkdir(path.join(dir, '.local/share/fnm/node-versions/v24.2.0'), { recursive: true });
  const dirs = await commonExecutableDirectories(dir);
  for (const candidate of [
    '/opt/homebrew/bin',
    path.join(dir, '.volta/bin'),
    path.join(dir, 'Library/pnpm'),
    path.join(dir, '.nvm/versions/node/v24.1.0/bin'),
    path.join(dir, '.local/share/fnm/node-versions/v24.2.0/installation/bin'),
  ])
    assert.ok(dirs.includes(candidate));
  assert.ok(
    dirs.indexOf(path.join(dir, '.nvm/versions/node/v24.1.0/bin')) <
      dirs.indexOf(path.join(dir, '.nvm/versions/node/v22.19.0/bin')),
  );
});
test('large JSONL histories open the active branch and bound its preview while preserving full-file usage', async (t) => {
  const dir = await fixture(t),
    file = path.join(dir, 'large.jsonl');
  const handle = await fs.open(file, 'w');
  await handle.write(JSON.stringify({ type: 'session', cwd: dir }) + '\r\n');
  for (let i = 0; i < 66; i++)
    await handle.write(
      JSON.stringify({
        type: 'message',
        id: `old-${i}`,
        parentId: i ? `old-${i - 1}` : null,
        message: { role: 'user', content: 'x'.repeat(1024 * 1024) },
      }) + '\r\n',
    );
  await handle.write(
    JSON.stringify({
      type: 'message',
      id: 'current',
      parentId: null,
      message: { role: 'user', content: '当前分支 中文' },
    }) + '\r\n',
  );
  await handle.write('{incomplete');
  await handle.close();
  const result = await readSessionFile(file);
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].content, '当前分支 中文');
  assert.match(result.warning!, /当前分支/);
  // Repoint the last entry to the long branch without changing or deleting the source file.
  await fs.truncate(file, (await fs.stat(file)).size - Buffer.byteLength('{incomplete'));
  await fs.appendFile(
    file,
    JSON.stringify({
      type: 'message',
      id: 'tail',
      parentId: 'old-65',
      message: { role: 'user', content: 'tail' },
    }) + '\n',
  );
  const preview = await readSessionFile(file);
  assert.match(preview.warning!, /仅显示.*16 MiB/);
  assert.ok(preview.messages.length > 1 && preview.messages.length < 20);
  assert.equal(preview.messages.at(-1)?.content, 'tail');
  assert.ok((await fs.stat(file)).size > 64 * 1024 * 1024);
});
test('deleting session artifacts removes its code snapshots and backup drafts while retaining other sessions', async (t) => {
  const dir = await fixture(t),
    store = new Store(dir),
    checkpoints = new Checkpoints(dir);
  await store.load();
  const deleted = store.createSession(),
    kept = store.createSession();
  deleted.draft = 'private source draft';
  kept.draft = 'keep';
  await store.save();
  await fs.copyFile(path.join(dir, 'state.json'), path.join(dir, 'state.pre-1.0.0.json'));
  await fs.mkdir(checkpoints.directory, { recursive: true });
  for (const id of [deleted.id, kept.id]) {
    await fs.mkdir(path.join(checkpoints.directory, `session-${id}-objects.git`));
    await fs.writeFile(path.join(checkpoints.directory, `${id}-1.json`), 'snapshot');
    await fs.writeFile(path.join(checkpoints.directory, `session-${id}.state`), 'tracking');
    await fs.writeFile(path.join(dir, `draft-${id}.txt`), 'draft');
    await fs.writeFile(path.join(dir, `desktop-bridge-${id}.mjs`), 'bridge');
  }
  await checkpoints.removeSession(deleted.id);
  await removeSessionScratch(dir, deleted.id);
  store.removeSessions([deleted.id]);
  await store.save();
  await store.purgeDeletedSession(deleted.id);
  for (const file of await fs.readdir(dir))
    if (file.startsWith('state.'))
      assert.doesNotMatch(await fs.readFile(path.join(dir, file), 'utf8'), /private source draft/);
  await fs.access(path.join(checkpoints.directory, `${kept.id}-1.json`));
  await assert.rejects(fs.access(path.join(checkpoints.directory, `session-${deleted.id}-objects.git`)));
  await fs.writeFile(path.join(dir, 'unrelated.txt'), 'keep');
  await clearDesktopRecords(dir);
  await assert.rejects(fs.access(path.join(dir, 'state.json')));
  await assert.rejects(fs.access(path.join(dir, 'baselines')));
  assert.equal(await fs.readFile(path.join(dir, 'unrelated.txt'), 'utf8'), 'keep');
});
