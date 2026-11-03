import { useEffect, useState } from 'react';
import { AlertCircle } from 'lucide-react';
import type { Changes, Runtime } from '../../shared/types';
import { readableError } from '../lib/format';
import { ErrorFeedback } from './ErrorFeedback';

const defaultPrompt = '上一轮因进程退出中断，请检查当前文件状态后继续完成任务';
export function CrashCard({
  crash,
  projectId,
  sessionId,
  disabled,
  recover,
  inspect,
  undo,
  diagnostic,
}: {
  crash: NonNullable<Runtime['crash']>;
  projectId?: string;
  sessionId: string;
  disabled: boolean;
  recover: (prompt?: string) => Promise<void>;
  inspect: () => void;
  undo: () => Promise<void>;
  diagnostic: () => void;
}) {
  disabled ||= crash.cleanup !== 'confirmed';
  const [prompt, setPrompt] = useState(defaultPrompt);
  const [pending, setPending] = useState(false);
  const [changes, setChanges] = useState<Changes>();
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!projectId) return;
    let active = true;
    window.desktop
      .invoke('changes', projectId, 'run', { sessionId })
      .then((value) => {
        if (active) {
          setChanges(value);
          setError(value.error ?? '');
        }
      })
      .catch((error) => {
        if (active) setError(readableError(error));
      });
    return () => {
      active = false;
    };
  }, [projectId, sessionId, crash.at, revision]);
  const run = async (action: () => Promise<void>) => {
    setPending(true);
    try {
      await action();
    } catch (error) {
      setError(readableError(error));
    } finally {
      setPending(false);
    }
  };
  return (
    <section className="crash-card" aria-label="Pi 意外退出" tabIndex={-1}>
      <h3>
        <AlertCircle size={18} /> Pi {crash.lastTool ? `在调用 ${crash.lastTool.name} 时` : ''}意外退出了
      </h3>
      {crash.lastTool && (
        <p>
          退出前正在调用 <strong>{crash.lastTool.name}</strong>，运行了 {crash.lastTool.seconds} 秒。
          <code>{crash.lastTool.target}</code>
        </p>
      )}
      {projectId && (
        <button className="inline-link" onClick={inspect}>
          {changes && !changes.error && changes.baselineAvailable
            ? `本轮已修改 ${changes.files.length} 个文件，查看变更`
            : '查看项目与本轮变更'}
        </button>
      )}
      <ErrorFeedback
        message={crash.repeated && 'Pi 在 10 秒内再次退出，可能是配置或扩展问题。请先打开诊断检查。'}
      />
      <ErrorFeedback
        message={
          crash.cleanup !== 'confirmed' &&
          (crash.cleanup === 'checking'
            ? '正在确认本轮命令是否结束，请稍候。'
            : '不确定上次的命令是否已结束，暂时不能重连和撤销。请在任务管理器或终端结束这些命令，然后重启 Pi Desktop。仅重启应用不会结束这些命令。')
        }
      />
      <details>
        <summary>退出前的诊断日志（最后 20 行）</summary>
        <p>
          退出码：{crash.code ?? '无'} · 信号：{crash.signal ?? '无'}
        </p>
        <p>没有自动重发上一条提问。</p>
        <pre>{crash.log.join('\n') || '没有诊断输出。'}</pre>
      </details>
      <label>
        继续任务的提问
        <textarea
          className="input"
          aria-label="继续任务的提问"
          value={prompt}
          disabled={pending || disabled}
          onChange={(event) => setPrompt(event.target.value)}
        />
      </label>
      <ErrorFeedback message={error} />
      <div className="button-row">
        <button
          className="primary"
          disabled={pending || disabled || !prompt.trim()}
          onClick={() => void run(() => recover(prompt))}
        >
          重新连接并继续
        </button>
        <details>
          <summary>更多</summary>
          <button disabled={pending || disabled} onClick={() => void run(() => recover())}>
            重新连接
          </button>
          {projectId && (
            <button
              disabled={
                pending || disabled || !changes?.baselineAvailable || !changes.files.length || !!changes.error
              }
              onClick={() =>
                void run(async () => {
                  await undo();
                  setRevision((value) => value + 1);
                })
              }
            >
              撤销本轮修改
            </button>
          )}
          <button onClick={diagnostic}>打开诊断</button>
        </details>
      </div>
    </section>
  );
}
