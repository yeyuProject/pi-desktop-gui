import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Environment, Settings } from '../shared/types';
import type { CommandSpec } from './rpc';
import { PI_INSTALL_COMMAND, classifyPiVersion, compatibilityMessage } from '../shared/pi-version';
export { VERIFIED, classifyPiVersion } from '../shared/pi-version';
import {
  isWindows,
  locateExecutable,
  shellCandidates,
  nodeExecutableName,
  loadLoginShellPath,
} from './platform';
const exec = promisify(execFile);
export async function exists(p: string) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
export const agentDirectory = (s: Settings) =>
  s.agentDir || process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent');
export async function resolvePi(
  settings: Settings,
  developmentRoot?: string,
): Promise<{ spec: CommandSpec; entry: string; node?: string }> {
  await loadLoginShellPath();
  let entry = settings.piPath || (await locateExecutable('pi'));
  if (!entry && developmentRoot) {
    const local = path.join(
      developmentRoot,
      'node_modules',
      '@earendil-works',
      'pi-coding-agent',
      'dist',
      'bundle',
      'cli.js',
    );
    if (await exists(local)) entry = local;
  }
  if (!entry || !(await exists(entry))) throw new Error('未找到 Pi。请安装 Pi 或在设置中选择入口。');
  // npm links have no extension; resolve them so an explicitly chosen Node runtime is honored.
  if (process.platform !== 'win32') entry = await fs.realpath(entry);
  if (/\.(cmd|ps1|bat)$/i.test(entry) || (!path.extname(entry) && isWindows)) {
    const base = path.dirname(entry);
    const candidates = [
      path.join(base, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'cli.js'),
      path.join(base, 'node_modules', '@mariozechner', 'pi-coding-agent', 'dist', 'cli.js'),
    ];
    const found = await Promise.all(candidates.map(exists));
    entry = candidates.find((_, i) => found[i]) || '';
    if (!entry) throw new Error('无法安全解析此启动脚本。请选择 Pi 的 cli.js 或官方可执行文件。');
  }
  if (/\.(m?js|cjs)$/i.test(entry)) {
    const node = settings.nodePath || (await locateExecutable('node'));
    if (!node || !(await exists(node)))
      throw new Error(`运行此 Pi 入口需要 Node.js 22.19 或更高版本，请选择 ${nodeExecutableName}。`);
    const { stdout } = await exec(node, ['--version'], { windowsHide: true, timeout: 5000 });
    const [major, minor] = stdout.trim().replace(/^v/, '').split('.').map(Number);
    if (major < 22 || (major === 22 && minor < 19))
      throw new Error('运行此 Pi 入口需要 Node.js 22.19 或更高版本。');
    return { entry, node, spec: { command: node, args: [entry] } };
  }
  return { entry, spec: { command: entry, args: [] } };
}
type ResolvedPi = Awaited<ReturnType<typeof resolvePi>>;
type PiInspection = { environment: Environment; resolved?: ResolvedPi; fingerprint: string };
let inspection: { key: string; result: Promise<PiInspection> } | undefined;

const environmentKey = (settings: Settings, developmentRoot?: string) =>
  JSON.stringify([
    settings.piPath,
    settings.nodePath,
    agentDirectory(settings),
    developmentRoot,
    process.env.PATH,
    process.env.Path,
    process.env.PATHEXT,
    process.env.ProgramFiles,
  ]);

async function fingerprint(environment: Environment, resolved?: ResolvedPi) {
  const files = [
    resolved?.entry,
    ...(resolved
      ? [
          path.dirname(resolved.entry),
          path.join(path.dirname(resolved.entry), 'cli-runtime.js'),
          path.resolve(path.dirname(resolved.entry), '..', 'package.json'),
          path.resolve(path.dirname(resolved.entry), '..', '..', 'package.json'),
        ]
      : []),
    resolved?.node,
    environment.git,
    environment.bash,
    ...['settings.json', 'auth.json', 'models.json'].map((name) => path.join(environment.agentDir, name)),
  ].filter((file): file is string => Boolean(file));
  return JSON.stringify(
    await Promise.all(
      files.map(async (file) => {
        try {
          const stat = await fs.stat(file);
          return [file, stat.size, stat.mtimeMs, stat.ctimeMs];
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          return [file, 'missing'];
        }
      }),
    ),
  );
}

