import nodeFs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { compareAppVersions, stableVersion } from '../shared/app-update';
import { UpdateAttemptFile } from './update-attempt';

const exec = promisify(execFile);
// Electron's patched fs sees app.asar as a directory. Bundle traversal, hashing and
// cleanup must operate on real files; only reading our packaged helpers uses ASAR support.
const rawFs: typeof nodeFs = process.versions.electron
  ? createRequire(process.execPath)('original-fs')
  : nodeFs;
const fs = rawFs.promises;
const { constants, createReadStream } = rawFs;
export class MacUpdateError extends Error {}
export interface MacUpdatePlan {
  directory: string;
  target: string;
  candidate: string;
  bundleId: string;
  executable: string;
  arch: string;
  currentVersion: string;
  targetVersion: string;
  originalInode: number;
  originalDevice: number;
  originalAsar: string;
  candidateAsar: string;
  team?: string;
  requirement?: string;
  receiptDirectory: string;
}

async function digest(file: string) {
  const hash = createHash('sha512');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function realDirectory(directory: string) {
  if (!(await fs.lstat(directory)).isDirectory() || (await fs.realpath(directory)) !== directory)
    throw new MacUpdateError('更新目录已变化或包含符号链接，请重新下载更新。');
}
async function removeTree(directory: string) {
  for (const name of await fs.readdir(directory)) {
    const file = path.join(directory, name);
    if ((await fs.lstat(file)).isDirectory()) await removeTree(file);
    else await fs.unlink(file);
  }
  await fs.rmdir(directory);
}
async function info(app: string) {
  const { stdout } = await exec('/usr/bin/plutil', [
    '-convert',
    'json',
    '-o',
    '-',
    path.join(app, 'Contents/Info.plist'),
  ]);
  return JSON.parse(stdout) as Record<string, string>;
}
async function signature(app: string) {
  try {
    await exec('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { timeout: 60000 });
  } catch {
    throw new MacUpdateError('Mac 应用签名校验失败，已取消更新。请下载完整安装包覆盖安装。');
  }
  const { stderr } = await exec('/usr/bin/codesign', ['-dvv', app]);
  const team = /^TeamIdentifier=(.+)$/m.exec(stderr)?.[1];
  return team && team !== 'not set' ? team : undefined;
}
async function checkCandidate(plan: MacUpdatePlan) {
  await realDirectory(plan.candidate);
  const metadata = await info(plan.candidate);
  if (
    metadata.CFBundleIdentifier !== plan.bundleId ||
    metadata.CFBundleShortVersionString !== plan.targetVersion ||
    metadata.CFBundleExecutable !== plan.executable
  )
    throw new MacUpdateError('更新包的应用标识或版本不匹配，已取消安装。');
  const { stdout } = await exec('/usr/bin/lipo', [
    '-archs',
    path.join(plan.candidate, 'Contents/MacOS', plan.executable),
  ]);
  const arch = plan.arch === 'x64' ? 'x86_64' : plan.arch;
  if (!stdout.trim().split(/\s+/).includes(arch)) throw new MacUpdateError('更新包与当前 Mac 架构不匹配。');
  const team = await signature(plan.candidate);
  if (plan.team && team !== plan.team) throw new MacUpdateError('更新包的开发者签名不匹配，已取消安装。');
  if (plan.team) {
    if (!plan.requirement) throw new MacUpdateError('无法验证当前应用的开发者签名要求。');
    try {
      await exec('/usr/bin/codesign', ['--verify', '--strict', '-R', plan.requirement, plan.candidate]);
    } catch {
      throw new MacUpdateError('更新包未满足当前应用的开发者签名要求，已取消安装。');
    }
  }
  if ((await digest(path.join(plan.candidate, 'Contents/Resources/app.asar'))) !== plan.candidateAsar)
    throw new MacUpdateError('更新文件 hash mismatch，已取消安装。');
}
async function checkTarget(plan: MacUpdatePlan) {
  await realDirectory(plan.target);
  const stat = await fs.stat(plan.target);
  const metadata = await info(plan.target);
  if (
    stat.ino !== plan.originalInode ||
    stat.dev !== plan.originalDevice ||
    metadata.CFBundleIdentifier !== plan.bundleId ||
    metadata.CFBundleShortVersionString !== plan.currentVersion ||
    (await digest(path.join(plan.target, 'Contents/Resources/app.asar'))) !== plan.originalAsar
  )
    throw new MacUpdateError('当前应用已被其他更新替换，已取消本次安装。');
  await fs.access(path.dirname(plan.target), constants.W_OK);
}

async function cleanOlderBackups(plan: MacUpdatePlan) {
  for (const name of await fs.readdir(path.dirname(plan.target))) {
    if (!name.startsWith('.pi-desktop-update-')) continue;
    const directory = path.join(path.dirname(plan.target), name);
    if (directory === plan.directory) continue;
    try {
      await realDirectory(directory);
      if (await fs.stat(path.join(directory, 'install.lock')).catch(() => undefined)) continue;
      const old = JSON.parse(await fs.readFile(path.join(directory, 'plan.json'), 'utf8')) as MacUpdatePlan;
      const result = JSON.parse(await fs.readFile(path.join(directory, 'result.json'), 'utf8'));
      if (
        old.target !== plan.target ||
        result.outcome !== 'installed' ||
        !stableVersion(old.targetVersion) ||
        compareAppVersions(old.targetVersion, plan.currentVersion) > 0
      )
        continue;
      const previous = await info(path.join(directory, 'payload', path.basename(plan.target)));
      if (
        previous.CFBundleIdentifier !== plan.bundleId ||
        previous.CFBundleShortVersionString !== old.currentVersion
      )
        continue;
      await removeTree(directory);
    } catch {
      // An unknown or incomplete staging directory is never treated as a disposable backup.
    }
  }
}

/** Stage beside the running bundle so the final exchange is atomic on the same filesystem. */
export async function stageMacUpdate(options: {
  archive: string;
  target: string;
  currentVersion: string;
  targetVersion: string;
  arch: string;
  helperDirectory: string;
  receiptDirectory: string;
}): Promise<MacUpdatePlan> {
  const target = path.resolve(options.target);
  await realDirectory(target);
  if (!target.endsWith('.app') || target.includes('/AppTranslocation/') || target.startsWith('/Volumes/'))
    throw new MacUpdateError('请先把 Pi Desktop 移入可写的“应用程序”文件夹，再使用应用内更新。');
  await fs.access(path.dirname(target), constants.W_OK);
  const metadata = await info(target);
  const executable = metadata.CFBundleExecutable;
  if (!executable || path.basename(executable) !== executable || executable === '.' || executable === '..')
    throw new MacUpdateError('当前应用的可执行文件配置无效。');
  if (
    metadata.CFBundleShortVersionString !== options.currentVersion ||
    !stableVersion(options.targetVersion) ||
    compareAppVersions(options.targetVersion, options.currentVersion) <= 0
  )
    throw new MacUpdateError('更新版本无效，已取消安装。');
  const { stdout: entries } = await exec('/usr/bin/unzip', ['-Z', '-1', options.archive], {
    maxBuffer: 16 * 1024 * 1024,
  });
  const appName = path.basename(target);
  for (const entry of entries.trim().split('\n')) {
    if (
      entry.startsWith('/') ||
      entry.includes('\\') ||
      entry.split('/').includes('..') ||
      !(entry === appName || entry.startsWith(appName + '/') || entry.startsWith('__MACOSX/'))
    )
      throw new MacUpdateError('更新 ZIP 包含无效路径，已取消安装。');
  }
  const directory = await fs.mkdtemp(path.join(path.dirname(target), '.pi-desktop-update-'));
  try {
    await fs.chmod(directory, 0o700);
    const payload = path.join(directory, 'payload');
    await fs.mkdir(payload);
    await exec('/usr/bin/ditto', ['-x', '-k', options.archive, payload], { timeout: 120000 });
    const candidate = path.join(payload, appName);
    // Framework symlinks are valid, but none may point outside the signed bundle.
    const directories = [candidate];
    while (directories.length) {
      const directory = directories.pop()!;
      for (const name of await fs.readdir(directory)) {
        const file = path.join(directory, name);
        const stat = await fs.lstat(file);
        if (stat.isDirectory()) directories.push(file);
        else if (stat.isSymbolicLink()) {
          const resolved = await fs.realpath(file);
          if (!resolved.startsWith(candidate + path.sep))
            throw new MacUpdateError('更新包包含外部符号链接。');
        }
      }
    }
    const original = await fs.stat(target);
    const team = await signature(target);
    const requirement = team
      ? /^designated => (.+)$/m.exec((await exec('/usr/bin/codesign', ['-d', '-r-', target])).stdout)?.[1]
      : undefined;
    const plan: MacUpdatePlan = {
      directory,
      target,
      candidate,
      executable,
      bundleId: metadata.CFBundleIdentifier,
      arch: options.arch,
      currentVersion: options.currentVersion,
      targetVersion: options.targetVersion,
      originalInode: original.ino,
      originalDevice: original.dev,
      originalAsar: await digest(path.join(target, 'Contents/Resources/app.asar')),
      candidateAsar: await digest(path.join(candidate, 'Contents/Resources/app.asar')),
      team,
      requirement,
      receiptDirectory: options.receiptDirectory,
    };
    await checkCandidate(plan);
    for (const file of ['mac-update-helper.cjs', 'mac-update-swap']) {
      await fs.writeFile(
        path.join(directory, file),
        await nodeFs.promises.readFile(path.join(options.helperDirectory, file)),
        {
          mode: file.endsWith('.cjs') ? 0o600 : 0o700,
        },
      );
    }
    await fs.writeFile(path.join(directory, 'plan.json'), JSON.stringify(plan), { mode: 0o600 });
    return plan;
  } catch (error) {
    await removeTree(directory).catch(() => {});
    throw error;
  }
}

/** The helper acknowledges validation before the UI is allowed to quit. No shell or elevation. */
export async function startMacInstaller(plan: MacUpdatePlan, relaunch: boolean, canCommit = () => true) {
  const child = spawn(
    process.execPath,
    [
      path.join(plan.directory, 'mac-update-helper.cjs'),
      path.join(plan.directory, 'plan.json'),
      String(process.pid),
      relaunch ? 'restart' : 'quit',
    ],
    {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    },
  );
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      child.removeAllListeners('message');
      child.removeAllListeners('exit');
    };
    const fail = (error: Error) => {
      cleanup();
      // This is our uncommitted helper; the user's application is still running.
      child.kill();
      reject(error);
    };
    const timer = setTimeout(() => fail(new Error('更新安装程序未响应，已取消重启。')), 90000);
    child.once('error', fail);
    child.once('exit', (code) => fail(new Error(`更新安装程序提前退出 (${code})。`)));
    child.on('message', (message) => {
      if (message === 'ready') {
        if (!canCommit()) return fail(new MacUpdateError('退出状态已变化，已取消本次更新。'));
        child.send('commit', (error) => {
          if (error) fail(error);
        });
      } else if (message === 'armed') {
        cleanup();
        resolve();
      } else if (typeof message === 'object' && message && 'error' in message) {
        fail(new Error(String(message.error)));
      }
    });
  });
  child.disconnect();
  child.unref();
}

