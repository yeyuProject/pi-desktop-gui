import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { compare, valid } from 'semver';
import { redact } from '../shared/errors';
import type { Environment } from '../shared/types';
import { terminateProcessTree } from './platform';
import { updateProxyAddress } from './update-network';
import type { CommandSpec } from './rpc';

export function comparePiVersions(left: string, right: string) {
  return valid(left) && valid(right) ? compare(left, right) : undefined;
}

export async function checkPiUpdate(
  current: string,
  appVersion: string,
  request: (url: string, options: RequestInit) => Promise<Response> = fetch,
  timeoutMs = 10_000,
) {
  if (process.env.PI_OFFLINE) return;
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const response = await request('https://pi.dev/api/latest-version', {
      headers: { accept: 'application/json', 'User-Agent': `pi-desktop/${appVersion} pi/${current}` },
      cache: 'no-store',
      signal,
    });
    if (!response.ok) throw new Error(`版本服务器返回 HTTP ${response.status}，请稍后重试。`);
    const data: unknown = await response.json();
    if (
      !data ||
      typeof data !== 'object' ||
      !('version' in data) ||
      typeof data.version !== 'string' ||
      !data.version.trim()
    )
      throw new Error('版本服务器未返回 Pi 版本号，请稍后重试。');
    const latest = data.version.trim();
    return {
      current,
      latest,
      packageName:
        'packageName' in data && typeof data.packageName === 'string' ? data.packageName.trim() : undefined,
      note: 'note' in data && typeof data.note === 'string' ? data.note.trim() : undefined,
      newer: (comparePiVersions(latest, current) ?? 1) > 0,
      checkedAt: Date.now(),
    };
  } catch (cause) {
    if (signal.aborted) throw new Error('连接 Pi 版本服务器超时，请检查网络或代理后重试。', { cause });
    if (cause instanceof SyntaxError) throw new Error('Pi 版本服务器返回的内容不是有效的 JSON。', { cause });
    if (cause instanceof TypeError || (cause instanceof Error && /^(?:net::|ERR_)/.test(cause.message)))
      throw new Error('无法连接 Pi 版本服务器，请检查网络或代理后重试。', { cause });
    throw cause;
  }
}

export function piUpdateBlockedReason(
  busy: boolean,
  closing: boolean,
  environment?: Environment,
  proxy = '',
) {
  if (busy) return '请等待所有任务结束后再更新 Pi';
  if (closing) return '桌面端正在更新或退出';
  if (environment?.piUpdateRestriction === 'development') return '开发环境使用项目内的 Pi，请用 npm 更新依赖';
  if (environment?.piUpdateRestriction === 'standalone')
    return '此安装方式不支持自动更新，请按官方说明重新安装';
  if (process.env.PI_OFFLINE) return 'Pi 处于离线模式';
  if (!environment?.version) return '未检测到 Pi，请先重新检测';
  if (/^socks4:/i.test(updateProxyAddress(proxy).trimStart()))
    return 'Pi 更新程序不支持 SOCKS4，请在「关于与更新」中改用 HTTP、HTTPS 或 SOCKS5 代理。';
  return '';
}

export function piUpdateFailure(code: number | null, current: string, latest: string, detected: Environment) {
  if (code !== 0) return `Pi 更新程序${code === null ? '已中断' : `退出（代码 ${code}）`}，请查看下方输出。`;
  if (detected.version === current)
    return `Pi 报告更新完成，但检测到的版本仍是 ${current}，可能有多个 Pi 安装。当前入口为 ${detected.piPath}`;
  if (!detected.version) return 'Pi 报告更新完成，但未检测到 Pi 版本，请检查 Pi 入口后重新检测。';
  if ((comparePiVersions(detected.version, latest) ?? (detected.version === latest ? 0 : -1)) < 0)
    return `检测到的 Pi 版本 ${detected.version} 低于目标版本 ${latest}。当前入口为 ${detected.piPath}`;
  return '';
}

/**
 * 1. 以非交互方式启动 Pi，只更新 Pi 本体。
 * 2. 标准输出和错误输出分别跳过私钥块，其他行脱敏后交给界面。
 * 3. 超时停止进程树。停止失败立即通知界面并允许重试，直到进程和输出管道关闭才结束更新。
 */
export function runPiUpdate(
  spec: CommandSpec,
  env: NodeJS.ProcessEnv,
  onLine: (line: string) => void,
  onStopFailure: (cause: unknown, retry?: () => void) => void,
  timeoutMs = 10 * 60_000,
  stopTree = terminateProcessTree,
) {
  // 1. 独立进程组让 macOS/Linux 能一起结束 Pi 启动的包管理器。
  const child = spawn(spec.command, [...spec.args, 'update', 'pi'], {
    env,
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // 2. 私钥正文跨行，另一个输出流的结束标记不能解除本流的遮盖。
  for (const stream of [child.stdout, child.stderr]) {
    let inPrivateKey = false;
    createInterface({ input: stream, crlfDelay: Infinity }).on('line', (line) => {
      const markers = line.match(/-----(?:BEGIN|END) [A-Z0-9 ]*PRIVATE KEY-----/g);
      if (markers) {
        if (!inPrivateKey) onLine('[已隐藏]');
        inPrivateKey = markers[markers.length - 1].startsWith('-----BEGIN');
        return;
      }
      if (!inPrivateKey) onLine(redact(line).slice(-4000));
    });
  }
  return new Promise<number | null>((resolve, reject) => {
    let timedOut = false;
    let stopping: Promise<void> | undefined;
    // 3. 重试前确认根进程还在，避免向已被系统重新分配的进程号发送停止命令。
    const stop = () => {
      if (stopping) return;
      timedOut = true;
      if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) {
        onStopFailure(new Error('更新进程已退出，正在等待子进程关闭输出。'));
        return;
      }
      stopping = stopTree(child.pid).catch((cause: unknown) => {
        stopping = undefined;
        onStopFailure(cause, child.exitCode === null && child.signalCode === null ? stop : undefined);
      });
    };
    const timer = setTimeout(stop, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        void Promise.resolve(stopping).then(() => reject(new Error('更新 Pi 超时，已停止更新。')));
        return;
      }
      resolve(code);
    });
  });
}
