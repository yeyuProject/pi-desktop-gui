import { useState, useSyncExternalStore } from 'react';
import { RefreshCw } from 'lucide-react';
import type { UpdateStore } from '../lib/update-store';
import { releaseUrl } from '../../shared/app-update';
import { readableError } from '../lib/format';
import { Modal } from './Modal';
import { RichText } from './conversation/Markdown';
import { ErrorFeedback } from './ErrorFeedback';
import { RestartAfterTasks, UpdateActions } from './UpdateDetails';
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
  return (
    <Modal
      title={update.version ? `更新到 v${update.version}` : 'Pi Desktop 更新'}
      subtitle={`当前版本 v${update.currentVersion}`}
      close={close}
    >
      <div className="modal-body update-dialog">
        {ready && <p className="update-lead">新版本已下载，重启后生效。</p>}
        {update.notes ? (
          <div className="update-notes">
            <RichText text={update.notes} />
          </div>
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
              <small id="update-restart-hint">
                {busy
                  ? '任务或审批进行中，结束后才能重启。'
                  : '勾选后，下一个任务结束时先倒计时 5 秒，可以取消。'}
              </small>
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
