import fs from 'node:fs/promises';
import path from 'node:path';
import { isWindows, pathKey } from './platform';
import { normalizePiToolPath } from './pi/tool-path';
import { sensitiveWritePath, type ReadTarget, type WriteTarget } from '../shared/approval';

/** Resolve existing ancestors as well as a new file's name, so directory links cannot escape. */
export async function canonicalWritePath(target: string): Promise<string> {
  let current = path.resolve(target);
  const missing: string[] = [];
  for (;;) {
    try {
      const stat = await fs.lstat(current);
      // A dangling symlink must not be mistaken for a missing ordinary path.
      const real = await fs.realpath(current);
      if (missing.length && !stat.isDirectory() && !stat.isSymbolicLink())
        throw new Error('文件的上级路径不是目录');
      return path.resolve(real, ...missing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      try {
        if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('文件路径包含失效的符号链接');
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') throw statError;
      }
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

export function isWithinDirectory(root: string, target: string): boolean {
  const relative = path.relative(pathKey(root), pathKey(target));
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))
  );
}

/** These files can make later Git or Pi operations execute code. Never bulk-authorize them. */
function protectedProjectPath(target: string): boolean {
  return target
    .split(/[\\/]/)
    .some((part) => /^(?:\.git|\.pi|\.gitattributes|\.gitmodules)$/i.test(part.replace(/[. ]+$/, '')));
}

function ordinaryPath(resolved: string): boolean {
  return !(
    isWindows &&
    (resolved.startsWith('\\\\?\\') ||
      resolved.startsWith('\\\\.\\') ||
      resolved.slice(2).includes(':') ||
      resolved
        .split(/[\\/]/)
        .some((part) => /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part.trim())))
  );
}

export async function classifyReadTarget(cwd: string, targetPath: string): Promise<ReadTarget> {
  if (!targetPath || targetPath.includes('\0')) return 'outside';
  try {
    const resolved = normalizePiToolPath(cwd, targetPath);
    if (!ordinaryPath(resolved)) return 'outside';
    // Require an existing target: Pi's read tool can try alternate Unicode spellings
    // for missing paths. An unverified fallback must not inherit a project grant.
    const [root, target] = await Promise.all([fs.realpath(cwd), fs.realpath(resolved)]);
    if (!isWithinDirectory(root, target)) return 'outside';
    const stat = await fs.stat(target);
    return stat.isDirectory() || (stat.isFile() && stat.nlink === 1) ? 'project' : 'outside';
  } catch {
    return 'outside';
  }
}

export async function classifyWriteTarget(cwd: string, targetPath: string): Promise<WriteTarget> {
  if (!targetPath || targetPath.includes('\0')) return 'outside';
  if (sensitiveWritePath(targetPath)) return 'sensitive';
  try {
    const resolved = normalizePiToolPath(cwd, targetPath);
    // NTFS alternate streams and device paths do not name an ordinary project file.
    if (!ordinaryPath(resolved) || protectedProjectPath(resolved)) return 'outside';
    const sensitiveName = isWindows
      ? resolved
          .split(/[\\/]/)
          .map((part) => part.replace(/[. ]+$/, ''))
          .join('/')
      : resolved;
    if (sensitiveWritePath(sensitiveName)) return 'sensitive';
    const [root, target] = await Promise.all([fs.realpath(cwd), canonicalWritePath(resolved)]);
    if (protectedProjectPath(target)) return 'outside';
    if (sensitiveWritePath(target)) return 'sensitive';
    const stat = await fs.stat(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (stat && (!stat.isFile() || stat.nlink > 1)) return 'outside';
    return isWithinDirectory(root, target) ? 'project' : 'outside';
  } catch {
    // A path we cannot verify may still be allowed once after explicit review.
    return 'outside';
  }
}
