import { useState } from 'react';
import { Modal } from './Modal';
import type { CheckpointPreview } from '../../shared/checkpoints';
import '../styles/workspace-v014.css';

export interface CheckpointDialogProps {
  preview: CheckpointPreview;
  pending: boolean;
  restoredCount?: number;
  onClose: () => void;
  onConfirm: (paths: string[], revision: string) => void;
  onReturnToMessage: () => void;
}

export function CheckpointDialog({
  preview,
  pending,
  restoredCount,
  onClose,
  onConfirm,
  onReturnToMessage,
}: CheckpointDialogProps) {
  const [selected, setSelected] = useState(
    () => new Set(preview.files.filter((file) => file.selected).map((file) => file.path)),
  );
  return (
    <Modal
      title={restoredCount === undefined ? `撤销第 ${preview.turn} 轮起的文件修改` : '文件已恢复'}
      close={() => {
        if (!pending) onClose();
      }}
      wide
    >
      <div className="checkpoint-dialog-body">
        {restoredCount !== undefined ? (
          <>
            <p>
              已把 {restoredCount} 个文件恢复到第 {preview.turn} 轮之前。
            </p>
            <button onClick={onReturnToMessage}>同时回到这条消息之前的对话</button>
          </>
        ) : (
          <>
            <p>只恢复勾选的项目文件。数据库、网络请求、已安装的依赖等命令副作用不会撤销。</p>
            {preview.includesCommitted && (
              <p className="checkpoint-warning">包含已提交的内容。恢复后，这些差异会显示为未提交变更。</p>
            )}
            {!preview.available && <p className="inline-error">{preview.invalidReason}</p>}
            {preview.files.some((file) => file.manual) && (
              <p className="checkpoint-warning">手动改过或无法确认归属的文件默认不勾选，请逐项确认。</p>
            )}
            <div className="checkpoint-files">
              {preview.files.map((file) => (
                <label key={file.path} className={file.manual ? 'manual' : ''}>
                  <input
                    type="checkbox"
                    checked={selected.has(file.path)}
                    disabled={pending}
                    onChange={(event) =>
                      setSelected((old) => {
                        const next = new Set(old);
                        if (event.target.checked) next.add(file.path);
                        else next.delete(file.path);
                        return next;
                      })
                    }
                  />
                  <span>
                    {file.path}
                    <small>
                      {file.status}
                      {file.manual ? ' · 手动改过 / 无法确认归属' : ''}
                      {file.existedBeforeRun ? ' · 保留该轮之前已有的修改' : ''}
                    </small>
                  </span>
                </label>
              ))}
              {!preview.files.length && <p className="empty-small">没有需要恢复的文件。</p>}
            </div>
            {!!preview.omitted.length && (
              <details className="omitted">
                <summary>{preview.omitted.length} 个路径未纳入检查点，不会自动恢复</summary>
                <p>包括超出扫描上限、无法安全保存或旧检查点未记录的路径；/** 表示整个子目录。</p>
                <textarea
                  className="input"
                  rows={8}
                  aria-label="未纳入检查点的路径"
                  readOnly
                  value={preview.omitted.join('\n')}
                />
              </details>
            )}
            <div className="modal-actions">
              <button onClick={onClose} disabled={pending}>
                取消
              </button>
              <button
                className="danger"
                disabled={pending || !selected.size || !preview.available}
                onClick={() => onConfirm([...selected], preview.revision)}
              >
                {pending ? '正在恢复…' : `恢复 ${selected.size} 个文件`}
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
