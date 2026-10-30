import { AlertCircle, RefreshCw, X, Link2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { IconButton } from '../IconButton';
import { Badge } from '../Badge';
import { ModelErrorCard } from '../ModelErrorCard';
import { ContextMeter } from './Usage';
import { modKey, shortcut } from '../../lib/platform';
import type { ComposerProps } from '../Composer';
import type { ModelErrorAction } from '../../../shared/errors';
const api = window.desktop;
// Only the visible status area ticks; task completion removes its timer entirely.
function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}
export function ComposerFeedback(
  props: ComposerProps & { handleModelError: (action: ModelErrorAction) => Promise<void> },
) {
  const {
    error,
    ownRuntime,
    runtime,
    setError,
    attempt,
    running,
    pending,
    storage,
    handleModelError,
    selected,
    setNotice,
  } = props;
  const now = useNow(ownRuntime && runtime.status === 'retrying' && Boolean(runtime.retry));
  return (
    <>
      {error && !(ownRuntime && runtime.errorKind && error === runtime.error) && (
        <div className="error-banner" role="alert">
          <AlertCircle size={16} />
          <span>{error}</span>
          <IconButton title="关闭错误提示" onClick={() => setError('')}>
            <X size={14} />
          </IconButton>
        </div>
      )}
      {ownRuntime && runtime.status === 'retrying' && runtime.retry && (
        <div className="retry-banner" role="status">
          <RefreshCw size={14} className="spin" />
          <span>
            第 {runtime.retry.attempt}/{runtime.retry.maxAttempts} 次重试
            {runtime.retry.phase === 'requesting'
              ? `，等待模型响应（${Math.max(0, Math.floor((now - (runtime.retry.requestedAt ?? runtime.retry.startedAt)) / 1000))} 秒）`
              : `，${Math.max(0, Math.ceil((runtime.retry.startedAt + runtime.retry.delayMs - now) / 1000))} 秒后开始`}
            {runtime.retry.error && <small>{runtime.retry.error}</small>}
          </span>
          <button onClick={() => selected && void attempt(() => api.invoke('abortRetry', selected.id))}>
            取消重试
          </button>
        </div>
      )}
      {ownRuntime && runtime.nextTask && (
        <div className="environment-note" role="status">
          本轮使用 {runtime.model?.provider} / {runtime.model?.name || runtime.model?.id} · {runtime.thinking}
          ； 下次新任务使用 {runtime.nextTask.model.provider} /{' '}
          {runtime.nextTask.model.name || runtime.nextTask.model.id} · {runtime.nextTask.thinking}。
          工具后的继续推理和运行中补充要求沿用本轮设置。
        </div>
      )}
      {ownRuntime && runtime.configurationPending && (
        <p className="environment-note" role="status">
          配置已保存，等待本会话空闲后加载。
        </p>
      )}
      {ownRuntime && runtime.status === 'compacting' && (
        <button onClick={() => selected && void attempt(() => api.invoke('stop', selected.id))}>
          停止当前压缩及任务
        </button>
      )}
      {ownRuntime && runtime.error && runtime.errorKind ? (
        <ModelErrorCard
          error={runtime.error}
          kind={runtime.errorKind}
          count={runtime.errorCount}
          disabled={running || pending || !storage.writable}
          autoCompaction={runtime.autoCompaction}
          act={(action) => attempt(() => handleModelError(action))}
          enableCompaction={() => attempt(() => api.invoke('piOption', selected!.id, 'autoCompaction', true))}
          copy={async (text) => {
            await api.invoke('copy', text);
            setNotice('错误详情已复制');
          }}
        />
      ) : (
        ownRuntime &&
        runtime.error &&
        runtime.error !== error && (
          <div className="error-banner">
            <AlertCircle size={16} />
            <span>{runtime.error}</span>
          </div>
        )
      )}
      {ownRuntime && (runtime.steering.length > 0 || runtime.followUp.length > 0) && (
        <div className="queue">
          <div>
            <span>待处理</span>
            <button onClick={() => selected && void attempt(() => api.invoke('clearQueue', selected.id))}>
              清空并恢复草稿
            </button>
          </div>
          {runtime.steering.map((q, i) => (
            <p key={'s' + i}>
              <span>补充</span>
              {q.slice(0, 180)}
            </p>
          ))}
          {runtime.followUp.map((q, i) => (
            <p key={'f' + i}>
              <span>接下来</span>
              {q.slice(0, 180)}
            </p>
          ))}
        </div>
      )}
      {ownRuntime &&
        Object.entries(runtime.widgets)
          .filter(([key]) => runtime.widgetPlacements?.[key] !== 'belowEditor')
          .map(([key, lines]) => (
            <div className="extension-widget" key={key}>
              {lines.join('\n')}
            </div>
          ))}
      {ownRuntime && Object.keys(runtime.statuses).length > 0 && (
        <div className="extension-status">{Object.values(runtime.statuses).join(' · ')}</div>
      )}
    </>
  );
}
export function ComposerFooter(props: ComposerProps) {
  const {
    ownRuntime,
    runtime,
    ownRunning,
    connect,
    pending,
    sessionEnabled,
    running,
    attempt,
    stopArmed,
    project,
    setFeatureTab,
    selected,
    setShortcutsOpen,
  } = props;
  const connecting = ownRunning && !runtime.connected;
  const now = useNow(ownRunning);
  const elapsed = runtime.startedAt ? Math.max(0, Math.floor((now - runtime.startedAt) / 1000)) : 0;
  return (
    <>
      {ownRuntime &&
        Object.entries(runtime.widgets)
          .filter(([key]) => runtime.widgetPlacements?.[key] === 'belowEditor')
          .map(([key, lines]) => (
            <div className="extension-widget" key={key}>
              {lines.join('\n')}
            </div>
          ))}
      <div className="composer-bottom">
        <div className="run-meta" role="status" aria-live="polite">
          {ownRuntime ? (
            <>
              <Badge
                status={runtime.status}
                label={connecting && runtime.status === 'starting' ? '正在连接 Pi' : undefined}
              />
              {ownRunning && !connecting && Boolean(runtime.startedAt) && (
                <span className="elapsed" aria-hidden="true">
                  {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}
                </span>
              )}
              {!runtime.connected && !ownRunning && (
                <button onClick={connect} disabled={pending || !sessionEnabled || running}>
                  <Link2 size={12} />
                  重新连接
                </button>
              )}
            </>
          ) : (
            <button onClick={connect} disabled={!sessionEnabled || pending || running}>
              <Link2 size={12} />
              连接 Pi
            </button>
          )}
        </div>
        {runtime.status === 'stopping' && runtime.stopStartedAt && now - runtime.stopStartedAt > 15000 ? (
          <button
            className="danger-link"
            onClick={() => selected && void attempt(() => api.invoke('forceStop', selected.id))}
          >
            强制结束
          </button>
        ) : stopArmed ? (
          <span className="composer-footnote stop-armed" role="status">
            再按一次 <kbd>Esc</kbd> 停止当前会话
          </span>
        ) : (
          <span
            className="composer-footnote"
            title={
              project
                ? `Enter 发送 · Shift+Enter 换行 · ↑ 上一条提问 · ${shortcut('/')} 快捷键。Pi 会直接修改项目文件。`
                : `Enter 发送 · Shift+Enter 换行 · ↑ 上一条提问 · ${shortcut('/')} 快捷键。独立对话支持 Pi 工具，工作目录可在 Pi 功能中打开。`
            }
          >
            {ownRuntime && (runtime.stats || runtime.liveUsage) ? (
              <ContextMeter
                stats={runtime.stats ?? {}}
                liveUsage={runtime.liveUsage}
                open={() => setFeatureTab('session')}
                disabled={running || pending || !sessionEnabled}
                branchDisabled={!sessionEnabled || (pending && !running)}
                compact={() => selected && void attempt(() => api.invoke('compact', selected.id, ''))}
                branch={() =>
                  selected && void attempt(() => api.invoke('branchSession', selected.id, 'clone'))
                }
              />
            ) : (
              <button className="shortcut-link" onClick={() => setShortcutsOpen(true)}>
                Shift + Enter 换行 · <kbd>{modKey}</kbd>
                <kbd>/</kbd> 快捷键
              </button>
            )}
          </span>
        )}
      </div>
    </>
  );
}
