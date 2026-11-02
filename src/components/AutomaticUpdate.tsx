import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { UpdateStore } from '../lib/update-store';
import { readableError } from '../lib/format';
import { Modal } from './Modal';
export function AutomaticUpdate({
  updates,
  busy,
  install,
  flushDraft,
}: {
  updates: UpdateStore;
  busy: boolean;
  install: () => Promise<void>;
  flushDraft: () => Promise<void>;
}) {
  const checked = useSyncExternalStore(updates.subscribe, updates.getRestartWhenIdle);
  const update = useSyncExternalStore(updates.subscribe, updates.get);
  const callback = useRef(install);
  callback.current = install;
  const flush = useRef(flushDraft);
  flush.current = flushDraft;
  const [seconds, setSeconds] = useState<number>();
  const [error, setError] = useState('');
  useEffect(() => {
    setSeconds(undefined);
    if (!checked || busy || update?.state !== 'ready') return;
    let cancelled = false;
    let timer: ReturnType<typeof setInterval>;
    void flush
      .current()
      .then(() => {
        if (cancelled) return;
        const deadline = Date.now() + 5000;
        setSeconds(5);
        timer = setInterval(() => {
          const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
          setSeconds(remaining);
          if (remaining === 0) {
            clearInterval(timer);
            updates.setRestartWhenIdle(false);
            void callback.current().catch((error) => setError(readableError(error)));
          }
        }, 250);
      })
      .catch((error) => {
        if (!cancelled) {
          updates.setRestartWhenIdle(false);
          setError(readableError(error));
        }
      });
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [checked, busy, update?.state, update?.version, updates]);
  return (
    <>
      {seconds !== undefined && checked && (
        <Modal title="准备重启更新" close={() => updates.setRestartWhenIdle(false)}>
          <div className="modal-body automatic-update" role="status">
            草稿已保存，{seconds} 秒后重启更新。
          </div>
          <footer>
            <button onClick={() => updates.setRestartWhenIdle(false)}>取消重启</button>
          </footer>
        </Modal>
      )}
      {error && <p role="alert">{error}</p>}
    </>
  );
}
