import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import childProcess, { execFile } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
import { snapshotStorageBytes, Workspace } from '../electron/workspace';
import type { Project } from '../shared/types';

const exec = promisify(execFile);
function trackStorageReads(t: TestContext, data: string) {
  const calls: { method: string; file: string }[] = [];
  for (const method of ['readFile', 'readdir', 'stat'] as const) {
    const original = fs[method];
    t.mock.method(fs, method, (...args: unknown[]) => {
      if (typeof args[0] === 'string' && args[0].startsWith(path.join(data, 'baselines')))
        calls.push({ method, file: args[0] });
      return Reflect.apply(original, fs, args);
    });
  }
  return calls;
}
async function padSnapshot(repo: string, bytes: number) {
  const file = path.join(repo, 'objects', 'quota-probe');
  const handle = await fs.open(file, 'w');
  try {
    await handle.truncate(bytes);
  } finally {
    await handle.close();
  }
  return file;
}
function trackHashes(t: TestContext) {
  const calls: { stored: boolean; ids: string[] }[] = [];
  const spawn = childProcess.spawn;
  const mock = t.mock.method(childProcess, 'spawn', (...args: Parameters<typeof spawn>) => {
    const child = spawn(...args);
    if (args[0] === 'git' && args[1]?.includes('hash-object')) {
      const call = { stored: args[1].includes('-w'), ids: [] as string[] };
      calls.push(call);
      let output = '';
      child.stdout!.on('data', (chunk) => (output += chunk.toString()));
      child.once('close', () => (call.ids = output.trim().split('\n').filter(Boolean)));
    }
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => {
    mock.mock.restore();
    syncBuiltinESMExports();
  });
  return calls;
}
async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-checkpoints-'));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));
  const directory = path.join(root, 'project'),
    data = path.join(root, 'data');
  await fs.mkdir(directory);
  const git = (args: string[]) => exec('git', args, { cwd: directory, windowsHide: true });
  await git(['init', '-b', 'main']);
  await git(['config', 'user.name', 'Checkpoint Test']);
  await git(['config', 'user.email', 'checkpoint@example.invalid']);
  const project: Project = {
    id: randomUUID(),
    name: 'checkpoint',
    path: directory,
    trusted: true,
    createdAt: Date.now(),
  };
  const sessionId = randomUUID(),
    workspace = new Workspace(data);
  const write = (name: string, text: string) => fs.writeFile(path.join(directory, name), text);
  const toolWrite = async (name: string, text: string) => {
    const id = randomUUID();
    await workspace.beginTool(project, sessionId, id, 'write', { path: name });
    await write(name, text);
    await workspace.endTool(project, sessionId, id);
  };
  return { root, directory, data, git, project, sessionId, workspace, write, toolWrite };
}

test('nested project checkpoints track writes and commands and restore the project file', async (t) => {
  const { project, workspace, sessionId, directory } = await fixture(t);
  project.path = path.join(directory, 'lucky');
  const name = 'docs/CFS2号上传操作教程.md';
  const file = path.join(project.path, name);
  const parentFile = path.join(directory, name);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.mkdir(path.dirname(parentFile), { recursive: true });
  await fs.writeFile(file, 'original project document');
  await fs.writeFile(parentFile, 'unrelated parent document');
  const checkpoint = await workspace.captureCheckpoint(project, sessionId, 1);
  assert.ok(checkpoint);
  await workspace.beginTool(project, sessionId, 'write-document', 'write', { path: name });
  await fs.writeFile(file, 'updated by write');
  await workspace.endTool(project, sessionId, 'write-document');
  await workspace.beginTool(project, sessionId, 'generate-document', 'powershell', { command: 'generate' });
  await fs.writeFile(file, 'updated by command');
  await workspace.endTool(project, sessionId, 'generate-document');
  const preview = await workspace.checkpointPreview(project, sessionId, checkpoint.id);
  assert.deepEqual(
    preview.files.map(({ path, selected, manual }) => ({ path, selected, manual })),
    [{ path: name, selected: true, manual: false }],
  );
  await workspace.revert(project, [name], undefined, {
    sessionId,
    checkpointId: checkpoint.id,
    revision: preview.revision,
  });
  assert.equal(await fs.readFile(file, 'utf8'), 'original project document');
  assert.equal(await fs.readFile(parentFile, 'utf8'), 'unrelated parent document');
});

