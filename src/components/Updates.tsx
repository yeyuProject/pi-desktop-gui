import { useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { downloadSummary, updateInstallNotice, type UpdateState } from '../../shared/app-update';
import type { UpdateStore } from '../lib/update-store';
export function verificationLabel(update: UpdateState) {
  return update.installation === 'mac' ? '正在校验并准备更新…' : '正在校验更新…';
}
function announcement(update?: UpdateState) {
  if (update?.state === 'downloading') {
    if (update.download?.phase === 'verifying') return verificationLabel(update);
    return update.download?.stalled ? '等待网络响应…' : '开始下载更新。';
  }
  if (update?.state === 'ready') return '更新已下载，可以重启安装。';
  if (update?.state === 'error') return update.error;
  return '';
}
export function UpdateBadge({ updates, open }: { updates: UpdateStore; open: () => void }) {
  const update = useSyncExternalStore(updates.subscribe, updates.get);
  // Keep one live region outside the sidebar's hidden subtree, including while a dialog is open.
  const status = createPortal(
    <span className="update-announcement" role="status" aria-atomic="true">
      {announcement(update)}
    </span>,
    document.body,
  );
  if (!update) return status;
  const offered = update.version && ['available', 'downloading', 'ready'].includes(update.state);
  if (!offered && !updateInstallNotice(update)) return status;
  return (
    <>
      {status}
      <button className="update-badge" onClick={open}>
        {!offered
          ? '上次更新结果待确认'
          : update.state === 'ready'
            ? `重启以更新到 v${update.version}`
            : update.state === 'downloading'
              ? downloadSummary(update)
              : `v${update.version} 可用`}
      </button>
    </>
  );
}
