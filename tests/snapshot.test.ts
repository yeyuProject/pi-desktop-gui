import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Workspace } from '../electron/workspace';
import { createSnapshotRepo, hashBlobs, readBlob, storeBlobs } from '../electron/snapshot';
import type { Project } from '../shared/types';

const exec = promisify(execFile);
async function fixture(t: TestContext, format = 'sha1') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-snapshot-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectDir = path.join(root, 'project');
  const data = path.join(root, 'data');
  await fs.mkdir(projectDir);
  await exec('git', ['init', '--object-format=' + format, projectDir], { windowsHide: true });
  const project: Project = {
    id: randomUUID(),
    name: 'snapshot',
    path: projectDir,
    trusted: true,
    createdAt: Date.now(),
  };
  return { project, data, workspace: new Workspace(data) };
}

for (const samePathInParent of [false, true]) {
  test(`nested projects hash and store their own files with parent duplicates=${samePathInParent}`, async (t) => {
    const { project, data } = await fixture(t);
    const projectRoot = path.join(project.path, '子项目 with spaces');
    const names = ['docs/CFS2号上传操作教程.md', 'docs/截图 教程.docx'];
    const contents = [Buffer.from('项目内的教程\r\n'), Buffer.from([0x50, 0x4b, 0, 0xff, 0x0d, 0x0a])];
    await fs.mkdir(path.join(projectRoot, 'docs'), { recursive: true });
    if (samePathInParent) await fs.mkdir(path.join(project.path, 'docs'));
    for (const [index, name] of names.entries()) {
      await fs.writeFile(path.join(projectRoot, name), contents[index]);
      if (samePathInParent) await fs.writeFile(path.join(project.path, name), 'unrelated parent file');
    }
    const expected = contents.map((content) =>
      createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex'),
    );
    assert.deepEqual(await hashBlobs(projectRoot, names), expected);
    const repo = path.join(data, 'objects.git');
    await createSnapshotRepo(repo, projectRoot);
    assert.deepEqual(await storeBlobs(repo, projectRoot, names), expected);
    for (const [index, id] of expected.entries())
      assert.deepEqual(await readBlob(repo, projectRoot, id), contents[index]);
  });
}

test('SHA-256 projects have no phantom changes and restore their baseline', async (t) => {
  const { project, workspace } = await fixture(t, 'sha256');
  const file = path.join(project.path, 'file.txt');
  await fs.writeFile(file, 'original');
  await workspace.capture(project);
  assert.deepEqual((await workspace.changes(project, 'run')).files, []);
  await fs.writeFile(file, 'changed');
  await workspace.revert(project, null);
  assert.equal(await fs.readFile(file, 'utf8'), 'original');
});

test(
  'permission-only changes can be undone without broadening the original permissions',
  { skip: process.platform === 'win32' },
  async (t) => {
    const { project, workspace } = await fixture(t);
    const file = path.join(project.path, 'private.sh');
    await fs.writeFile(file, '#!/bin/sh\n', { mode: 0o700 });
    await workspace.capture(project);
    await fs.chmod(file, 0o600);
    assert.deepEqual(
      (await workspace.changes(project, 'run')).files.map((f) => f.path),
      ['private.sh'],
    );
    await workspace.revert(project, null);
    assert.equal((await fs.stat(file)).mode & 0o777, 0o700);
  },
);

test(
  'quoted POSIX file names are snapshotted without breaking the whole batch',
  { skip: process.platform === 'win32' },
  async (t) => {
    const { project, workspace } = await fixture(t);
    const file = path.join(project.path, '"quoted.txt');
    await fs.writeFile(file, 'original');
    await workspace.capture(project);
    await fs.writeFile(file, 'changed');
    await workspace.revert(project, null);
    assert.equal(await fs.readFile(file, 'utf8'), 'original');
  },
);

test('undo refuses an incomplete change scan before touching any files', async (t) => {
  const { project, workspace } = await fixture(t);
  const original = path.join(project.path, 'original.txt');
  const added = path.join(project.path, 'added.txt');
  await fs.writeFile(original, 'before');
  await workspace.capture(project);
  await fs.writeFile(original, 'after');
  await fs.writeFile(added, 'new');
  const changes = await workspace.changes(project, 'run');
  workspace.changes = async () => ({ ...changes, error: 'file changed during scan' });
  await assert.rejects(workspace.revert(project, null), /file changed during scan/);
  assert.equal(await fs.readFile(original, 'utf8'), 'after');
  assert.equal(await fs.readFile(added, 'utf8'), 'new');
});

test('snapshot quota counts the object repository and invalidates an evicted baseline', async (t) => {
  const { project, workspace, data } = await fixture(t);
  await fs.writeFile(path.join(project.path, 'file.txt'), 'before');
  await workspace.capture(project);
  const baselineFile = path.join(data, 'baselines', project.id + '.json');
  const baseline = JSON.parse(await fs.readFile(baselineFile, 'utf8'));
  const repo = path.join(data, 'baselines', baseline.repo);
  if (process.platform !== 'win32') assert.equal((await fs.stat(repo)).mode & 0o777, 0o700);
  const largeObject = await fs.open(path.join(repo, 'objects', 'quota-probe'), 'w');
  try {
    await largeObject.truncate(201 * 1024 * 1024);
  } finally {
    await largeObject.close();
  }
  await workspace.cleanup();
  assert.equal((await workspace.changes(project, 'run')).baselineAvailable, false);
  await assert.rejects(fs.stat(repo));
  assert.equal(await fs.readFile(path.join(project.path, 'file.txt'), 'utf8'), 'before');
});