test('command boundaries hash only changed files and keep later checkpoints restorable', async (t) => {
  const { project, workspace, sessionId, directory, write, toolWrite } = await fixture(t);
  await write('manual.txt', 'before');
  await write('command.txt', 'before');
  await write('deleted.txt', 'before');
  const first = (await workspace.captureCheckpoint(project, sessionId, 1))!;
  const hashes = trackHashes(t);
  await workspace.beginTool(project, sessionId, 'unchanged', 'bash', {});
  await workspace.endTool(project, sessionId, 'unchanged');
  assert.equal(hashes.length, 0, 'capture seeds the scan cache; unchanged commands read no file content');

  const manualFile = path.join(directory, 'manual.txt');
  const stamp = await fs.stat(manualFile);
  await write('manual.txt', 'manual');
  await fs.utimes(manualFile, stamp.atime, stamp.mtime);
  await workspace.beginTool(project, sessionId, 'changes', 'powershell', {});
  assert.equal(hashes.length, 1);
  assert.equal(hashes[0].ids.length, 1, 'same size and restored mtime still invalidate the changed file');
  await write('command.txt', 'edited');
  await write('created.txt', 'created by command');
  await fs.unlink(path.join(directory, 'deleted.txt'));
  await workspace.endTool(project, sessionId, 'changes');
  assert.equal(hashes.length, 2);
  assert.equal(hashes[1].ids.length, 2, 'only the edited and new file need hashing');
  await workspace.beginTool(project, sessionId, 'unchanged-again', 'bash', {});
  await workspace.endTool(project, sessionId, 'unchanged-again');
  assert.equal(hashes.length, 2, 'the next boundary reuses the new hashes');
  const preview = await workspace.checkpointPreview(project, sessionId, first.id);
  for (const name of ['command.txt', 'created.txt', 'deleted.txt'])
    assert.equal(preview.files.find((file) => file.path === name)?.selected, true, name);
  assert.equal(preview.files.find((file) => file.path === 'manual.txt')?.manual, true);

  const second = (await workspace.captureCheckpoint(project, sessionId, 2))!;
  assert.ok(
    hashes.some((call) => call.stored && call.ids.length === 3),
    JSON.stringify(hashes),
  );
  await toolWrite('created.txt', 'later edit');
  await toolWrite('manual.txt', 'later edit');
  await workspace.revert(project, ['created.txt', 'manual.txt'], undefined, {
    sessionId,
    checkpointId: second.id,
  });
  assert.equal(await fs.readFile(path.join(directory, 'created.txt'), 'utf8'), 'created by command');
  assert.equal(await fs.readFile(manualFile, 'utf8'), 'manual');
});

test('command scan caches survive alternating sessions', async (t) => {
  const { project, workspace, sessionId, write } = await fixture(t);
  const other = randomUUID();
  await write('shared.txt', 'unchanged');
  await workspace.captureCheckpoint(project, sessionId, 1);
  await workspace.captureCheckpoint(project, other, 1);
  const hashes = trackHashes(t);
  for (const id of [sessionId, other, sessionId]) {
    await workspace.beginTool(project, id, 'read-only', 'bash', {});
    await workspace.endTool(project, id, 'read-only');
  }
  assert.equal(hashes.length, 0);
});

