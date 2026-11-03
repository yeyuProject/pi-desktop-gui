import { useState, useSyncExternalStore } from 'react';
import { Download, RefreshCw, ExternalLink } from 'lucide-react';
import {
  installationLabels,
  releaseUrl,
  updateInstallNotice,
  formatBytes,
  formatRemaining,
  type UpdateState,
} from '../../shared/app-update';
import { RichText } from './conversation/Markdown';
import { ErrorFeedback } from './ErrorFeedback';
import { readableError } from '../lib/format';
import type { UpdateStore } from '../lib/update-store';
const api = window.desktop;

import { verificationLabel } from './Updates';
interface UpdateProps {
  update: UpdateState;
  busy: boolean;
  install: () => Promise<void>;
  updates?: UpdateStore;
}
type UpdateSubscription = Omit<UpdateProps, 'update'> & { updates: UpdateStore };
export function DownloadProgress({ update }: { update: UpdateState }) {
  const download = update.download;
  if (!download) return null;
  const transferring = download.phase === 'transferring';
  const phase =
    download.phase === 'verifying'
      ? verificationLabel(update)
      : download.stalled
        ? '等待网络响应…'
        : '正在连接…';
  const remaining = download.remainingMs === undefined ? undefined : formatRemaining(download.remainingMs);
  const transferred = formatBytes(download.transferred, download.total),
    total = formatBytes(download.total);
  const speed = download.stalled
    ? '等待网络响应…'
    : download.bytesPerSecond === undefined
      ? '正在估算…'
      : `${formatBytes(download.bytesPerSecond)}/s`;
  return (
    <div className="update-progress">
      <div className="update-progress-track">
        <progress
          aria-label="更新下载进度"
          max={100}
          value={transferring ? update.progress : undefined}
          aria-valuetext={
            transferring
              ? `已下载 ${transferred}，共 ${total}${remaining && !download.stalled ? `，${remaining}` : ''}${download.stalled ? '，等待网络响应' : ''}`
              : phase
          }
        />
        {transferring && <span>{Math.floor(update.progress ?? 0)}%</span>}
      </div>
      <p className="update-download-detail">
        {transferring
          ? `${transferred} / ${total} · ${speed}${remaining && !download.stalled ? ` · ${remaining}` : ''}`
          : phase}
      </p>
      {transferring && download.differential && update.size !== undefined && (
        <p className="update-download-detail">
          增量更新：安装包 {formatBytes(update.size)}，只需下载变化部分
        </p>
      )}
    </div>
  );
}
export function UpdateActions({ update, busy, install, updates }: UpdateProps) {
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const installNotice = updateInstallNotice(update);
  const run = async (action: () => Promise<unknown>) => {
    setError('');
    setPending(true);
    try {
      await action();
    } catch (error) {
      setError(readableError(error));
    } finally {
      setPending(false);
    }
  };
  return (
    <>
      {update.state === 'available' && update.size !== undefined && (
        <p className="update-package-size">安装包 {formatBytes(update.size)}</p>
      )}
      {update.state === 'downloading' && <DownloadProgress update={update} />}
      <ErrorFeedback message={error || update.error} role={error ? 'alert' : undefined} />
      {installNotice && (
        <p className="environment-note" role="status">
          {installNotice}
        </p>
      )}
      {update.state === 'ready' && busy && (
        <p className="environment-note">当前任务或审批结束后可重启更新。</p>
      )}
      <div className="button-row">
        {update.state === 'ready' && updates && <RestartAfterTasks updates={updates} />}
        {update.mode === 'auto' && update.state === 'ready' ? (
          <button
            className="primary"
            disabled={busy || pending || update.installing}
            onClick={() => void run(install)}
          >
            <RefreshCw size={14} />
            {update.installing ? '正在准备重启…' : '立即重启'}
          </button>
        ) : update.mode === 'auto' && update.version && ['available', 'error'].includes(update.state) ? (
          <button
            disabled={!update.enabled || pending}
            onClick={() => void run(() => api.invoke('downloadUpdate'))}
          >
            <Download size={14} />
            {update.state === 'error' ? '重试下载' : '下载更新'}
          </button>
        ) : null}
        {(update.version || update.state === 'error' || installNotice) && (
          <button
            onClick={() =>
              void run(() =>
                api.invoke('openLink', releaseUrl(update.version ?? update.lastInstall?.targetVersion)),
              )
            }
          >
            <ExternalLink size={14} />
            前往下载
          </button>
        )}
        {(update.state === 'error' || (installNotice && update.state === 'idle')) && (
          <button
            disabled={!update.enabled || pending}
            onClick={() => void run(() => api.invoke('checkUpdate'))}
          >
            重新检查
          </button>
        )}
      </div>
    </>
  );
}
export function AboutUpdates({
  updates,
  busy,
  install,
  autoDownload,
  saveAutoDownload,
  readOnly,
}: UpdateSubscription & {
  autoDownload: boolean;
  saveAutoDownload: (value: boolean) => Promise<void>;
  readOnly: boolean;
}) {
  const update = useSyncExternalStore(updates.subscribe, updates.get);
  const [error, setError] = useState('');
  const run = async (action: () => Promise<unknown>) => {
    setError('');
    try {
      await action();
    } catch (error) {
      setError(readableError(error));
    }
  };
  if (!update) return null;
  return (
    <section className="about-updates" aria-label="关于与更新">
      <h3>关于与更新</h3>
      <dl>
        <dt>当前版本</dt>
        <dd>v{update.currentVersion}</dd>
        <dt>安装方式</dt>
        <dd>{installationLabels[update.installation]}</dd>
        <dt>上次检查</dt>
        <dd>{update.checkedAt ? new Date(update.checkedAt).toLocaleString('zh-CN') : '尚未检查'}</dd>
      </dl>
      {!update.enabled && <p className="environment-note">{update.disabledReason}</p>}
      {update.mode === 'notify' && update.enabled && (
        <p className="environment-note">此安装方式只检查和提示新版本，请从版本页面下载安装。</p>
      )}
      {update.installation === 'portable' && (
        <p className="environment-note">Windows 安装版可在应用内自动更新，便携版需要手动下载。</p>
      )}
      <label className="check-row">
        <input
          type="checkbox"
          checked={autoDownload}
          disabled={readOnly || update.mode !== 'auto'}
          onChange={(event) => void run(() => saveAutoDownload(event.target.checked))}
        />
        <span>
          自动下载更新<small>启动后检查一次，之后每 6 小时检查；下载不会中断当前任务。</small>
        </span>
      </label>
      <div className="button-row">
        <button
          disabled={
            !update.enabled || update.installing || ['checking', 'downloading'].includes(update.state)
          }
          onClick={() => void run(() => api.invoke('checkUpdate'))}
        >
          <RefreshCw size={14} />
          {update.state === 'checking' ? '正在检查…' : '检查更新'}
        </button>
        <button onClick={() => void run(() => api.invoke('openLink', releaseUrl(update.currentVersion)))}>
          查看本版更新说明
        </button>
      </div>
      {update.state === 'idle' && update.checkedAt && <p className="environment-note">当前已是最新版本。</p>}
      {update.version && <h4>新版本 v{update.version}</h4>}
      <ErrorFeedback message={error} />
      <UpdateActions update={update} busy={busy} install={install} updates={updates} />
      {update.notes && (
        <details className="update-notes">
          <summary>更新说明</summary>
          <RichText text={update.notes} />
        </details>
      )}
    </section>
  );
}
function RestartAfterTasks({ updates }: { updates: UpdateStore }) {
  const checked = useSyncExternalStore(updates.subscribe, updates.getRestartWhenIdle);
  return (
    <label className="check-row">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => updates.setRestartWhenIdle(event.target.checked)}
      />
      任务结束后自动重启
    </label>
  );
}
