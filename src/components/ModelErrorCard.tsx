import { useState } from 'react';
import { AlertCircle } from 'lucide-react';
import { CopyButton } from './CopyButton';
import { ErrorFeedback } from './ErrorFeedback';
import { describeModelError, redact, type ModelErrorAction, type ModelErrorKind } from '../../shared/errors';

const actionLabels: Record<ModelErrorAction, string> = {
  providers: '管理供应商与登录',
  billing: '查看额度处理说明',
  regenerate: '重新生成',
  compact: '压缩上下文',
  model: '选择模型',
  proxy: '检查 HTTP 代理',
};
export function ModelErrorCard({
  error,
  kind,
  count,
  disabled,
  autoCompaction,
  act,
  enableCompaction,
  copy,
}: {
  error: string;
  kind: ModelErrorKind;
  count?: number;
  disabled: boolean;
  autoCompaction?: boolean;
  act: (action: ModelErrorAction) => Promise<unknown>;
  enableCompaction: () => Promise<unknown>;
  copy: (text: string) => Promise<unknown>;
}) {
  const description = describeModelError(kind);
  const [pending, setPending] = useState(false);
  const [billing, setBilling] = useState(false);
  const [failure, setFailure] = useState('');
  const run = async (action: () => Promise<unknown>) => {
    setPending(true);
    setFailure('');
    try {
      await action();
      return true;
    } catch (error) {
      setFailure(redact(String(error)));
      return false;
    } finally {
      setPending(false);
    }
  };
  const details = redact(error);
  return (
    <section className="model-error-card" role="alert" aria-label={description.title}>
      <div className="model-error-heading">
        <AlertCircle size={17} />
        <strong>{description.title}</strong>
      </div>
      <p>
        {description.detail}
        {(count ?? 0) >= 3 && <span> 已连续失败 {count} 次。</span>}
      </p>
      <div className="button-row">
        {description.action && (
          <button
            disabled={disabled || pending}
            onClick={() =>
              description.action === 'billing'
                ? setBilling(!billing)
                : void run(() => act(description.action!))
            }
          >
            {actionLabels[description.action]}
          </button>
        )}
        {kind === 'context' && !autoCompaction && (
          <button disabled={disabled || pending} onClick={() => void run(enableCompaction)}>
            开启自动压缩
          </button>
        )}
        <CopyButton disabled={pending} title="复制详细信息" copy={() => run(() => copy(details))} />
      </div>
      {billing && (
        <p className="environment-note">
          请登录当前模型供应商的网站，检查账单、余额和用量上限；充值或调整额度后，再回到这里重新发送。
        </p>
      )}
      <ErrorFeedback message={failure} />
      <details open={kind === 'unknown'}>
        <summary>查看详细信息</summary>
        <pre>{details}</pre>
      </details>
    </section>
  );
}