/** Run outside the application bundle; never replace a running app or kill its process. */
export async function runMacInstaller(plan: MacUpdatePlan, parent: number, relaunch: boolean) {
  await realDirectory(plan.directory);
  if (
    path.dirname(plan.directory) !== path.dirname(plan.target) ||
    !path.basename(plan.directory).startsWith('.pi-desktop-update-') ||
    plan.candidate !== path.join(plan.directory, 'payload', path.basename(plan.target)) ||
    !Number.isSafeInteger(parent) ||
    parent <= 1
  )
    throw new MacUpdateError('更新安装配置无效。');
  const lockFile = path.join(plan.directory, 'install.lock');
  try {
    const previous = Number(await fs.readFile(lockFile, 'utf8'));
    if (Number.isSafeInteger(previous) && previous > 1) {
      try {
        process.kill(previous, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') await fs.unlink(lockFile);
      }
    }
  } catch {
    /* No existing lock. */
  }
  const lock = await fs.open(lockFile, 'wx', 0o600);
  await lock.writeFile(String(process.pid));
  await lock.close();
  let swapped = false;
  try {
    await checkTarget(plan);
    await checkCandidate(plan);
    if (process.connected) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('更新未确认，已取消安装。')), 30000);
        process.once('disconnect', () => {
          clearTimeout(timer);
          reject(new Error('更新已取消。'));
        });
        process.once('message', (message) => {
          clearTimeout(timer);
          if (message === 'commit') resolve();
          else reject(new Error('更新未确认，已取消安装。'));
        });
        process.send?.('ready');
      });
      process.send?.('armed');
    }
    const deadline = Date.now() + 120000;
    while (true) {
      try {
        process.kill(parent, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') break;
        throw error;
      }
      if (Date.now() >= deadline) throw new MacUpdateError('应用仍未退出，已取消更新并保留原版本。');
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    await checkTarget(plan);
    await checkCandidate(plan);
    await exec(path.join(plan.directory, 'mac-update-swap'), [plan.target, plan.candidate]);
    swapped = true;
    // Keep the old bundle at the hidden staging path as a recoverable backup.
    await signature(plan.target);
    await fs.writeFile(path.join(plan.directory, 'result.json'), JSON.stringify({ outcome: 'installed' }));
  } catch (error) {
    if (swapped) {
      await exec(path.join(plan.directory, 'mac-update-swap'), [plan.target, plan.candidate]);
    }
    await new UpdateAttemptFile(plan.receiptDirectory).record({
      currentVersion: plan.currentVersion,
      targetVersion: plan.targetVersion,
      startedAt: Date.now(),
      outcome: 'failed',
    });
    await fs.writeFile(path.join(plan.directory, 'result.json'), JSON.stringify({ outcome: 'failed' }));
    throw error;
  } finally {
    await fs.rm(path.join(plan.directory, 'install.lock'), { force: true });
  }
  await cleanOlderBackups(plan).catch(() => {});
  if (relaunch) {
    const environment = { ...process.env };
    // The helper is Node-only; propagating this flag makes the new Electron app exit without a window.
    delete environment.ELECTRON_RUN_AS_NODE;
    delete environment.NODE_CHANNEL_FD;
    await exec('/usr/bin/open', ['-n', plan.target], { env: environment });
  }
}
