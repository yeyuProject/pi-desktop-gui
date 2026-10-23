import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
const exec = promisify(execFile);

export const isWindows = process.platform === 'win32';
export const isMac = process.platform === 'darwin';
export const nodeExecutableName = isWindows ? 'node.exe' : 'node 可执行文件';
export async function locateExecutable(name: string): Promise<string> {
  await loadLoginShellPath();
  try {
    const { stdout } = await exec(isWindows ? 'where.exe' : 'which', [name], {
      windowsHide: true,
      timeout: 3000,
    });
    return stdout.trim().split(/\r?\n/)[0] || '';
  } catch {
    return '';
  }
}
export async function shellCandidates(git?: string, configured?: string) {
  return (
    isWindows
      ? [
          configured || '',
          process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'Git', 'bin', 'bash.exe') : '',
          git ? path.resolve(git, '..', '..', 'bin', 'bash.exe') : '',
          await locateExecutable('bash'),
        ]
      : [configured || '', await locateExecutable('bash'), '/bin/bash']
  ).filter(Boolean);
}
export function piShellEnvironment(bash?: string): NodeJS.ProcessEnv {
  if (!isWindows || !bash) return {};
  const key = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
  return { [key]: path.dirname(bash) + path.delimiter + (process.env[key] ?? '') };
}

export const pathKey = (p: string) => {
  const resolved = path.resolve(p);
  return isWindows || isMac ? resolved.toLowerCase() : resolved;
};
export const samePath = (a: string, b: string) => pathKey(a) === pathKey(b);

const posixQuote = (v: string) => "'" + v.replaceAll("'", "'\\''") + "'";
const psQuote = (v: string) => "'" + v.replaceAll("'", "''") + "'";

function detach(command: string, args: string[], cwd?: string) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd, detached: true, stdio: 'ignore', windowsHide: false });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

