import { useState } from 'react';
import { Download, RefreshCw, ExternalLink } from 'lucide-react';
import {
  installationLabels,
  releaseUrl,
  updateInstallNotice,
  type UpdateState,
} from '../../shared/app-update';
import { Modal } from './Modal';
import { RichText } from './conversation/Markdown';
import { readableError } from '../lib/format';
const api = window.desktop;

interface UpdateProps {
  update: UpdateState;
  busy: boolean;
  install: () => Promise<void>;
}
export function UpdateBadge({ update, open }: { update?: UpdateState; open: () => void }) {
  if (!update) return null;
  const offered = update.version && ['available', 'downloading', 'ready'].includes(update.state);
  if (!offered && !updateInstallNotice(update)) return null;
  return (
    <button className="update-badge" onClick={open}>
      {!offered
        ? '上次更新结果待确认'
        : update.state === 'ready'
          ? `重启以更新到 v${update.version}`
          : update.state === 'downloading'
            ? `正在下载更新 ${Math.floor(update.progress ?? 0)}%`
            : `v${update.version} 可用`}
    </button>
  );
}
function UpdateActions({ update, busy, install }: UpdateProps) {
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
      {update.state === 'downloading' && (
        <div className="update-progress">
          <progress aria-label="更新下载进度" max={100} value={update.progress ?? 0} />
          <span>正在下载 {Math.floor(update.progress ?? 0)}%</span>
        </div>
      )}
      {(update.error || error) && (
        <p className="inline-error" role="alert">
          {error || update.error}
        </p>
      )}
      {installNotice && (
        <p className="environment-note" role="status">
          {installNotice}
        </p>
      )}
      {update.state === 'ready' && busy && (
        <p className="environment-note">当前任务或审批结束后可重启更新。</p>
      )}
      <div className="button-row">
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
export function UpdateDialog({ update, busy, install, close }: UpdateProps & { close: () => void }) {
  return (
    <Modal title={`Pi Desktop v${update.version ?? update.currentVersion}`} close={close}>
      <div className="modal-body">
        <div className="update-notes">
          {update.notes ? <RichText text={update.notes} /> : <p>更新说明暂不可用，可前往版本页面查看。</p>}
        </div>
        {update.installation === 'portable' && (
          <p className="environment-note">安装版可在应用内自动更新，建议下载 Windows 安装版。</p>
        )}
        <UpdateActions update={update} busy={busy} install={install} />
      </div>
      <footer>
        {update.state === 'ready' && <span>选择稍后会保留下载；仅在点击“立即重启”后安装。</span>}
        <button disabled={update.installing} onClick={close}>
          稍后
        </button>
      </footer>
    </Modal>
  );
}
export function AboutUpdates({
  update,
  busy,
  install,
  autoDownload,
  saveAutoDownload,
  readOnly,
}: UpdateProps & {
  autoDownload: boolean;
  saveAutoDownload: (value: boolean) => Promise<void>;
  readOnly: boolean;
}) {
  const [error, setError] = useState('');
  const run = async (action: () => Promise<unknown>) => {
    setError('');
    try {
      await action();
    } catch (error) {
      setError(readableError(error));
    }
  };
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
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      <UpdateActions update={update} busy={busy} install={install} />
      {update.notes && (
        <details className="update-notes">
          <summary>更新说明</summary>
          <RichText text={update.notes} />
        </details>
      )}
    </section>
  );
}
