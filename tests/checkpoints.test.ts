import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Workspace } from '../electron/workspace';
import type { Project } from '../shared/types';

const exec = promisify(execFile);
async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-checkpoints-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
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
  const { project, workspace, sessionId, write, data } = await fixture(t);
  await write('a.txt', 'shared bytes');
  for (let turn = 1; turn <= 21; turn++)
    await workspace.captureCheckpoint(project, sessionId, turn, turn * 100);
  const checkpoints = await workspace.listCheckpoints(project, sessionId);
  assert.equal(checkpoints.length, 20);
  assert.equal(checkpoints[0].turn, 2);
  assert.equal(await workspace.nextCheckpointTurn(sessionId), 22);
  const names = await fs.readdir(path.join(data, 'baselines', 'checkpoints'));
  assert.equal(names.filter((name) => name.endsWith('.git')).length, 1);
  assert.equal(names.includes(`${sessionId}-1.json`), false);
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
