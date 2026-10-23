import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { isWindows, loadLoginShellPath } from './platform';

/**
 * Run snapshots stored as Git blobs in a private bare repository under the app data directory.
 * Its `alternates` point at the project's object store, so files already known to the project cost
 * nothing to snapshot. The project's own `.git` is only read: no objects, refs, stash or index change.
 */
async function git(args: string[], cwd: string, input?: string) {
  await loadLoginShellPath();
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn('git', ['-c', 'core.fsmonitor=false', '-c', 'core.quotepath=false', ...args], {
      cwd,
      windowsHide: true,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
    });
    const out: Buffer[] = [],
      err: Buffer[] = [];
    child.stdout!.on('data', (d) => out.push(d));
    child.stderr!.on('data', (d) => err.push(d));
    child.once('error', reject);
    child.once('close', (code) =>
      code === 0
        ? resolve(Buffer.concat(out))
        : reject(new Error(Buffer.concat(err).toString('utf8').trim() || `git ${args[0]} 失败`)),
    );
    if (input !== undefined) {
      // A failing git exits before reading; the exit code carries the real error.
      child.stdin!.on('error', () => {});
      child.stdin!.end(input);
    }
  });
}
const lines = (b: Buffer) => b.toString('utf8').trim().split('\n').filter(Boolean);

export async function createSnapshotRepo(repo: string, projectRoot: string) {
  await fs.mkdir(repo, { recursive: true, mode: 0o700 });
  const format = (await git(['rev-parse', '--show-object-format'], projectRoot)).toString('utf8').trim();
  await git(['init', '--bare', '-q', '--object-format=' + format, repo], projectRoot);
  if (process.platform !== 'win32') await fs.chmod(repo, 0o700);
  const objects = (await git(['rev-parse', '--path-format=absolute', '--git-path', 'objects'], projectRoot))
    .toString('utf8')
    .trim();
  await fs.writeFile(path.join(repo, 'objects', 'info', 'alternates'), objects + '\n');
  // Snapshot index comparisons must use raw bytes, regardless of project/global attributes.
  await fs.writeFile(
    path.join(repo, 'info', 'attributes'),
    '* -text -filter -ident -working-tree-encoding\n',
  );
}
const indexArgs = (repo: string, projectRoot: string) => [
  '--git-dir',
  repo,
  '--work-tree',
  projectRoot,
  '-c',
  'core.autocrlf=false',
  '-c',
  'core.symlinks=true',
  '-c',
  `core.filemode=${isWindows ? 'false' : 'true'}`,
];

export async function changedSnapshotFiles(repo: string, projectRoot: string) {
  return (
    await git(
      [...indexArgs(repo, projectRoot), 'diff-files', '--name-only', '-z', '--no-renames'],
      projectRoot,
    )
  )
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
}

/** The index is private to snapshots; the project's index, refs and objects remain untouched. */
export async function updateSnapshotIndex(
  repo: string,
  projectRoot: string,
  files: { name: string; id: string; mode: number }[],
  removed: { name: string; id: string }[],
  reset = false,
) {
  if (reset) await git([...indexArgs(repo, projectRoot), 'read-tree', '--empty'], projectRoot);
  const entries = [
    ...removed.map((file) => `0 ${file.id}\t${file.name}\0`),
    ...files.map(
      (file) => `${!isWindows && file.mode & 0o111 ? '100755' : '100644'} ${file.id}\t${file.name}\0`,
    ),
  ];
  if (entries.length)
    await git(
      [...indexArgs(repo, projectRoot), 'update-index', '-z', '--index-info'],
      projectRoot,
      entries.join(''),
    );
  await git([...indexArgs(repo, projectRoot), 'update-index', '--refresh'], projectRoot);
}
// --stdin-paths accepts Git's C-quoted path format, not raw leading quotes or backslashes.
const quotePath = (name: string) =>
  '"' +
  name.replace(/[\\"\x00-\x1f]/g, (char) =>
    char === '\\' || char === '"' ? '\\' + char : '\\' + char.charCodeAt(0).toString(8).padStart(3, '0'),
  ) +
  '"';
/** Store files exactly as they are on disk (no filters, no line-ending conversion). */
export async function storeBlobs(repo: string, projectRoot: string, names: string[]) {
  if (!names.length) return [];
  const ids = lines(
    await git(
      ['--git-dir', repo, 'hash-object', '-w', '--no-filters', '--stdin-paths'],
      projectRoot,
      names.map((name) => quotePath(path.resolve(projectRoot, name))).join('\n') + '\n',
    ),
  );
  if (ids.length !== names.length) throw new Error('快照写入不完整');
  return ids;
}
export async function hashBlobs(projectRoot: string, names: string[]) {
  if (!names.length) return [];
  // Git may switch to the repository root; stdin paths must still refer to the opened project.
  const ids = lines(
    await git(
      ['hash-object', '--no-filters', '--stdin-paths'],
      projectRoot,
      names.map((name) => quotePath(path.resolve(projectRoot, name))).join('\n') + '\n',
    ),
  );
  if (ids.length !== names.length) throw new Error('无法读取当前文件');
  return ids;
}
export async function readBlob(repo: string, projectRoot: string, id: string) {
  try {
    return await git(['--git-dir', repo, 'cat-file', 'blob', id], projectRoot);
  } catch {
    throw new Error('快照内容已不存在（可能已被 Git 清理），无法撤销这个文件');
  }
}
