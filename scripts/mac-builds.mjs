import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export const macBuildOutput = path.join('release', 'mac-builds.noindex');

export function packagedExecutable(platform = process.platform, arch = process.arch) {
  if (platform === 'win32') return path.resolve('release/win-unpacked/Pi Desktop.exe');
  if (platform === 'darwin')
    return path.resolve(
      macBuildOutput,
      arch === 'x64' ? 'mac' : `mac-${arch}`,
      'Pi Desktop.app/Contents/MacOS/Pi Desktop',
    );
  throw new Error(`没有为 ${platform} 配置目录版验收程序。`);
}

const excludesIndexing = (directory) =>
  path
    .resolve(directory)
    .split(path.sep)
    .some((part) => part.endsWith('.noindex'));

/** Reject unprotected outputs before Electron is unpacked, including direct builder invocations. */
export default async function requireMacBuildIsolation(context) {
  if (context.electronPlatformName !== 'darwin') return;
  await fs.mkdir(context.appOutDir, { recursive: true });
  if (!excludesIndexing(await fs.realpath(context.appOutDir)))
    throw new Error(
      'Mac 构建必须位于 .noindex 目录内，避免测试应用进入启动台。请使用 npm run package 或 npm run package:dir。',
    );
}

export async function macTestApp(executable, buildRoot = macBuildOutput) {
  if (!executable) return undefined;
  const resolved = await Promise.all([fs.realpath(executable), fs.realpath(buildRoot)]).catch((error) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!resolved) return undefined;
  const [real, root] = resolved;
  const macOS = path.dirname(real);
  const contents = path.dirname(macOS);
  const app = path.dirname(contents);
  const relative = path.relative(root, app);
  if (
    path.basename(macOS) !== 'MacOS' ||
    path.basename(contents) !== 'Contents' ||
    !app.endsWith('.app') ||
    !excludesIndexing(root) ||
    !relative ||
    relative === '..' ||
    relative.startsWith('..' + path.sep) ||
    path.isAbsolute(relative)
  )
    return undefined;
  return app;
}

/** Launching a test app can still register it with Launch Services despite Spotlight exclusion. */
export async function unregisterMacTestApp(executable, buildRoot = macBuildOutput) {
  if (process.platform !== 'darwin' || !executable) return;
  const app = await macTestApp(executable, buildRoot);
  if (!app) return; // Never unregister an installed app supplied through PI_DESKTOP_EXE.
  try {
    await exec(
      '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister',
      ['-u', app],
      { timeout: 10000 },
    );
  } catch (error) {
    // kLSApplicationNotFoundErr: a failed launch or an earlier cleanup left no registration.
    if (error.code === 1 && /: -10814\s*(?:\n|$)/.test(error.stderr ?? '')) return;
    throw error;
  }
}