async function inspectEnvironment(settings: Settings, developmentRoot?: string): Promise<PiInspection> {
  const result: Environment = {
    piPath: '',
    supported: false,
    compatibility: 'unknown',
    agentDir: agentDirectory(settings),
    authExists: false,
    modelsExist: false,
    errors: [],
  };
  [result.authExists, result.modelsExist] = await Promise.all([
    exists(path.join(result.agentDir, 'auth.json')),
    exists(path.join(result.agentDir, 'models.json')),
  ]);
  result.git = await locateExecutable('git');
  let shellPath: string | undefined;
  try {
    const config = JSON.parse(
      (await fs.readFile(path.join(result.agentDir, 'settings.json'), 'utf8')).replace(/^\uFEFF/, ''),
    );
    if (typeof config.shellPath === 'string' && (await exists(config.shellPath)))
      shellPath = config.shellPath;
  } catch {}
  const bashCandidates = await shellCandidates(result.git, shellPath);
  for (const candidate of bashCandidates)
    if (await exists(candidate)) {
      result.bash = candidate;
      break;
    }
  let resolved: ResolvedPi | undefined;
  try {
    resolved = await resolvePi(settings, developmentRoot);
    result.piPath = resolved.entry;
    result.nodePath = resolved.node;
    const { stdout } = await exec(resolved.spec.command, [...resolved.spec.args, '--version'], {
      timeout: 15000,
      windowsHide: true,
      env: { ...process.env, PI_CODING_AGENT_DIR: result.agentDir },
    });
    result.version = stdout.trim().match(/(?:^|\s)v?(\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?)(?=\s|$)/)?.[1];
    result.compatibility = classifyPiVersion(result.version);
    result.supported = result.compatibility !== 'unknown';
    if (!result.supported)
      result.errors.push(
        `${compatibilityMessage(result.version, result.compatibility)}\n${PI_INSTALL_COMMAND}`,
      );
  } catch (e) {
    result.errors.push((e as Error).message);
  }
  if (!result.bash)
    result.errors.push(
      isWindows
        ? '未检测到 Git Bash，命令执行可能失败。请安装 Git for Windows 或配置 shellPath。'
        : '未检测到 bash，命令执行可能失败。请安装 bash 或在 Pi 设置中配置 shellPath。',
    );
  return { environment: result, resolved, fingerprint: await fingerprint(result, resolved) };
}

function startInspection(settings: Settings, developmentRoot?: string) {
  const pending = {
    key: environmentKey(settings, developmentRoot),
    result: inspectEnvironment(settings, developmentRoot),
  };
  inspection = pending;
  void pending.result.catch(() => {
    if (inspection === pending) inspection = undefined;
  });
  return pending;
}

/** An explicit environment check always probes again and refreshes the startup cache. */
export async function detectEnvironment(settings: Settings, developmentRoot?: string): Promise<Environment> {
  await loadLoginShellPath(true);
  return (await startInspection(settings, developmentRoot).result).environment;
}

export async function preparePi(settings: Settings, developmentRoot?: string) {
  await loadLoginShellPath();
  const key = environmentKey(settings, developmentRoot);
  let pending = inspection?.key === key ? inspection : startInspection(settings, developmentRoot);
  const cached = await pending.result;
  if (cached.fingerprint !== (await fingerprint(cached.environment, cached.resolved))) {
    // Another caller may already have replaced this stale inspection while we checked its files.
    pending =
      inspection !== pending && inspection?.key === key
        ? inspection
        : startInspection(settings, developmentRoot);
  }
  const checked = await pending.result;
  if (!checked.environment.supported || !checked.resolved) {
    if (inspection === pending) inspection = undefined;
    throw new Error(checked.environment.errors.join('\n'));
  }
  return { environment: checked.environment, resolved: checked.resolved };
}

export async function requireSupportedPi(settings: Settings, developmentRoot?: string) {
  return (await preparePi(settings, developmentRoot)).environment;
}