async function onPath(name: string) {
  await loadLoginShellPath();
  try {
    await exec('which', [name], { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

const terminalStartTimeout = 15_000;
type TerminalLock = { pid: number; launch?: string };

async function readTerminalLock(lockFile: string) {
  try {
    const contents = await fs.readFile(lockFile, 'utf8');
    const lock: TerminalLock = JSON.parse(contents);
    if (
      !lock ||
      !Number.isInteger(lock.pid) ||
      lock.pid <= 0 ||
      lock.pid > 0x7fffffff ||
      (lock.launch !== undefined && typeof lock.launch !== 'string')
    )
      throw new Error('invalid terminal lock');
    return { lock, contents };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error('无法读取 Pi 终端状态。请确认终端已关闭后删除应用数据目录中的 terminal.lock，再重试。', {
      cause: error,
    });
  }
}

export async function terminalOpen(lockFile: string) {
  const current = await readTerminalLock(lockFile);
  if (!current) return false;
  let alive = true;
  try {
    process.kill(current.lock.pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false;
    else if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
  }
  if (current.lock.launch) {
    const stat = await fs.stat(lockFile).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (!stat) return false;
    alive &&= Date.now() - stat.mtimeMs < terminalStartTimeout;
  }
  if (alive) return true;
  await fs.rm(lockFile, { force: true });
  return false;
}

// The terminal acknowledges startup with its own PID, not the short-lived terminal launcher PID.
export function terminalScript(
  command: string[],
  cwd: string,
  env: Record<string, string>,
  lockFile: string,
  pending: string,
) {
  const temporary = lockFile + '.' + (JSON.parse(pending) as TerminalLock).launch + '.running';
  if (isWindows)
    return (
      `$ErrorActionPreference='Stop'\n` +
      `if ([IO.File]::ReadAllText(${psQuote(lockFile)}) -cne ${psQuote(pending)}) { exit }\n` +
      `try {\n` +
      `[IO.File]::WriteAllText(${psQuote(temporary)}, ('{"pid":' + $PID + '}'))\n` +
      `Move-Item -LiteralPath ${psQuote(temporary)} -Destination ${psQuote(lockFile)} -Force\n` +
      `Set-Location -LiteralPath ${psQuote(cwd)}\n` +
      Object.entries(env)
        .map(([k, v]) => `$env:${k}=${psQuote(v)}\n`)
        .join('') +
      `& ${command.map(psQuote).join(' ')}\n` +
      `} finally { Remove-Item -LiteralPath ${psQuote(lockFile)} -ErrorAction SilentlyContinue }\n`
    );
  return (
    `[ "$(cat ${posixQuote(lockFile)} 2>/dev/null)" = ${posixQuote(pending)} ] || exit 1\n` +
    `trap ${posixQuote(`rm -f ${posixQuote(lockFile)} ${posixQuote(temporary)}`)} EXIT\n` +
    `printf '{"pid":%s}' "$$" > ${posixQuote(temporary)} && mv -f ${posixQuote(temporary)} ${posixQuote(lockFile)} || exit 1\n` +
    `cd ${posixQuote(cwd)} || exit 1\n` +
    Object.entries(env)
      .map(([k, v]) => `export ${k}=${posixQuote(v)}\n`)
      .join('') +
    // exec keeps this PID for Pi itself. If the terminal is killed, the next check removes its dead lock.
    `exec ${command.map(posixQuote).join(' ')}\n`
  );
}

/** Open a visible Pi terminal and wait for the runner to acknowledge ownership of the session. */
export async function openTerminal(
  command: string[],
  cwd: string,
  env: Record<string, string>,
  lockFile: string,
): Promise<void> {
  if (await terminalOpen(lockFile)) throw new Error('Pi 终端正在打开或运行，请关闭该终端后再重试。');
  const launch = randomUUID();
  const pending = JSON.stringify({ pid: process.pid, launch } satisfies TerminalLock);
  const deadline = Date.now() + terminalStartTimeout;
  try {
    await fs.writeFile(lockFile, pending, { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new Error('Pi 终端正在打开或运行，请稍后重试。');
    throw error;
  }
  let scriptFile: string | undefined;
  try {
    const script = terminalScript(command, cwd, env, lockFile, pending);
    if (isWindows) {
      const encoded = Buffer.from(script, 'utf16le').toString('base64');
      const launch = `$ErrorActionPreference='Stop'\nStart-Process -FilePath powershell.exe -ArgumentList @('-NoLogo','-NoProfile','-EncodedCommand','${encoded}') -WindowStyle Normal`;
      await exec(
        'powershell.exe',
        ['-NoProfile', '-EncodedCommand', Buffer.from(launch, 'utf16le').toString('base64')],
        {
          windowsHide: true,
          timeout: terminalStartTimeout,
        },
      );
    } else if (isMac) {
      scriptFile = path.join(os.tmpdir(), `pi-desktop-${randomUUID()}.command`);
      await fs.writeFile(scriptFile, `#!/bin/bash\n${script}`, { mode: 0o700 });
      await exec('open', ['-a', 'Terminal', scriptFile], { timeout: terminalStartTimeout });
    } else {
      const candidates: [string, string[]][] = [
        ['x-terminal-emulator', ['-e', 'bash', '-lc', script]],
        ['gnome-terminal', ['--', 'bash', '-lc', script]],
        ['konsole', ['-e', 'bash', '-lc', script]],
        ['xfce4-terminal', ['-x', 'bash', '-lc', script]],
        ['alacritty', ['-e', 'bash', '-lc', script]],
        ['kitty', ['bash', '-lc', script]],
        ['xterm', ['-e', 'bash', '-lc', script]],
      ];
      let launched = false;
      for (const [bin, args] of candidates)
        if (await onPath(bin)) {
          await detach(bin, args, cwd);
          launched = true;
          break;
        }
      if (!launched) throw new Error('未找到系统终端');
    }
    while (Date.now() < deadline) {
      const current = await readTerminalLock(lockFile);
      if (!current || !current.lock.launch) return;
      if (current.contents !== pending) throw new Error('终端启动已取消');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('终端没有确认启动');
  } catch (error) {
    if ((await readTerminalLock(lockFile))?.contents === pending) await fs.rm(lockFile, { force: true });
    throw new Error(
      '无法打开 Pi 终端。' +
        (process.platform === 'linux'
          ? '请确认已安装并可打开 gnome-terminal、konsole 或 xterm，然后重试。'
          : '请检查系统终端是否可用后重试。'),
      { cause: error },
    );
  } finally {
    if (scriptFile) await fs.rm(scriptFile, { force: true });
    await fs.rm(lockFile + '.' + launch + '.running', { force: true });
  }
}

/** Opens a plain-text file for editing in the user's default text editor. */
export async function openTextEditor(file: string, configured?: string) {
  if (configured) return openWithApp(configured, file);
  if (isWindows) return detach('notepad.exe', [file]);
  if (isMac) return detach('open', ['-t', file]);
  const editor = process.env.VISUAL || process.env.EDITOR;
  if (editor && /^(code|subl|gedit|kate|mousepad|xed|pluma)\b/.test(path.basename(editor)))
    return detach(editor, [file]);
  return detach('xdg-open', [file]);
}

export function validEditor(editor: string) {
  if (!path.isAbsolute(editor)) return false;
  if (isWindows) return /\.exe$/i.test(editor);
  if (isMac) return /\.app\/?$/i.test(editor) || !path.extname(editor);
  return true;
}

export async function openWithApp(editor: string, file: string) {
  if (!validEditor(editor))
    throw new Error(
      isWindows
        ? '请选择编辑器的 .exe 文件'
        : isMac
          ? '请选择编辑器应用（.app）或可执行文件'
          : '请选择编辑器可执行文件',
    );
  if (isMac && /\.app\/?$/i.test(editor)) return detach('open', ['-a', editor, file]);
  return detach(editor, [file]);
}

/**
 * GUI apps launched from Finder or a desktop menu inherit a minimal PATH, so tools installed with
 * nvm, Homebrew or similar are invisible. Read the PATH from the user's login shell once.
 */
let loginShellPath: Promise<void> | undefined;
export function loadLoginShellPath() {
  return (loginShellPath ??= readLoginShellPath());
}
async function readLoginShellPath() {
  if (isWindows || process.env.PI_DESKTOP_SKIP_SHELL_PATH) return;
  const shell = process.env.SHELL || (isMac ? '/bin/zsh' : '/bin/bash');
  try {
    const marker = '__PI_DESKTOP_PATH__';
    const { stdout } = await exec(shell, ['-ilc', `printf '${marker}%s${marker}' "$PATH"`], {
      timeout: 5000,
      env: { ...process.env, DISABLE_AUTO_UPDATE: 'true' },
    });
    const found = new RegExp(`${marker}(.*?)${marker}`).exec(stdout)?.[1];
    if (!found) return;
    const merged = [...new Set([...found.split(':'), ...(process.env.PATH ?? '').split(':')])].filter(
      Boolean,
    );
    process.env.PATH = merged.join(':');
  } catch {}
}

export const fileManagerName = isWindows ? '资源管理器' : isMac ? '访达' : '文件管理器';
export const trashName = isWindows ? '回收站' : '废纸篓';

async function killPosixTree(pid: number) {
  const signal = (target: number, value: NodeJS.Signals) => {
    try {
      process.kill(target, value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  };
  // Pause Pi before inspecting its children so it cannot start the next tool while we stop this one.
  signal(-pid, 'SIGSTOP');
  try {
    const { stdout } = await exec('ps', ['-A', '-o', 'pid=,ppid=,pgid='], { timeout: 5000 });
    const processes = stdout
      .trim()
      .split('\n')
      .map((line) => {
        const [child, parent, group] = line.trim().split(/\s+/).map(Number);
        return { child, parent, group };
      });
    const descendants: typeof processes = [];
    const parents = new Set([pid]);
    for (const parent of parents) {
      for (const process of processes) {
        if (process.parent !== parent || parents.has(process.child)) continue;
        parents.add(process.child);
        descendants.push(process);
      }
    }
    // Pi's shell tools start their own groups. Killing only Pi's group leaves those commands running.
    for (const child of descendants.reverse()) {
      if (child.group === child.child) signal(-child.group, 'SIGKILL');
      signal(child.child, 'SIGKILL');
    }
    signal(-pid, 'SIGKILL');
  } catch (error) {
    signal(-pid, 'SIGCONT');
    throw new Error('无法确认所有命令已结束，请重试强制结束。', { cause: error });
  }
}

/** taskkill could not find its root PID; this does not prove its descendants stopped. */
export class WindowsProcessNotFoundError extends Error {
  constructor(
    readonly pid: number,
    cause: unknown,
  ) {
    super(`taskkill could not find process ${pid}`, { cause });
    this.name = 'WindowsProcessNotFoundError';
  }
}

export async function terminateProcessTree(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('无效的进程编号');
  if (isWindows) {
    try {
      await exec('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    } catch (error) {
      if ((error as { code?: number }).code === 128) throw new WindowsProcessNotFoundError(pid, error);
      throw error;
    }
  } else await killPosixTree(pid);
}
