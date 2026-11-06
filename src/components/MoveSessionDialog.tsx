import { useEffect, useState } from 'react';
import type { Project, Session } from '../../shared/types';
import { Modal } from './Modal';
import { readableError } from '../lib/format';

export function MoveSessionDialog({
  session,
  projects,
  close,
  move,
}: {
  session: Session;
  projects: Project[];
  close: () => void;
  move: (target: string | null, token: string) => Promise<void>;
}) {
  const [target, setTarget] = useState<string>();
  const [preview, setPreview] = useState<{ detail: string; token: string }>();
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setPreview(undefined);
    setError('');
    if (target !== undefined)
      void window.desktop.invoke('previewSessionMove', session.id, target || null).then(
        (value) => {
          if (!cancelled) setPreview(value);
        },
        (cause) => {
          if (!cancelled) setError(readableError(cause));
        },
      );
    return () => {
      cancelled = true;
    };
  }, [target, session.id]);
  const submit = async () => {
    if (pending || target === undefined || !preview) return;
    setPending(true);
    try {
      await move(target || null, preview.token);
      close();
    } catch (cause) {
      setError(readableError(cause));
      setPreview(undefined);
    } finally {
      setPending(false);
    }
  };
  return (
    <Modal
      title="移动会话"
      subtitle={session.title}
      close={() => {
        if (!pending) close();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="modal-body">
          <div className="choice-list" role="radiogroup" aria-label="目标项目">
            {[{ id: '', name: '对话（不属于任何项目）', path: '' }, ...projects].map((project) => {
              const current = project.id === (session.projectId ?? '');
              return (
                <label key={project.id}>
                  <input
                    type="radio"
                    name="move-target"
                    value={project.id}
                    checked={target === project.id}
                    disabled={current || pending}
                    onChange={() => setTarget(project.id)}
                  />
                  <span className="move-target-label">
                    {project.name}
                    {current && ' · 当前'}
                    {project.path && <small title={project.path}>{project.path}</small>}
                  </span>
                </label>
              );
            })}
          </div>
          {preview && <p className="move-effects">{preview.detail}</p>}
          {error && <p role="alert">{error}</p>}
        </div>
        <footer>
          <button type="button" disabled={pending} onClick={close}>
            取消
          </button>
          <button type="submit" className="primary" disabled={pending || !preview}>
            {pending ? '移动中…' : '移动'}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
