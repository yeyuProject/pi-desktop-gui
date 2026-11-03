import { readableError } from '../lib/format';
import { useEffect, useRef, useState } from 'react';
import type { AppDialog } from '../../shared/app-dialogs';
import { Modal } from './Modal';
import { ErrorFeedback } from './ErrorFeedback';

/** Dismissal always cancels; Enter cannot implicitly approve a destructive action. */
export function AppDialogs() {
  const [queue, setQueue] = useState<AppDialog[]>([]);
  const [error, setError] = useState('');
  const responding = useRef(new Set<string>());
  const [pendingId, setPendingId] = useState<string>();
  useEffect(() => {
    const unsubscribe = window.desktop.onEvent((event) => {
      if (event.type === 'appDialog')
        setQueue((items) =>
          items.some((item) => item.id === event.dialog.id) ? items : [...items, event.dialog],
        );
      if (event.type === 'appDialogsCancelled') setQueue([]);
    });
    // Subscribe first: main cannot publish a request into a loading renderer.
    void window.desktop.invoke('appDialogsReady').catch(() => {});
    return unsubscribe;
  }, []);
  const dialog = queue[0];
  useEffect(() => {
    setError('');
  }, [dialog?.id]);
  if (!dialog) return null;
  const respond = async (response: number) => {
    if (responding.current.has(dialog.id)) return;
    responding.current.add(dialog.id);
    setPendingId(dialog.id);
    setError('');
    try {
      await window.desktop.invoke('respondAppDialog', dialog.id, response);
      setQueue((items) => items.filter((item) => item.id !== dialog.id));
    } catch (error) {
      setError(readableError(error));
    } finally {
      responding.current.delete(dialog.id);
      setPendingId((current) => (current === dialog.id ? undefined : current));
    }
  };
  return (
    <div data-app-dialog="true">
      <Modal key={dialog.id} title={dialog.message} close={() => void respond(dialog.cancelId)}>
        <div className="modal-body">
          {dialog.detail && <p style={{ whiteSpace: 'pre-wrap' }}>{dialog.detail}</p>}
          <ErrorFeedback message={error} />
        </div>
        <footer>
          {dialog.buttons.map((label, index) => (
            <button
              key={index}
              data-autofocus={index === dialog.cancelId ? true : undefined}
              disabled={pendingId === dialog.id}
              className={index === dialog.cancelId ? '' : 'primary'}
              onClick={() => void respond(index)}
            >
              {label}
            </button>
          ))}
        </footer>
      </Modal>
    </div>
  );
}
