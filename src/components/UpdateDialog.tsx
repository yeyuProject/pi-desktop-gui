import { useSyncExternalStore } from 'react';
import type { UpdateStore } from '../lib/update-store';
import { Modal } from './Modal';
import { RichText } from './conversation/Markdown';
import { UpdateActions } from './UpdateDetails';
type UpdateSubscription = { updates: UpdateStore; busy: boolean; install: () => Promise<void> };
export function UpdateDialog({ updates, busy, install, close }: UpdateSubscription & { close: () => void }) {
  const update = useSyncExternalStore(updates.subscribe, updates.get);
  if (!update) return null;
  return (
    <Modal title={`Pi Desktop v${update.version ?? update.currentVersion}`} close={close}>
      <div className="modal-body">
        <div className="update-notes">
          {update.notes ? <RichText text={update.notes} /> : <p>更新说明暂不可用，可前往版本页面查看。</p>}
        </div>
        {update.installation === 'portable' && (
          <p className="environment-note">安装版可在应用内自动更新，建议下载 Windows 安装版。</p>
        )}
        <UpdateActions update={update} busy={busy} install={install} updates={updates} />
      </div>
      <footer>
        {update.state === 'ready' && (
          <span>选择稍后会保留下载；勾选自动重启时，任务结束后会开始可取消的倒计时。</span>
        )}
        <button disabled={update.installing} onClick={close}>
          稍后
        </button>
      </footer>
    </Modal>
  );
}
