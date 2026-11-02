import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { LfJsonDecoder } from '../electron/rpc';
import { Store, readSessionFile } from '../electron/store';
import { Workspace, attachmentPrompt, previewFile, safePath } from '../electron/workspace';
import { AgentService, redact } from '../electron/agent';
import { busy, type Project } from '../shared/types';
const exec = promisify(execFile);
const root = path.resolve('work/tests');
// Fixtures live under this checkout; do not inherit its parent Git repository.
process.env.GIT_CEILING_DIRECTORIES = root;
async function sandbox() {
  await fs.mkdir(root, { recursive: true });
  return fs.mkdtemp(path.join(root, '用例 space-'));
}
const project = (p: string): Project => ({
  id: randomUUID(),
  name: '测试',
  path: p,
  trusted: true,
  createdAt: Date.now(),
});
async function git(p: string, ...args: string[]) {
  return exec('git', args, { cwd: p, windowsHide: true });
}
async function waitFor(condition: () => boolean, ms = 5000) {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > ms) throw new Error('Condition timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
}

test('LF decoder preserves split UTF-8, CRLF and Unicode separators; rejects malformed records', () => {
  const values: any[] = [],
    errors: Error[] = [];
  const decoder = new LfJsonDecoder(
    (v) => values.push(v),
    (e) => errors.push(e),
  );
  const bytes = Buffer.from(
    JSON.stringify({ type: 'message', text: '中文\u2028\u2029🙂' }) +
      '\r\n' +
      JSON.stringify({ type: 'second' }) +
      '\n',
  );
  for (let i = 0; i < bytes.length; i += 2) decoder.push(bytes.subarray(i, i + 2));
  assert.equal(values.length, 2);
  assert.equal(values[0].text, '中文\u2028\u2029🙂');
  assert.equal(errors.length, 0);
  decoder.push(Buffer.from('not json\n{"no_type":true}\n'));
  assert.equal(errors.length, 2);
});
test('store writes latest draft atomically and recovers interrupted session without replay', async () => {
  const dir = await sandbox(),
    store = new Store(dir);
  await store.load();
  const p = project(dir);
  store.state.projects = [p];
  store.state.sessions = [
    {
      id: randomUUID(),
      projectId: p.id,
      title: '会话',
      draft: '中文草稿',
      attachments: ['a.txt'],
      updatedAt: 1,
      lastStatus: 'running',
    },
  ];
  const first = store.save();
  store.state.sessions[0].draft = '最后草稿';
  await store.save();
  await first;
  const restored = new Store(dir);
  await restored.load();
  assert.equal(restored.state.sessions[0].draft, '最后草稿');
  assert.equal(restored.state.sessions[0].lastStatus, 'interrupted');
  await fs.writeFile(path.join(dir, 'state.json'), 'broken');
  const recovered = new Store(dir);
  await recovered.load();
  assert.equal(await fs.readFile(recovered.storage.recovery!.corruptFile!, 'utf8'), 'broken');
  assert.equal(recovered.state.sessions[0].draft, '中文草稿');
});
test('standalone conversations persist alongside projects and keep independent working directories', async () => {
  const store = new Store(await sandbox());
  await store.load();
  const p = project(await sandbox());
  store.state.projects.push(p);
  const projectSession = store.createSession(p.id);
  const first = store.createSession();
  const second = store.createSession();
  first.draft = '尚未发送的独立对话';
  assert.equal(store.state.selectedProjectId, undefined);
  assert.equal(store.state.projects.length, 1);
  const firstDirectory = await store.sessionDirectory(first.id);
  assert.ok(firstDirectory.startsWith(path.join(store.dir, 'chats') + path.sep));
  assert.notEqual(firstDirectory, await store.sessionDirectory(second.id));
  assert.equal(await store.sessionDirectory(projectSession.id), p.path);
  store.selectSession(projectSession.id);
  assert.equal(store.state.selectedProjectId, p.id);
  store.selectSession(first.id);
  await store.save();
  const restored = new Store(store.dir);
  await restored.load();
  assert.equal(restored.state.selectedProjectId, undefined);
  assert.equal(restored.state.selectedSessionId, first.id);
  assert.equal(restored.session(first.id).draft, '尚未发送的独立对话');
  assert.equal(await restored.sessionDirectory(first.id), firstDirectory);
  assert.equal(restored.session(projectSession.id).projectId, p.id);
  assert.throws(() => restored.createSession('missing-project'), /项目不存在/);
});

