import { useRef, useState } from 'react';
import { Modal } from '../components/Modal';

export function useUnsavedChanges(dirty: boolean) {
  const [open, setOpen] = useState(false);
  const leave = useRef<() => void>(() => {});
  return {
    confirmLeave(action: () => void) {
      if (!dirty) {
        action();
        return;
      }
      leave.current = action;
      setOpen(true);
    },
    confirmation: open ? (
      <Modal title="放弃尚未保存的修改？" close={() => setOpen(false)}>
        <div className="modal-body">修改尚未保存。你可以继续编辑，或放弃修改后离开。</div>
        <footer>
          <button data-autofocus onClick={() => setOpen(false)}>
            继续编辑
          </button>
          <button
            className="danger"
            onClick={() => {
              setOpen(false);
              leave.current();
            }}
          >
            放弃修改
          </button>
        </footer>
      </Modal>
    ) : null,
  };
}
