import { useState, useSyncExternalStore } from 'react';
import { CircleCheck, Download, RefreshCw, Sparkles } from 'lucide-react';
import type { UpdateStore } from '../lib/update-store';
import { releaseUrl } from '../../shared/app-update';
import { readableError } from '../lib/format';
import { Modal } from './Modal';
import { RichText } from './conversation/Markdown';
import { ErrorFeedback } from './ErrorFeedback';
import { RestartAfterTasks, UpdateActions, UpdateStatus, restartHint } from './UpdateDetails';
type UpdateSubscription = { updates: UpdateStore; busy: boolean; install: () => Promise<void> };
export function UpdateDialog({ updates, busy, install, close }: UpdateSubscription & { close: () => void }) {
  const update = useSyncExternalStore(updates.subscribe, updates.get);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  if (!update) return null;
  // A downloaded update needs one decision: restart now or later. Keep that pair in the footer.
  const ready = update.mode === 'auto' && update.state === 'ready';
  const restart = async () => {
    setError('');
    setPending(true);
    try {
      await install();
    } catch (cause) {
      setError(readableError(cause));
    } finally {
      setPending(false);
    }
  };
  const openRelease = () =>
    void window.desktop
      .invoke('openLink', releaseUrl(update.version))
      .catch((cause) => setError(readableError(cause)));
  const status = ready
    ? { icon: <CircleCheck size={18} />, title: '新版本已下载', detail: '重启后生效，草稿会先保存。' }
    : update.state === 'downloading'
      ? {
          icon: <Download size={18} />,
          title: '正在下载新版本',
          detail: '下载在后台进行，不会中断当前任务。',
        }
      : update.state === 'available' && update.version
        ? { icon: <Sparkles size={18} />, title: '发现新版本' }
        : undefined;
  return (
    <Modal
      title={update.version ? `更新到 v${update.version}` : 'Pi Desktop 更新'}
      subtitle={`当前版本 v${update.currentVersion}`}
      close={close}
    >
      <div className="modal-body update-dialog">
        {status && <UpdateStatus state={update.state} {...status} />}
        {update.notes ? (
          <section className="update-notes" aria-label="更新内容">
            <h3>更新内容</h3>
            <div className="update-notes-body">
              <RichText text={update.notes} />
            </div>
          </section>
        ) : (
          update.version && (
            <p className="update-notes-missing">
              这个版本没有附带更新说明。
              <button className="inline-link" onClick={openRelease}>
                查看版本页面
              </button>
            </p>
          )
        )}
        {update.installation === 'portable' && (
          <p className="environment-note">安装版可在应用内自动更新，建议下载 Windows 安装版。</p>
        )}
        {ready ? (
          <>
            <ErrorFeedback message={error || update.error} role={error ? 'alert' : undefined} />
            <div className="update-restart-option">
              <RestartAfterTasks updates={updates} />
              <small id="update-restart-hint">{restartHint(busy)}</small>
            </div>
          </>
        ) : (
          <UpdateActions update={update} busy={busy} install={install} updates={updates} />
        )}
      </div>
      <footer>
        <button disabled={update.installing} onClick={close}>
          稍后
        </button>
        {ready && (
          <button
            className="primary"
            aria-describedby="update-restart-hint"
            disabled={busy || pending || update.installing}
            onClick={() => void restart()}
          >
            <RefreshCw size={14} />
            {update.installing ? '正在准备重启…' : '立即重启'}
          </button>
        )}
      </footer>
    </Modal>
  );
}
