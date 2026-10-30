export type UpdateInstallation = 'nsis' | 'portable' | 'appimage' | 'deb' | 'mac' | 'development';
export interface UpdateDownload {
  transferred: number;
  total: number;
  differential: boolean;
  bytesPerSecond?: number;
  remainingMs?: number;
  stalled: boolean;
  phase: 'connecting' | 'transferring' | 'verifying';
}
export interface UpdateInstallAttempt {
  currentVersion: string;
  targetVersion: string;
  startedAt: number;
  outcome: 'pending' | 'failed' | 'unconfirmed' | 'completed';
}
export interface UpdateState {
  state: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error';
  currentVersion: string;
  installation: UpdateInstallation;
  mode: 'auto' | 'notify';
  enabled: boolean;
  disabledReason?: string;
  checkedAt?: number;
  version?: string;
  progress?: number;
  size?: number;
  download?: UpdateDownload;
  notes?: string;
  error?: string;
  installing: boolean;
  lastInstall?: UpdateInstallAttempt;
}

/** Byte quantities use the total's unit when displaying a downloaded/total pair. */
export function formatBytes(bytes: number, unitOf = bytes) {
  const [unit, divisor] =
    unitOf >= 1024 ** 3
      ? (['GB', 1024 ** 3] as const)
      : unitOf >= 1024 ** 2
        ? (['MB', 1024 ** 2] as const)
        : (['KB', 1024] as const);
  return `${(bytes / divisor).toFixed(1)} ${unit}`;
}

export function formatRemaining(ms: number) {
  if (ms < 5000) return '剩余不到 5 秒';
  if (ms < 60000) return `剩余约 ${Math.ceil(ms / 5000) * 5} 秒`;
  if (ms < 3600000) return `剩余约 ${Math.ceil(ms / 60000)} 分钟`;
  const minutes = Math.ceil(ms / 60000);
  return `剩余约 ${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

export function downloadSummary(update: UpdateState) {
  const download = update.download;
  if (download?.phase === 'verifying') return '正在校验更新…';
  if (download?.stalled) return '等待网络响应…';
  if (download?.phase === 'connecting') return '正在连接…';
  const remaining = download?.remainingMs === undefined ? '' : ` · ${formatRemaining(download.remainingMs)}`;
  return `正在下载更新 ${Math.floor(update.progress ?? 0)}%${remaining}`;
}

export function updateInstallNotice(update: UpdateState) {
  const attempt = update.lastInstall;
  if (!attempt || !['failed', 'unconfirmed'].includes(attempt.outcome)) return undefined;
  if (compareAppVersions(update.currentVersion, attempt.targetVersion) >= 0) return undefined;
  const versions = `上次尝试更新到 v${attempt.targetVersion}，当前仍是 v${update.currentVersion}。`;
  return attempt.outcome === 'failed'
    ? `${versions}无法启动更新安装程序，或安装程序报告了错误。请重试或下载完整安装包。`
    : `${versions}尚未确认更新完成。如果安装程序仍在运行，请等待完成；否则可重试或下载完整安装包。`;
}

export const RELEASES_URL = 'https://github.com/yeyuProject/pi-desktop-gui/releases';
export const LATEST_RELEASE_API = 'https://api.github.com/repos/yeyuProject/pi-desktop-gui/releases/latest';
export const installationLabels: Record<UpdateInstallation, string> = {
  nsis: 'Windows 安装版',
  portable: 'Windows 便携版',
  appimage: 'Linux AppImage',
  deb: 'Linux deb',
  mac: 'macOS',
  development: '开发环境',
};

/** The desktop release channel accepts stable x.y.z versions only. */
export function stableVersion(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^v?((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/.exec(value);
  if (!match || !match[1].split('.').every((part) => Number.isSafeInteger(Number(part)))) return undefined;
  return match[1];
}
export function compareAppVersions(left: string, right: string) {
  const a = stableVersion(left),
    b = stableVersion(right);
  if (!a || !b) throw new Error('应用版本号无效');
  const partsA = a.split('.').map(Number),
    partsB = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (partsA[i] !== partsB[i]) return Math.sign(partsA[i] - partsB[i]);
  return 0;
}
export function releaseUrl(version?: string) {
  const valid = stableVersion(version);
  return valid ? `${RELEASES_URL}/tag/v${valid}` : RELEASES_URL;
}
