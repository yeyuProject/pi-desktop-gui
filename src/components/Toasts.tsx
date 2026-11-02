import { X, CheckCircle2, AlertCircle, Info, TriangleAlert } from 'lucide-react';
import { IconButton } from './IconButton';
import type { Workbench } from '../hooks/useWorkbench';

export function Toasts(props: Pick<Workbench, 'notice' | 'noticeAction' | 'setDismissed' | 'toasts'>) {
  const { notice, setDismissed, toasts } = props;

  return (
    <>
      {(notice || toasts.length > 0) && (
        <div className="toast-stack" aria-live="polite">
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
      )}
    </>
  );
}
