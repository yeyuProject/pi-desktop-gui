import { useEffect, useState } from 'react';
import { type ExtensionDialog, type Runtime } from '../../shared/types';
import { Modal } from './Modal';
import { GoalDialog } from './GoalDialog';
import { GOAL_DIALOG_TITLE } from '../../shared/goal';

export function ExtensionPrompt({
  request,
  remaining,
  respond,
  runtime,
}: {
  request: ExtensionDialog;
  remaining: number;
  runtime: Runtime;
  respond: (values: { value?: string; confirmed?: boolean; cancelled?: boolean }) => void | Promise<void>;
}) {
  const [value, setValue] = useState(request.prefill ?? request.options?.[0] ?? '');
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!request.expiresAt) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [request.expiresAt]);
  const left = request.expiresAt ? Math.max(0, Math.ceil((request.expiresAt - now) / 1000)) : undefined;
  if (request.title === GOAL_DIALOG_TITLE)
    return (
      <GoalDialog
        runtime={runtime}
        close={() => void respond({ cancelled: true })}
        submit={async (objective, tokenBudget) => {
          await respond({ value: JSON.stringify({ action: 'start', objective, tokenBudget }) });
        }}
      />
    );
  return (
    <Modal
      title={request.title || 'Pi 需要你的输入'}
      subtitle={
        (left !== undefined ? `${left} 秒后自动关闭` : '来自当前 Pi 会话') +
        (remaining > 0 ? ` · 之后还有 ${remaining} 个问题` : '')
      }
      close={() => respond({ cancelled: true })}
    >
      <div className="modal-body">
        {request.message && <p>{request.message}</p>}
        {request.method === 'select' && (
          <div className="choice-list">
            {request.options?.map((o) => (
              <label key={o}>
                <input type="radio" checked={value === o} onChange={() => setValue(o)} />
                {o}
              </label>
            ))}
          </div>
        )}
        {request.method === 'input' && (
          <input
            type={request.title.startsWith('[密钥]') ? 'password' : 'text'}
            autoComplete="off"
            className="input"
            aria-label="回复内容"
            value={value}
            placeholder={request.placeholder}
            onChange={(e) => setValue(e.target.value)}
          />
        )}
        {request.method === 'editor' && (
          <textarea
            className="input"
            rows={8}
            aria-label="回复内容"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        )}
      </div>
      <footer>
        <button onClick={() => respond({ cancelled: true })}>取消</button>
        {request.method === 'confirm' ? (
          <>
            <button onClick={() => respond({ confirmed: false })}>否</button>
            <button className="primary" onClick={() => respond({ confirmed: true })}>
              确认
            </button>
          </>
        ) : (
          <button className="primary" onClick={() => respond({ value })}>
            提交回复
          </button>
        )}
      </footer>
    </Modal>
  );
}