test('JSONL history selects active branch and tolerates only a truncated final line', async () => {
  const dir = await sandbox(),
    file = path.join(dir, 'session.jsonl');
  const records = [
    { type: 'session', cwd: dir },
    { type: 'message', id: 'a', parentId: null, message: { role: 'user', content: 'A' } },
    { type: 'message', id: 'b', parentId: 'a', message: { role: 'assistant', content: 'old branch' } },
    { type: 'message', id: 'c', parentId: 'a', message: { role: 'assistant', content: 'new branch' } },
    { type: 'session_info', id: 'd', parentId: 'c', name: '会话' },
  ];
  await fs.writeFile(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n{"unfinished":');
  const parsed = await readSessionFile(file);
  assert.deepEqual(
    parsed.messages.map((m) => m.content),
    ['A', 'new branch'],
  );
  assert.equal(parsed.name, '会话');
  await fs.writeFile(file, '{"type":"session","cwd":"x"}\ninvalid\n');
  await assert.rejects(readSessionFile(file), /损坏/);
});
test('attachments reject traversal, sensitive files, binaries, oversize and deleted paths', async () => {
  const dir = await sandbox(),
    p = project(dir);
  await fs.writeFile(path.join(dir, '中文.txt'), 'hello 中文');
  await fs.writeFile(path.join(dir, '.env'), 'secret');
  await fs.writeFile(path.join(dir, 'binary.bin'), Buffer.from([0, 1, 2]));
  await fs.writeFile(path.join(dir, 'large.txt'), 'x'.repeat(256 * 1024 + 1));
  assert.match(await attachmentPrompt(p, 'task', ['中文.txt']), /hello 中文/);
  await assert.rejects(attachmentPrompt(p, 'task', ['../outside']), /项目以外/);
  await assert.rejects(previewFile(p, '.env'), /凭据/);
  await assert.rejects(attachmentPrompt(p, 'task', ['binary.bin']), /文本/);
  await assert.rejects(attachmentPrompt(p, 'task', ['large.txt']), /256/);
  await assert.rejects(attachmentPrompt(p, 'task', ['deleted.txt']), /ENOENT/);
  const outside = await sandbox();
  await fs.writeFile(path.join(outside, 'secret.txt'), 'outside');
  await fs.symlink(outside, path.join(dir, 'junction'), 'junction');
  await assert.rejects(safePath(dir, 'junction/secret.txt'), /指向项目外/);
  await fs.writeFile(path.join(dir, 'big.txt'), 'x'.repeat(256 * 1024));
  await assert.rejects(attachmentPrompt(p, 'x'.repeat(800 * 1024), ['big.txt']), /总计/);
});
test('Git diff distinguishes preexisting edits, external edits, deleted and empty added files', async () => {
  const dir = await sandbox(),
    data = await sandbox(),
    p = project(dir);
  await git(dir, 'init');
  await fs.writeFile(path.join(dir, '已修改.txt'), 'original\n');
  await fs.writeFile(path.join(dir, 'delete.txt'), 'delete\n');
  await git(dir, 'add', '.');
  await git(dir, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture');
  await fs.writeFile(path.join(dir, '已修改.txt'), 'before run\n');
  const ws = new Workspace(data);
  await ws.capture(p);
  await fs.writeFile(path.join(dir, '已修改.txt'), 'after run\n');
  await fs.unlink(path.join(dir, 'delete.txt'));
  await fs.writeFile(path.join(dir, 'empty.txt'), '');
  await fs.writeFile(path.join(dir, 'manual.txt'), 'external edit');
  const changes = await ws.changes(p, 'run');
  assert.equal(changes.files.length, 4);
  assert.equal(changes.files.find((f) => f.path === 'delete.txt')?.status, '删除');
  assert.equal(changes.files.find((f) => f.path === 'empty.txt')?.status, '新增');
  assert.equal(changes.files.find((f) => f.path === '已修改.txt')?.existedBeforeRun, true);
  assert.equal((await ws.diff(p, '已修改.txt', 'run')).before, 'before run\n');
  assert.equal((await ws.diff(p, '已修改.txt', 'all')).before, 'original\n');
  assert.equal((await new Workspace(data).changes(p, 'run')).baselineAvailable, true);
  await git(dir, 'checkout', '-b', 'other');
  assert.equal((await ws.changes(p, 'run')).baselineInvalid, true);
});
test('unborn repositories show additions and non-Git directories remain browsable', async () => {
  const dir = await sandbox(),
    p = project(dir),
    ws = new Workspace(await sandbox());
  await fs.writeFile(path.join(dir, 'file.txt'), 'first');
  assert.equal((await ws.changes(p)).git, false);
  await git(dir, 'init');
  assert.equal((await ws.changes(p)).files[0].status, '新增');
  assert.equal((await ws.diff(p, 'file.txt', 'all')).before, '');
});
test('undo restores original bytes after restart and rejects older snapshot formats', async () => {
  const dir = await sandbox(),
    data = await sandbox(),
    p = project(dir);
  await git(dir, 'init');
  const file = path.join(dir, 'gbk.txt');
  const original = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x0d, 0x0a]);
  await fs.writeFile(file, original);
  await new Workspace(data).capture(p);
  // Both byte sequences decode to four replacement characters under UTF-8.
  await fs.writeFile(file, Buffer.from([0xb0, 0xb1, 0xb2, 0xb3, 0x0d, 0x0a]));
  const restored = new Workspace(data);
  assert.deepEqual(
    (await restored.changes(p, 'run')).files.map((f) => f.path),
    ['gbk.txt'],
  );
  assert.deepEqual(await restored.revert(p, ['gbk.txt']), ['gbk.txt']);
  assert.deepEqual(await fs.readFile(file), original);
  await fs.unlink(file);
  await restored.revert(p, ['gbk.txt']);
  assert.deepEqual(await fs.readFile(file), original, 'deleted files also retain their encoding');

  const snapshotFile = path.join(data, 'baselines', `${p.id}.json`);
  const snapshot = JSON.parse(await fs.readFile(snapshotFile, 'utf8'));
  snapshot.version = 2;
  snapshot.files['gbk.txt'] = original.toString('utf8');
  await fs.writeFile(snapshotFile, JSON.stringify(snapshot));
  const legacy = new Workspace(data);
  assert.equal((await legacy.changes(p, 'run')).baselineAvailable, false);
  await assert.rejects(legacy.revert(p, null), /运行基线不可用/);
  assert.deepEqual(await fs.readFile(file), original);
});

test('Git snapshots restore binaries, modes and line endings without touching the project repository', async () => {
  const dir = await sandbox(),
    data = await sandbox(),
    p = project(dir);
  await git(dir, 'init');
  await fs.writeFile(path.join(dir, 'crlf.txt'), 'a\r\nb\r\n');
  await fs.writeFile(path.join(dir, '.gitattributes'), '*.txt text eol=lf\n');
  await git(dir, 'add', '.');
  await git(dir, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture');
  const image = Buffer.from(Array.from({ length: 2 * 1024 * 1024 }, (_, i) => i % 251));
  await fs.writeFile(path.join(dir, 'image.png'), image);
  await fs.writeFile(path.join(dir, 'run.sh'), '#!/bin/sh\n', { mode: 0o755 });
  const repoState = async () => [
    await git(dir, 'for-each-ref'),
    await git(dir, 'stash', 'list'),
    await git(dir, 'count-objects'),
    await git(dir, 'status', '--porcelain'),
  ];
  const before = await repoState();
  const ws = new Workspace(data);
  await ws.capture(p);
  assert.deepEqual(await repoState(), before, 'snapshot must not write to the project repository');
  await fs.writeFile(path.join(dir, 'image.png'), Buffer.alloc(8, 1));
  await fs.writeFile(path.join(dir, 'crlf.txt'), 'changed\n');
  await fs.rm(path.join(dir, 'run.sh'));
  await fs.writeFile(path.join(dir, 'added.bin'), Buffer.from([0, 1, 2]));
  assert.deepEqual((await ws.changes(p, 'run')).files.map((f) => f.path).sort(), [
    'added.bin',
    'crlf.txt',
    'image.png',
    'run.sh',
  ]);
  assert.match((await ws.diff(p, 'image.png', 'run')).unavailable ?? '', /可撤销/);
  await new Workspace(data).revert(p, null);
  assert.deepEqual(await fs.readFile(path.join(dir, 'image.png')), image);
  assert.equal(await fs.readFile(path.join(dir, 'crlf.txt'), 'utf8'), 'a\r\nb\r\n');
  await assert.rejects(fs.stat(path.join(dir, 'added.bin')));
  if (process.platform !== 'win32')
    assert.equal((await fs.stat(path.join(dir, 'run.sh'))).mode & 0o777, 0o755);
  assert.equal((await ws.changes(p, 'run')).files.length, 0);
});

test('undo excludes directory links and never removes or overwrites their targets', async () => {
  const dir = await sandbox(),
    data = await sandbox(),
    p = project(dir);
  await git(dir, 'init');
  const originalDir = path.join(dir, 'original');
  const replacedDir = path.join(dir, 'replaced');
  await fs.mkdir(originalDir);
  await fs.mkdir(replacedDir);
  const originalFile = path.join(originalDir, 'keep.txt');
  await fs.writeFile(originalFile, 'original content\n');
  await fs.writeFile(path.join(replacedDir, 'keep.txt'), 'different content\n');
  const workspace = new Workspace(data);
  await workspace.capture(p);
  await fs.symlink(originalDir, path.join(dir, 'new-alias'), 'junction');
  await fs.unlink(path.join(replacedDir, 'keep.txt'));
  await fs.rmdir(replacedDir);
  await fs.symlink(originalDir, replacedDir, 'junction');
  const changes = await workspace.changes(p, 'run');
  assert.deepEqual(changes.files, []);
  // Git lists a Windows junction's contents but a POSIX symlink as a single entry.
  assert.ok(changes.omitted.some((name) => name === 'new-alias/keep.txt' || name === 'new-alias'));
  assert.ok(changes.omitted.includes('replaced/keep.txt'));
  await assert.rejects(workspace.revert(p, ['new-alias/keep.txt']), /不在本轮变更/);
  const removed: string[] = [];
  assert.deepEqual(
    await workspace.revert(p, null, async (file) => {
      removed.push(file);
    }),
    [],
  );
  assert.deepEqual(removed, []);
  assert.equal(await fs.readFile(originalFile, 'utf8'), 'original content\n');
  assert.equal((await fs.lstat(path.join(dir, 'new-alias'))).isSymbolicLink(), true);
});

test('real subprocess protocol lifecycle: settled, retry, cancellation, queue, extensions and crash', async () => {
  const dir = await sandbox(),
    data = await sandbox(),
    agentDir = await sandbox(),
    store = new Store(data);
  await store.load();
  const p = project(dir),
    id = randomUUID(),
    other = randomUUID();
  store.state.projects = [p];
  store.state.sessions = [id, other].map((id) => ({
    id,
    projectId: p.id,
    title: '新会话',
    draft: '',
    attachments: [],
    updatedAt: Date.now(),
    lastStatus: 'idle' as const,
  }));
  store.state.selectedSessionId = id;
  store.state.settings = {
    ...store.state.settings,
    piPath: path.resolve('tests/support/fixture-pi.mjs'),
    nodePath: process.execPath,
    agentDir,
  };
  const service = new AgentService(store, new Workspace(data));
  const statuses: string[] = [];
  service.on('runtime', (r) => statuses.push(r.status));
  try {
    await service.connect(id);
    assert.equal(service.runtime.connected, true);
    assert.ok(!JSON.stringify(service.runtime.model).includes('Authorization'));
    assert.ok(!JSON.stringify(service.runtime.models).includes('test-secret'));
    await service.send(id, '/handled', [], 'steer');
    assert.equal(service.runtime.status, 'idle');
    await service.send(id, 'retry', [], 'steer');
    await waitFor(() => service.runtime.status === 'retrying');
    assert.ok(busy(service.runtime.status));
    await waitFor(() => service.runtime.status === 'completed');
    assert.ok(statuses.includes('compacting'));
    await fs.writeFile(path.join(agentDir, 'control.json'), JSON.stringify({ cancelSwitch: true }));
    await assert.rejects(service.connect(other), /拦截了这次切换/);
    assert.equal(service.runtime.sessionId, id);
    await service.send(id, 'hold', [], 'steer');
    await service.send(id, '补充要求', [], 'steer');
    await service.send(id, '后续任务', [], 'followUp');
    assert.deepEqual(service.runtime.steering, ['补充要求']);
    assert.deepEqual(service.runtime.followUp, ['后续任务']);
    await assert.rejects(service.send(other, '不应该发送', [], 'steer'), /另一个会话正在运行/);
    await service.stop();
    assert.equal(service.runtime.status, 'stopped');
    assert.match(store.session(id).draft, /补充要求\n\n后续任务/);
    const commands = (await fs.readFile(path.join(agentDir, 'commands.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l).type);
    assert.ok(commands.indexOf('clear_queue') < commands.indexOf('abort'));
    for (const method of ['select', 'confirm', 'input', 'editor']) {
      await service.send(id, 'extension ' + method, [], 'steer');
      await waitFor(() => service.runtime.dialogs.length === 1);
      await service.respond(
        'question-1',
        method === 'select'
          ? { value: 'B' }
          : method === 'confirm'
            ? { confirmed: false }
            : { cancelled: true },
      );
      await waitFor(() => service.runtime.status === 'completed');
      assert.equal(service.runtime.dialogs.length, 0);
    }
    await service.send(id, 'extension input timeout', [], 'steer');
    await waitFor(() => service.runtime.status === 'completed');
    await assert.rejects(service.respond('question-1', { value: 'late' }), /已失效/);
    await service.send(id, 'crash', [], 'steer');
    await waitFor(() => service.runtime.status === 'interrupted');
    assert.equal(service.runtime.connected, false);
  } finally {
    await service.dispose();
  }
});
test('diagnostics redact common token formats', () => {
  const result = redact(
    'Authorization: Bearer abc123 api_key=secret123 sk-abcdefghijklmno ghp_abcdefghijklmno',
  );
  assert.ok(!result.includes('secret123'));
  assert.ok(!result.includes('sk-'));
  assert.ok(!result.includes('ghp_'));
  assert.ok(!result.includes('abc123'));
});