test('workspace refresh returns checkpoint summaries using one Git status', async (t) => {
  const { root, project, workspace, sessionId, write } = await fixture(t);
  await write('shared.txt', 'before');
  const checkpoint = (await workspace.captureCheckpoint(project, sessionId, 1))!;
  const trace = path.join(root, 'git-trace.jsonl');
  const previous = process.env.GIT_TRACE2_EVENT;
  process.env.GIT_TRACE2_EVENT = trace.replaceAll('\\', '/');
  try {
    const value = await workspace.changes(project, 'all', { sessionId });
    assert.deepEqual(value.checkpoints, [checkpoint]);
  } finally {
    if (previous === undefined) delete process.env.GIT_TRACE2_EVENT;
    else process.env.GIT_TRACE2_EVENT = previous;
  }
  const events = (await fs.readFile(trace, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(events.filter((event) => event.event === 'start' && event.argv.includes('status')).length, 1);

  const missingGit = path.join(root, 'no-git');
  await fs.mkdir(missingGit);
  const unavailable = await workspace.changes({ ...project, path: missingGit }, 'all', { sessionId });
  assert.equal(unavailable.git, false);
  assert.equal(unavailable.checkpoints[0].id, checkpoint.id);
  assert.equal(unavailable.checkpoints[0].available, false);
  assert.match(unavailable.checkpoints[0].invalidReason!, /无法读取 Git 状态/);
});

test('three turns restore cumulatively while keeping preexisting changes and defaulting manual edits off', async (t) => {
  const { project, workspace, sessionId, write, toolWrite, directory } = await fixture(t);
  await write('before.txt', 'already modified before the run');
  const first = await workspace.captureCheckpoint(project, sessionId, 1, 100);
  assert.ok(first);
  await toolWrite('a.txt', 'first');
  await workspace.captureCheckpoint(project, sessionId, 2, 200);
  await toolWrite('b.txt', 'second');
  await write('manual.txt', 'human');
  await workspace.captureCheckpoint(project, sessionId, 3, 300);
  await toolWrite('c.txt', 'third');
  const preview = await workspace.checkpointPreview(project, sessionId, first.id);
  assert.deepEqual(
    preview.files
      .filter((file) => file.selected)
      .map((file) => file.path)
      .sort(),
    ['a.txt', 'b.txt', 'c.txt'],
  );
  assert.equal(preview.files.find((file) => file.path === 'manual.txt')?.manual, true);
  const removed: string[] = [];
  await workspace.revert(
    project,
    preview.files.filter((file) => file.selected).map((file) => file.path),
    async (file) => {
      removed.push(path.basename(file));
      await fs.rm(file);
    },
    { sessionId, checkpointId: first.id, revision: preview.revision },
  );
  assert.deepEqual(removed.sort(), ['a.txt', 'b.txt', 'c.txt']);
  assert.equal(await fs.readFile(path.join(directory, 'manual.txt'), 'utf8'), 'human');
  assert.equal(
    await fs.readFile(path.join(directory, 'before.txt'), 'utf8'),
    'already modified before the run',
  );
});

test('commands attribute only changes during their boundaries; later manual edits remain protected', async (t) => {
  const { project, workspace, sessionId, write } = await fixture(t);
  await write('test.txt', 'before');
  const first = (await workspace.captureCheckpoint(project, sessionId, 1))!;
  await write('manual.txt', 'outside command');
  await workspace.beginTool(project, sessionId, 'command', 'bash', { command: 'generate' });
  await write('test.txt', 'by command');
  await write('generated.txt', 'new by command');
  await workspace.endTool(project, sessionId, 'command');
  let preview = await workspace.checkpointPreview(project, sessionId, first.id);
  assert.equal(preview.files.find((file) => file.path === 'generated.txt')?.manual, false);
  assert.equal(preview.files.find((file) => file.path === 'manual.txt')?.manual, true);
  await write('test.txt', 'manual after command');
  preview = await workspace.checkpointPreview(project, sessionId, first.id);
  assert.equal(preview.files.find((file) => file.path === 'test.txt')?.selected, false);
});

test('overlapping tools from different chats protect ambiguous files from automatic undo', async (t) => {
  const { project, workspace, sessionId, write, data, directory } = await fixture(t);
  const other = randomUUID();
  const first = (await workspace.captureCheckpoint(project, sessionId, 1))!;
  const second = (await workspace.captureCheckpoint(project, other, 1))!;
  await workspace.beginTool(project, sessionId, 'shell-A', 'bash', { command: 'work in A' });
  await workspace.beginTool(project, other, 'write-B', 'write', { path: 'b.txt' });
  await write('b.txt', 'B must be preserved');
  await workspace.endTool(project, other, 'write-B');
  await write('a.txt', 'A wrote this while B was running');
  await workspace.endTool(project, sessionId, 'shell-A');
  const reopened = new Workspace(data);
  for (const [id, checkpoint] of [
    [sessionId, first],
    [other, second],
  ] as const) {
    const preview = await reopened.checkpointPreview(project, id, checkpoint.id);
    const b = preview.files.find((file) => file.path === 'b.txt');
    assert.ok(b);
    assert.equal(b.manual, true);
    assert.equal(b.selected, false);
  }
  assert.equal(await fs.readFile(path.join(directory, 'b.txt'), 'utf8'), 'B must be preserved');
});

test('confirmed termination clears old tool boundaries without claiming partial writes', async (t) => {
  const { project, workspace, sessionId, write } = await fixture(t);
  const first = (await workspace.captureCheckpoint(project, sessionId, 1))!;
  await workspace.beginTool(project, sessionId, 'stopped-shell', 'bash', { command: 'partial work' });
  await write('partial.txt', 'incomplete');
  await workspace.endSessionTools(project, sessionId);
  const partial = await workspace.checkpointPreview(project, sessionId, first.id);
  assert.equal(partial.files.find((file) => file.path === 'partial.txt')?.selected, false);
  const other = randomUUID();
  const second = (await workspace.captureCheckpoint(project, other, 1))!;
  await workspace.beginTool(project, other, 'later-write', 'write', { path: 'later.txt' });
  await write('later.txt', 'normal later work');
  await workspace.endTool(project, other, 'later-write');
  const preview = await workspace.checkpointPreview(project, other, second.id);
  assert.equal(preview.files.find((file) => file.path === 'later.txt')?.selected, true);
});

test('commit keeps checkpoints usable; switching branch permanently invalidates previous checkpoints', async (t) => {
  const { project, workspace, sessionId, write, toolWrite, git, directory } = await fixture(t);
  await write('a.txt', 'original');
  await git(['add', '.']);
  await git(['commit', '-m', 'initial']);
  const first = (await workspace.captureCheckpoint(project, sessionId, 1))!;
  await toolWrite('a.txt', 'committed update');
  await git(['add', '.']);
  await git(['commit', '-m', 'changed']);
  const preview = await workspace.checkpointPreview(project, sessionId, first.id);
  assert.equal(preview.available, true);
  assert.equal(preview.includesCommitted, true);
  await workspace.revert(project, ['a.txt'], undefined, {
    sessionId,
    checkpointId: first.id,
    revision: preview.revision,
  });
  assert.equal(await fs.readFile(path.join(directory, 'a.txt'), 'utf8'), 'original');
  assert.match((await git(['status', '--porcelain'])).stdout, /M a.txt/);
  await git(['checkout', '-b', 'another']);
  assert.equal((await workspace.listCheckpoints(project, sessionId))[0].available, false);
  await git(['checkout', 'main']);
  assert.equal((await workspace.listCheckpoints(project, sessionId))[0].available, false);
});

test('a changed confirmation revision refuses every write and a new Workspace preserves turn identities', async (t) => {
  const { project, workspace, sessionId, write, toolWrite, directory, data } = await fixture(t);
  await write('a.txt', 'before');
  const first = (await workspace.captureCheckpoint(project, sessionId, 1))!;
  await workspace.bindCheckpoint(project, sessionId, first.id, 1234);
  await toolWrite('a.txt', 'Pi edit');
  const preview = await workspace.checkpointPreview(project, sessionId, first.id);
  await write('a.txt', 'new external edit');
  await assert.rejects(
    workspace.revert(project, ['a.txt'], undefined, {
      sessionId,
      checkpointId: first.id,
      revision: preview.revision,
    }),
    /文件又有变化/,
  );
  assert.equal(await fs.readFile(path.join(directory, 'a.txt'), 'utf8'), 'new external edit');
  const reopened = new Workspace(data);
  assert.equal(await reopened.nextCheckpointTurn(sessionId), 2);
  assert.equal((await reopened.listCheckpoints(project, sessionId))[0].timestamp, 1234);
});

test('twenty-turn retention shares one object store and does not reset the monotonic turn counter', async (t) => {
  const { project, workspace, sessionId, write, data, directory } = await fixture(t);
  const other = randomUUID();
  await write('a.txt', 'other session');
  await workspace.captureCheckpoint(project, other, 1);
  await write('a.txt', 'first turn');
  await workspace.captureCheckpoint(project, sessionId, 1);
  await write('a.txt', 'shared bytes');
  for (let turn = 2; turn <= 20; turn++)
    await workspace.captureCheckpoint(project, sessionId, turn, turn * 100);
  const reads = trackStorageReads(t, data);
  for (let turn = 21; turn <= 23; turn++)
    await workspace.captureCheckpoint(project, sessionId, turn, turn * 100);
  assert.equal(
    reads.filter((call) => call.file.includes(other)).length,
    0,
    'idle sessions are not reread or scanned',
  );
  assert.equal(
    reads.filter((call) => call.method === 'readdir' && call.file === path.join(data, 'baselines')).length,
    0,
    'ordinary captures do not traverse all snapshot storage',
  );
  t.diagnostic(
    `Three retained-turn captures: ${reads.filter((call) => call.method === 'stat').length} storage stats; no reads from the idle session`,
  );
  const checkpoints = await workspace.listCheckpoints(project, sessionId);
  assert.equal(checkpoints.length, 20);
  assert.equal(checkpoints[0].turn, 4);
  assert.equal(await workspace.nextCheckpointTurn(sessionId), 24);
  const names = await fs.readdir(path.join(data, 'baselines', 'checkpoints'));
  assert.equal(names.filter((name) => name.endsWith('.git')).length, 2);
  assert.equal(names.includes(`${sessionId}-1.json`), false);
  await write('a.txt', 'later change');
  await new Workspace(data).revert(project, ['a.txt'], undefined, {
    sessionId,
    checkpointId: checkpoints[0].id,
  });
  assert.equal(await fs.readFile(path.join(directory, 'a.txt'), 'utf8'), 'shared bytes');
});

test('global retention runs after ten minutes, on explicit cleanup and after reopen', async (t) => {
  const { project, workspace, sessionId, write, data } = await fixture(t);
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const old = randomUUID();
  await write('a.txt', 'retained bytes');
  await workspace.captureCheckpoint(project, old, 1);
  now += 7 * 86400000 - 5 * 60000;
  await workspace.captureCheckpoint(project, sessionId, 1);
  const reads = trackStorageReads(t, data);
  const globalScans = () =>
    reads.filter((call) => call.method === 'readdir' && call.file === path.join(data, 'baselines')).length;
  now += 9 * 60000;
  await workspace.captureCheckpoint(project, sessionId, 2);
  assert.equal(globalScans(), 0);
  now += 60000;
  await workspace.captureCheckpoint(project, sessionId, 3);
  assert.ok(globalScans() > 0);
  assert.equal(
    (await workspace.listCheckpoints(project, old)).length,
    0,
    'the global sweep removes expired sessions',
  );
  assert.equal((await workspace.listCheckpoints(project, sessionId)).length, 3);
  reads.length = 0;
  await workspace.cleanup();
  assert.ok(globalScans() > 0, 'explicit cleanup is never throttled');
  reads.length = 0;
  await new Workspace(data).captureCheckpoint(project, sessionId, 4);
  assert.ok(globalScans() > 0, 'a new process reconciles existing storage');
});

test('quota counts new compressed objects once and evicts old sessions without rescanning storage', async (t) => {
  const { project, workspace, sessionId, write, data, directory, git } = await fixture(t);
  await write('a.txt', 'old session');
  for (let turn = 1; turn <= 3; turn++) await workspace.captureCheckpoint(project, sessionId, turn);
  const repo = path.join(data, 'baselines', 'checkpoints', `session-${sessionId}-objects.git`);
  const padding = await padSnapshot(repo, 198 * 1024 * 1024);
  const reopened = new Workspace(data);
  await reopened.cleanup();
  const shared = randomBytes(1024 * 1024);
  await fs.writeFile(path.join(directory, 'shared-1.bin'), shared);
  await fs.writeFile(path.join(directory, 'shared-2.bin'), shared);
  await fs.writeFile(path.join(directory, 'committed.bin'), randomBytes(3 * 1024 * 1024));
  await git(['add', 'committed.bin']);
  await git(['commit', '-m', 'shared Git object']);
  const current = randomUUID();
  const first = (await reopened.captureCheckpoint(project, current, 1))!;
  assert.equal(
    (await reopened.listCheckpoints(project, sessionId)).length,
    3,
    'duplicate and alternate objects must not cause premature eviction',
  );
  const reads = trackStorageReads(t, data);
  await fs.writeFile(path.join(directory, 'new.bin'), randomBytes(2 * 1024 * 1024));
  await reopened.captureCheckpoint(project, current, 2);
  assert.equal(
    (await reopened.listCheckpoints(project, sessionId)).length,
    0,
    'new objects trigger quota enforcement before ten minutes',
  );
  assert.equal((await reopened.listCheckpoints(project, current)).length, 2);
  assert.equal(
    reads.filter((call) => call.method === 'stat' && call.file === padding).length,
    1,
    'all three old turns are evicted using one storage scan',
  );
  assert.ok((await snapshotStorageBytes(path.join(data, 'baselines'))) <= 200 * 1024 * 1024);
  await write('shared-1.bin', 'later change');
  await new Workspace(data).revert(project, ['shared-1.bin'], undefined, {
    sessionId: current,
    checkpointId: first.id,
  });
  assert.deepEqual(await fs.readFile(path.join(directory, 'shared-1.bin')), shared);
});

test('an oversized checkpoint is rejected without changing project files or resetting its turn counter', async (t) => {
  const { project, workspace, sessionId, write, data, directory } = await fixture(t);
  await write('a.txt', 'before');
  await workspace.captureCheckpoint(project, sessionId, 1);
  await padSnapshot(
    path.join(data, 'baselines', 'checkpoints', `session-${sessionId}-objects.git`),
    199 * 1024 * 1024,
  );
  const reopened = new Workspace(data);
  await reopened.cleanup();
  const content = randomBytes(2 * 1024 * 1024);
  await fs.writeFile(path.join(directory, 'new.bin'), content);
  await assert.rejects(reopened.captureCheckpoint(project, sessionId, 2), /超过 200 MiB/);
  assert.equal((await reopened.listCheckpoints(project, sessionId)).length, 0);
  assert.equal(await reopened.nextCheckpointTurn(sessionId), 3);
  assert.deepEqual(await fs.readFile(path.join(directory, 'new.bin')), content);
  assert.equal(await fs.readFile(path.join(directory, 'a.txt'), 'utf8'), 'before');
});

test('failed checkpoint writes force storage reconciliation before the next capture succeeds', async (t) => {
  const { project, workspace, sessionId, write, data } = await fixture(t);
  await write('a.txt', 'before');
  const other = randomUUID();
  await workspace.captureCheckpoint(project, other, 1);
  await workspace.captureCheckpoint(project, sessionId, 1);
  await write('a.txt', 'changed');
  const rename = fs.rename;
  const failure = t.mock.method(fs, 'rename', async (...args: Parameters<typeof rename>) => {
    if (String(args[1]).endsWith(`${sessionId}-2.json`))
      throw new Error('simulated checkpoint write failure');
    return rename(...args);
  });
  await assert.rejects(
    workspace.captureCheckpoint(project, sessionId, 2),
    /simulated checkpoint write failure/,
  );
  failure.mock.restore();
  const reads = trackStorageReads(t, data);
  await workspace.captureCheckpoint(project, sessionId, 2);
  assert.ok(reads.some((call) => call.method === 'stat' && call.file.includes(other)));
  reads.length = 0;
  await workspace.captureCheckpoint(project, sessionId, 3);
  assert.equal(reads.filter((call) => call.file.includes(other)).length, 0);
});

test('retention never interprets a malformed stored blob id as a filesystem path', async (t) => {
  const { project, workspace, sessionId, write, data } = await fixture(t);
  await write('a.txt', 'retained content');
  await workspace.captureCheckpoint(project, sessionId, 1);
  const checkpoints = path.join(data, 'baselines', 'checkpoints');
  const record = JSON.parse(await fs.readFile(path.join(checkpoints, `${sessionId}-1.json`), 'utf8'));
  const repo = path.join(checkpoints, record.repo);
  const unrelated = path.join(data, 'keep.txt');
  await fs.writeFile(unrelated, 'unrelated application data');
  const invalid = '../' + path.relative(repo, unrelated);
  assert.equal(path.join(repo, 'objects', invalid.slice(0, 2), invalid.slice(2)), unrelated);
  for (let turn = 1; turn <= 20; turn++)
    await fs.writeFile(
      path.join(checkpoints, `${sessionId}-${turn}.json`),
      JSON.stringify({
        ...record,
        id: `${sessionId}-${turn}`,
        turn,
        files: turn === 1 ? { 'a.txt': invalid } : record.files,
      }),
    );
  const reopened = new Workspace(data);
  await reopened.cleanup();
  await reopened.captureCheckpoint(project, sessionId, 21);
  assert.equal(await fs.readFile(unrelated, 'utf8'), 'unrelated application data');
  assert.equal((await reopened.listCheckpoints(project, sessionId))[0].turn, 2);
});

test('legacy project baseline remains available before a session has its own checkpoint', async (t) => {
  const { project, workspace, sessionId, write } = await fixture(t);
  await write('a.txt', 'before');
  await workspace.capture(project);
  await write('a.txt', 'after');
  const changes = await workspace.changes(project, 'run', { sessionId });
  assert.equal(changes.baselineAvailable, true);
  assert.equal(changes.files[0].path, 'a.txt');
});

test('parallel tool completions serialize attribution updates and preserve all twelve paths', async (t) => {
  const { project, workspace, sessionId, write, data } = await fixture(t);
  const first = (await workspace.captureCheckpoint(project, sessionId, 1))!;
  const names = Array.from({ length: 12 }, (_, index) => `parallel-${index}.txt`);
  await Promise.all(
    names.map((name) => workspace.beginTool(project, sessionId, name, 'write', { path: name })),
  );
  await Promise.all(names.map((name) => write(name, name)));
  const completed = await Promise.allSettled(
    names.map((name) => workspace.endTool(project, sessionId, name)),
  );
  assert.ok(
    completed.every((result) => result.status === 'fulfilled'),
    JSON.stringify(completed),
  );
  const preview = await new Workspace(data).checkpointPreview(project, sessionId, first.id);
  assert.equal(preview.files.length, 12);
  assert.ok(preview.files.every((file) => file.selected && !file.manual));
});

test('switching away and back between observations still invalidates checkpoints', async (t) => {
  const { project, workspace, sessionId, write, git, data } = await fixture(t);
  await write('a.txt', 'original');
  await git(['add', '.']);
  await git(['commit', '-m', 'initial']);
  await workspace.captureCheckpoint(project, sessionId, 1);
  await git(['checkout', '-b', 'temporary']);
  await git(['checkout', 'main']);
  const checkpoints = await new Workspace(data).listCheckpoints(project, sessionId);
  assert.equal(checkpoints[0].available, false);
  assert.match(checkpoints[0].invalidReason!, /分支已切换/);
});

test('private index preserves raw line endings despite project text attributes and survives reopen', async (t) => {
  const { project, workspace, sessionId, write, git, data, directory } = await fixture(t);
  await git(['config', 'core.autocrlf', 'true']);
  await write('.gitattributes', '*.txt text eol=crlf\n');
  await write('raw.txt', 'first\r\nsecond\r\n');
  await fs.writeFile(path.join(directory, 'bytes.bin'), Buffer.from([0, 255, 1]));
  await workspace.captureCheckpoint(project, sessionId, 1);
  await write('raw.txt', 'first\nsecond\n');
  await fs.writeFile(path.join(directory, 'bytes.bin'), Buffer.from([0, 128, 2]));
  const second = (await workspace.captureCheckpoint(project, sessionId, 2))!;
  await write('raw.txt', 'later\r\n');
  await fs.writeFile(path.join(directory, 'bytes.bin'), Buffer.from([4]));
  await workspace.revert(project, ['raw.txt', 'bytes.bin'], undefined, {
    sessionId,
    checkpointId: second.id,
  });
  assert.equal(await fs.readFile(path.join(directory, 'raw.txt'), 'utf8'), 'first\nsecond\n');
  assert.deepEqual(await fs.readFile(path.join(directory, 'bytes.bin')), Buffer.from([0, 128, 2]));
  const reopened = new Workspace(data);
  assert.ok(await reopened.captureCheckpoint(project, sessionId, 3));
});

test('replacing an unchanged directory with a junction cannot reuse an unsafe cached path', async (t) => {
  const { project, workspace, sessionId, root, directory, write, git } = await fixture(t);
  await fs.mkdir(path.join(directory, 'src'));
  await write('src/a.txt', 'unchanged bytes and timestamps');
  await git(['add', '.']);
  await git(['commit', '-m', 'tracked directory']);
  await workspace.captureCheckpoint(project, sessionId, 1);
  const original = path.join(root, 'original-src');
  await fs.rename(path.join(directory, 'src'), original);
  try {
    await fs.symlink(
      original,
      path.join(directory, 'src'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') {
      t.skip('symlink creation requires privileges');
      return;
    }
    throw error;
  }
  await assert.rejects(workspace.beginTool(project, sessionId, 'unsafe', 'bash', {}), /部分文件无法读取/);
  const second = (await workspace.captureCheckpoint(project, sessionId, 2))!;
  const changes = await workspace.changes(project, 'run', { sessionId, checkpointId: second.id });
  assert.ok(changes.omitted.includes('src') || changes.omitted.includes('src/a.txt'));
  assert.equal(await fs.readFile(path.join(original, 'a.txt'), 'utf8'), 'unchanged bytes and timestamps');
});

test(
  'checkpoint permissions preserve all POSIX mode bits',
  { skip: process.platform === 'win32' },
  async (t) => {
    const { project, workspace, sessionId, directory, write } = await fixture(t);
    const file = path.join(directory, 'private.sh');
    await write('private.sh', '#!/bin/sh\n');
    await fs.chmod(file, 0o700);
    await workspace.captureCheckpoint(project, sessionId, 1);
    await fs.chmod(file, 0o600);
    const second = (await workspace.captureCheckpoint(project, sessionId, 2))!;
    await fs.chmod(file, 0o755);
    await workspace.revert(project, ['private.sh'], undefined, { sessionId, checkpointId: second.id });
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  },
);
