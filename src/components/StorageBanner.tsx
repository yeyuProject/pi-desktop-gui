import { useState } from 'react';
import { TriangleAlert } from 'lucide-react';
import type { StorageStatus } from '../../shared/types';

export function StorageBanner({
  storage,
  openDirectory,
}: {
  storage: StorageStatus;
  openDirectory: () => void;
}) {
  const [dismissed, setDismissed] = useState<string>();
  const [retrying, setRetrying] = useState(false);
  const recovery = storage.recovery;
  const recoveryId =
    recovery && JSON.stringify([recovery.corruptFile, recovery.recoveredFrom, recovery.backupAt]);
  if (storage.writable && (!recovery || dismissed === recoveryId)) return null;
  const restoredAt =
    recovery?.backupAt &&
    new Intl.DateTimeFormat('zh-CN', {
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(recovery.backupAt);
  return (
    <section className="storage-banner" role="alert" aria-label="本地数据状态">
      <TriangleAlert size={18} />
      <div>
        {!storage.writable && <p>{storage.problem}</p>}
        {recovery?.recoveredFrom ? (
          <p>
            本地会话索引{recovery.corruptFile ? '已损坏' : '缺失'}，已恢复到 {restoredAt}{' '}
            的备份。恢复时间之后的草稿改动可能未保存。
          </p>
        ) : recovery?.restarted ? (
          <p>未找到可用备份，已重新开始；Pi 会话文件仍在，可在搜索面板 → Pi 历史会话中重新打开。</p>
        ) : null}
        {recovery && (recovery.discardedProjects > 0 || recovery.discardedSessions > 0) && (
          <p>
            已忽略 {recovery.discardedProjects} 个损坏的项目入口和 {recovery.discardedSessions}{' '}
            条损坏的会话索引；其余内容已保留。
          </p>
        )}
        {!!recovery?.repairedSettings && <p>已将 {recovery.repairedSettings} 项无效设置恢复为默认值。</p>}
        {recovery?.corruptFile && <p>损坏的原文件已保留在数据目录。</p>}
      </div>
      <button onClick={openDirectory}>打开数据目录</button>
      {storage.retryable && (
        <button
          disabled={retrying}
          onClick={async () => {
            setRetrying(true);
            try {
              await window.desktop.invoke('retryStorage');
            } catch {
            } finally {
              setRetrying(false);
            }
          }}
        >
          {retrying ? '正在保存…' : '重试保存'}
        </button>
      )}
      {storage.writable && <button onClick={() => setDismissed(recoveryId)}>知道了</button>}
    </section>
  );
}
