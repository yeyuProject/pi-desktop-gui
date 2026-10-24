import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
export class UpdateProcessAliveError extends Error {}

/** Called only after the saved index and interactive renderer have initialized. */
export async function acknowledgeUpdateHealth(version: string) {
  const file = process.env.PI_DESKTOP_UPDATE_HEALTH_FILE;
  const token = process.env.PI_DESKTOP_UPDATE_HEALTH_TOKEN;
  if (
    !file ||
    !token ||
    !/^[a-f0-9-]{36}$/.test(token) ||
    path.basename(file) !== 'health.json' ||
    !path.basename(path.dirname(file)).startsWith('.pi-desktop-update-')
  )
    return;
  delete process.env.PI_DESKTOP_UPDATE_HEALTH_FILE;
  delete process.env.PI_DESKTOP_UPDATE_HEALTH_TOKEN;
  await fs.writeFile(file, JSON.stringify({ token, version, pid: process.pid }), { mode: 0o600, flag: 'wx' });
}

export async function launchHealthyUpdate(
  executable: string,
  file: string,
  token: string,
  version: string,
  timeout = 60000,
  args: string[] = [],
) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PI_DESKTOP_UPDATE_HEALTH_FILE: file,
    PI_DESKTOP_UPDATE_HEALTH_TOKEN: token,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_CHANNEL_FD;
  await fs.rm(file, { force: true });
  const child = spawn(executable, args, { detached: true, stdio: 'ignore', env });
  let exited = false;
  let failure: Error | undefined;
  child.once('exit', () => {
    exited = true;
  });
  child.once('error', (error) => {
    failure = error;
    exited = true;
  });
  try {
    const until = Date.now() + timeout;
    while (Date.now() < until && !exited) {
      const receipt = await fs
        .readFile(file, 'utf8')
        .then(JSON.parse)
        .catch(() => undefined);
      if (receipt?.token === token && receipt.version === version && receipt.pid === child.pid) {
        child.unref();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw failure ?? new Error('新版本未能完成启动，正在恢复原版本。');
  } catch (error) {
    // Only the process group we just launched can be stopped for rollback.
    for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
      if (exited || !child.pid) break;
      try {
        process.kill(-child.pid, signal);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e;
      }
      const until = Date.now() + 5000;
      while (!exited && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!exited)
      throw new UpdateProcessAliveError('新版本进程尚未退出，已保留原版本备份，请关闭应用后恢复。');
    throw error;
  }
}
