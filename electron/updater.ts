import { EventEmitter } from 'node:events';
import { MacUpdateError } from './mac-update';
import { UpdateSignatureError } from '../shared/update-signature';
import {
  compareAppVersions,
  stableVersion,
  LATEST_RELEASE_API,
  type UpdateInstallation,
  type UpdateState,
  type UpdateInstallAttempt,
} from '../shared/app-update';

export interface DesktopRelease {
  version: string;
  notes: string;
}
export type UpdateDriverEvent =
  | { type: 'available' | 'downloaded'; release: DesktopRelease }
  | { type: 'not-available' }
  | { type: 'progress'; percent: number }
  | { type: 'error'; error: Error };
export interface UpdateDriver {
  subscribe(listener: (event: UpdateDriverEvent) => void): () => void;
  configure(autoDownload: boolean, installOnQuit: boolean): void;
  check(): Promise<void>;
  download(): Promise<void>;
  install(): void | Promise<void>;
  prepareForQuit?(): Promise<void>;
}
export function updateInstallation(
  platform: NodeJS.Platform,
  packaged: boolean,
  env: NodeJS.ProcessEnv,
): UpdateInstallation {
  if (!packaged) return 'development';
  if (platform === 'win32') return env.PORTABLE_EXECUTABLE_DIR ? 'portable' : 'nsis';
  if (platform === 'darwin') return 'mac';
  return env.APPIMAGE ? 'appimage' : 'deb';
}
export function updateError(error: unknown) {
  if (error instanceof MacUpdateError || error instanceof UpdateSignatureError) return error.message;
  const detail = error instanceof Error ? error.message : String(error);
  if (/ENOENT/i.test(detail) && /app-update\.yml/i.test(detail))
    return '当前程序缺少自动更新配置，请前往版本页面下载完整安装包。';
  if (/sha512|checksum|hash mismatch|sha-512/i.test(detail))
    return '下载文件校验失败，已取消安装。请重试下载。';
  if (/ENOSPC|EACCES|EPERM/i.test(detail)) return '无法保存或安装更新，请检查磁盘空间和目录权限后重试。';
  return '无法完成更新，请检查网络后重试，也可前往版本页面手动下载。';
}
type FetchRelease = (url: string, init?: RequestInit) => Promise<Response>;
export async function fetchLatestRelease(fetcher: FetchRelease = fetch): Promise<DesktopRelease | undefined> {
  const response = await fetcher(LATEST_RELEASE_API, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Pi-Desktop' },
    cache: 'no-store',
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`GitHub update check: HTTP ${response.status}`);
  const release = (await response.json()) as {
    tag_name?: unknown;
    body?: unknown;
    draft?: boolean;
    prerelease?: boolean;
  };
  if (release.draft || release.prerelease) return undefined;
  const version = stableVersion(release.tag_name);
  if (!version) throw new Error('Invalid stable release version');
  return { version, notes: typeof release.body === 'string' ? release.body.slice(0, 200000) : '' };
}
export async function fetchReleaseNotes(version: string, fetcher: FetchRelease = fetch) {
  const valid = stableVersion(version);
  if (!valid) throw new Error('Invalid release version');
  const response = await fetcher(LATEST_RELEASE_API.replace(/latest$/, `tags/v${valid}`), {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Pi-Desktop' },
    cache: 'no-store',
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Release notes: HTTP ${response.status}`);
  const release = (await response.json()) as { body?: unknown };
  return typeof release.body === 'string' ? release.body.slice(0, 200000) : '';
}

export interface UpdateOptions {
  currentVersion: string;
  installation: UpdateInstallation;
  enabled: boolean;
  disabledReason?: string;
  autoDownload: boolean;
  driver?: UpdateDriver;
  fetchRelease?: () => Promise<DesktopRelease | undefined>;
  fetchNotes?: (version: string) => Promise<string>;
  busy: () => boolean;
  beforeInstall: () => Promise<void>;
  installFailed: () => void;
  previousAttempt?: UpdateInstallAttempt;
  recordAttempt?: (attempt: UpdateInstallAttempt) => Promise<void>;
}

/** Desktop update policy. The native updater and GitHub transport stay outside application state. */
export class UpdateService extends EventEmitter {
  state: UpdateState;
  private autoDownload: boolean;
  private checking?: Promise<void>;
  private downloading?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private interval?: NodeJS.Timeout;
  private unsubscribe?: () => void;
  private installOnQuit = false;
  constructor(private readonly options: UpdateOptions) {
    super();
    this.autoDownload = options.autoDownload;
    this.state = {
      state: 'idle',
      currentVersion: options.currentVersion,
      installation: options.installation,
      mode: ['nsis', 'appimage', 'mac'].includes(options.installation) ? 'auto' : 'notify',
      enabled: options.enabled,
      disabledReason: options.disabledReason,
      installing: false,
      lastInstall: options.previousAttempt,
    };
    if (options.enabled && this.state.mode === 'auto' && !options.driver)
      throw new Error('自动更新组件未初始化');
    this.unsubscribe = options.driver?.subscribe((event) => this.onDriverEvent(event));
    options.driver?.configure(this.autoDownload, false);
  }
  private publish(value: Partial<UpdateState>) {
    this.state = { ...this.state, ...value };
    this.emit('update', structuredClone(this.state));
  }
  private fail(error: unknown) {
    const installing = this.state.installing;
    if (installing) {
      this.options.installFailed();
      this.markInstallFailed();
    }
    this.publish({
      state: 'error',
      installing: false,
      error: installing
        ? '无法启动更新安装程序或安装程序报告了错误，请重试，也可前往版本页面下载完整安装包。'
        : updateError(error),
    });
  }
  private markInstallFailed() {
    if (this.state.lastInstall?.outcome !== 'pending') return;
    const attempt: UpdateInstallAttempt = { ...this.state.lastInstall, outcome: 'failed' };
    this.publish({ lastInstall: attempt });
    void this.options.recordAttempt?.(attempt).catch(() => {});
  }
  private onDriverEvent(event: UpdateDriverEvent) {
    if (!this.state.enabled) return;
    if (event.type === 'error') return this.fail(event.error);
    if (event.type === 'progress') {
      if (Number.isFinite(event.percent))
        this.publish({ state: 'downloading', progress: Math.max(0, Math.min(100, event.percent)) });
      return;
    }
    if (event.type === 'not-available') {
      this.publish({
        state: 'idle',
        version: undefined,
        notes: undefined,
        progress: undefined,
        error: undefined,
      });
      return;
    }
    const version = stableVersion(event.release.version);
    if (!version || compareAppVersions(version, this.state.currentVersion) <= 0) {
      this.fail(new Error('Invalid update version'));
      return;
    }
    this.publish({
      state: event.type === 'downloaded' ? 'ready' : this.autoDownload ? 'downloading' : 'available',
      version,
      notes: this.options.fetchNotes
        ? this.state.version === version
          ? this.state.notes
          : ''
        : event.release.notes,
      error: undefined,
      progress: event.type === 'downloaded' ? 100 : 0,
    });
    if (event.type === 'available' && this.options.fetchNotes)
      void this.options
        .fetchNotes(version)
        .then((notes) => {
          if (this.state.version === version) this.publish({ notes });
        })
        .catch(() => {});
  }
  start() {
    if (!this.state.enabled || this.timer || this.interval) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.check();
      this.interval = setInterval(() => void this.check(), 6 * 60 * 60 * 1000);
      this.interval.unref();
    }, 10000);
    this.timer.unref();
  }
  check() {
    if (!this.state.enabled || this.state.installing || ['ready', 'downloading'].includes(this.state.state))
      return Promise.resolve();
    if (this.checking) return this.checking;
    const run = async () => {
      this.publish({ state: 'checking', checkedAt: Date.now(), error: undefined });
      try {
        if (this.state.mode === 'auto') await this.options.driver!.check();
        else {
          const release = await (this.options.fetchRelease ?? fetchLatestRelease)();
          if (release && compareAppVersions(release.version, this.state.currentVersion) > 0)
            this.publish({ state: 'available', version: release.version, notes: release.notes });
          else this.publish({ state: 'idle', version: undefined, notes: undefined });
        }
      } catch (error) {
        this.fail(error);
      }
    };
    this.checking = run().finally(() => {
      this.checking = undefined;
    });
    return this.checking;
  }
  download() {
    if (!this.state.enabled || this.state.mode !== 'auto' || !this.state.version || this.state.installing)
      return Promise.resolve();
    if (this.state.state === 'ready' || this.state.state === 'downloading')
      return this.downloading ?? Promise.resolve();
    if (this.downloading) return this.downloading;
    this.publish({ state: 'downloading', error: undefined, progress: 0 });
    this.downloading = this.options
      .driver!.download()
      .catch((error) => this.fail(error))
      .finally(() => {
        this.downloading = undefined;
      });
    return this.downloading;
  }
  configure(autoDownload: boolean) {
    const enable = !this.autoDownload && autoDownload;
    this.autoDownload = autoDownload;
    this.options.driver?.configure(autoDownload, this.installOnQuit);
    if (enable && this.state.state === 'available') void this.download();
  }
  /** Quitting never authorizes installation, even when a download is ready. */
  async prepareForQuit(_allowInstall: boolean) {
    this.installOnQuit = false;
    this.options.driver?.configure(this.autoDownload, false);
  }
  async install() {
    if (!this.state.enabled || this.state.mode !== 'auto' || this.state.state !== 'ready')
      throw new Error('更新尚未下载完成');
    if (this.state.installing) return;
    if (this.options.busy()) throw new Error('当前任务或审批结束后才可重启更新');
    const targetVersion = this.state.version!;
    this.publish({ installing: true, error: undefined });
    try {
      await this.options.beforeInstall();
      if (this.options.busy()) throw new Error('当前任务尚未结束，已取消重启更新');
      const attempt: UpdateInstallAttempt = {
        currentVersion: this.state.currentVersion,
        targetVersion,
        startedAt: Date.now(),
        outcome: 'pending',
      };
      await this.options.recordAttempt?.(attempt);
      if (!this.state.installing || this.state.state !== 'ready' || this.state.version !== targetVersion)
        throw new Error('更新状态已变化，已取消重启更新，请重试。');
      this.publish({ lastInstall: attempt });
      await this.options.driver!.install();
    } catch (error) {
      this.options.installFailed();
      this.markInstallFailed();
      this.publish({
        installing: false,
        error: error instanceof Error ? error.message : '无法准备重启更新，请重试。',
      });
      throw error;
    }
  }
  dispose() {
    clearTimeout(this.timer);
    clearInterval(this.interval);
    this.unsubscribe?.();
    this.timer = this.interval = undefined;
  }
}
