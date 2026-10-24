import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { allFiles, git, info, Workspace } from '../electron/workspace';
import type { Project } from '../shared/types';

test('untrusted workspace operations never run a repository-configured clean filter', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-untrusted-git-'));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 3 }));
  const directory = path.join(root, 'project');
  await fs.mkdir(directory);
  const exec = promisify(execFile);
  const setupGit = (...args: string[]) => exec('git', args, { cwd: directory, windowsHide: true });
  await setupGit('init', '-b', 'main');
  await setupGit('config', 'user.name', 'Trust Test');
  await setupGit('config', 'user.email', 'trust@example.invalid');
  await fs.writeFile(path.join(directory, 'tracked.txt'), 'before');
  await setupGit('add', 'tracked.txt');
  await setupGit('-c', 'core.hooksPath=', '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture');
  await setupGit('config', 'filter.boundary.clean', 'echo executed > approval-filter-ran.txt; cat');
  await fs.writeFile(path.join(directory, '.gitattributes'), 'tracked.txt filter=boundary\n');
  // Keep the indexed size: otherwise status can report a change from stat alone
  // without hashing content through the clean filter.
  await fs.writeFile(path.join(directory, 'tracked.txt'), 'after!');
  await fs.utimes(path.join(directory, 'tracked.txt'), new Date(), new Date(Date.now() + 2000));

  const project: Project = {
    id: randomUUID(),
    name: 'untrusted',
    path: await fs.realpath(directory),
    trusted: false,
    createdAt: 1,
  };
  const workspace = new Workspace(path.join(root, 'data'));
  const sessionId = randomUUID();
  const marker = path.join(directory, 'approval-filter-ran.txt');
  const changes = await workspace.changes(project);
  assert.match(changes.error!, /信任/);
  assert.deepEqual(changes.files, []);
  await assert.rejects(git(project, ['status', '--porcelain']), /信任/);
  await assert.rejects(info(project), /信任/);
  await assert.rejects(workspace.diff(project, 'tracked.txt', 'all'), /信任/);
  await assert.rejects(workspace.revert(project, ['tracked.txt']), /信任/);
  assert.equal(await workspace.capture(project), undefined);
  assert.equal(await workspace.captureCheckpoint(project, sessionId, 1), undefined);
  assert.deepEqual(await workspace.listCheckpoints(project, sessionId), []);
  assert.ok(
    (await allFiles(project)).includes('tracked.txt'),
    'untrusted file search uses directory traversal',
  );
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' });

  // Prove the fixture exercises a real execution path, rather than a harmless config.
  project.trusted = true;
  const trusted = await workspace.changes(project);
  assert.equal(trusted.git, true);
  assert.ok(trusted.files.some((file) => file.path === 'tracked.txt'));
  assert.match(await fs.readFile(marker, 'utf8'), /executed/);
});
