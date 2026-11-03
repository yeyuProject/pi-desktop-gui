import { useEffect, useRef } from 'react';
import { X, CheckCircle2, AlertCircle, Info, TriangleAlert } from 'lucide-react';
import { IconButton } from './IconButton';
import type { Workbench } from '../hooks/useWorkbench';

type ToastProps = Pick<Workbench, 'notice' | 'noticeAction' | 'setDismissed' | 'setToastsPaused' | 'toasts'>;

export function Toasts(props: ToastProps) {
  return props.notice || props.toasts.length > 0 ? <ToastStack {...props} /> : null;
}

function ToastStack(props: ToastProps) {
  const { notice, setDismissed, setToastsPaused, toasts } = props;
  const hold = useRef({ hover: false, focus: false });
  const update = (next: Partial<typeof hold.current>) => {
    hold.current = { ...hold.current, ...next };
    setToastsPaused(hold.current.hover || hold.current.focus);
  };
  // Closing the last toast under the pointer unmounts the stack without a mouseleave.
  useEffect(() => () => setToastsPaused(false), []);

  return (
    <div
      className="toast-stack"
      aria-live="polite"
      onMouseEnter={() => update({ hover: true })}
      onMouseLeave={() => update({ hover: false })}
      onFocus={() => update({ focus: true })}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) update({ focus: false });
      }}
    >
      {toasts.map((n) => (
        <div className={'toast ' + n.level} role={n.level === 'error' ? 'alert' : 'status'} key={n.id}>
          {n.level === 'error' ? (
            <AlertCircle size={16} />
          ) : n.level === 'warning' ? (
            <TriangleAlert size={16} />
          ) : (
            <Info size={16} />
          )}
          <span>{n.text}</span>
          <IconButton title="关闭通知" onClick={() => setDismissed((v) => [...v, n.id].slice(-20))}>
            <X size={13} />
          </IconButton>
        </div>
      ))}
      {notice && (
        <div className="toast" role="status">
          <CheckCircle2 size={16} />
          <span>{notice}</span>
          {props.noticeAction?.text === notice && (
            <button onClick={props.noticeAction.run}>{props.noticeAction.label}</button>
          )}
        </div>
      )}
    </div>
  );
}
