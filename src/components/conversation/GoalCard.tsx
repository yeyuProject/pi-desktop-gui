import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronRight, LoaderCircle, Pause, X, CircleAlert } from 'lucide-react';
import type { GoalAction, GoalSnapshot } from '../../../shared/goal';
import { compactGoalTokens } from '../../../shared/goal';
import type { Runtime, Message } from '../../../shared/types';
import { RichText } from './Markdown';
import { GoalDialog } from '../GoalDialog';
import { topLayer } from '../../hooks/useLayer';
import '../../styles/goal.css';

export function useGoalCard(
  goal: GoalSnapshot | null | undefined,
  sessionId: string | undefined,
  expanded: string[],
  toggle: (id: string, open: boolean) => void,
) {
  const [revealed, setRevealed] = useState<string>(),
    [hovered, setHovered] = useState(false);
  const key = `${sessionId}:${goal?.id}`;
  const previous = useRef({ key, status: goal?.status });
  useLayoutEffect(() => {
    if (previous.current.key !== key) {
      setRevealed(undefined);
      setHovered(false);
    }
    if (
      previous.current.key === key &&
      previous.current.status &&
      previous.current.status !== 'completed' &&
      goal?.status === 'completed'
    )
      setRevealed(key);
    previous.current = { key, status: goal?.status };
  }, [key, goal?.status]);
  const open = Boolean(goal && expanded.includes(`goal:${goal.id}`));
  const visible = Boolean(goal && (goal.status !== 'completed' || revealed === key));
  const setOpen = (value: boolean) => goal && toggle(`goal:${goal.id}`, value);
  useEffect(() => {
    if (!visible || goal?.status !== 'completed' || open || hovered) return;
    const timer = setTimeout(() => setRevealed(undefined), 8000);
    return () => clearTimeout(timer);
  }, [visible, goal?.status, open, hovered]);
  useEffect(() => {
    if (!open || !visible) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented || topLayer()) return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    };
    document.addEventListener('keydown', escape, true);
    return () => document.removeEventListener('keydown', escape, true);
  }, [open, visible, goal?.id, toggle]);
  return {
    open,
    visible,
    setOpen,
    setHovered,
    reveal: () => {
      setRevealed(key);
      setOpen(true);
    },
  };
}

export function GoalCard({
  goal,
  runtime,
  messages,
  view,
  disabled,
  action,
}: {
  goal: GoalSnapshot;
  runtime: Runtime;
  messages: Message[];
  view: ReturnType<typeof useGoalCard>;
  disabled: boolean;
  action: (action: GoalAction) => Promise<void>;
}) {
  const [allEvidence, setAllEvidence] = useState(false),
    [budgetDialog, setBudgetDialog] = useState(false);
  const [pending, setPending] = useState(false),
    [error, setError] = useState('');
  const run = async (operation: GoalAction) => {
    setPending(true);
    setError('');
    try {
      await action(operation);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setPending(false);
    }
  };
  const exhausted = goal.tokenBudget !== undefined && goal.tokensUsed >= goal.tokenBudget;
  const seconds = Math.max(0, Math.round((goal.updatedAt - goal.createdAt) / 1000));
  const cost =
    runtime.stats?.tokens && runtime.stats.cost !== undefined
      ? (goal.tokensUsed * runtime.stats.cost) / runtime.stats.tokens
      : undefined;
  const locked = disabled || pending;
  return (
    <section
      className={`goal-card ${goal.status}`}
      aria-label="Goal 状态"
      onPointerEnter={() => view.setHovered(true)}
      onPointerLeave={() => view.setHovered(false)}
    >
      <div className="goal-bar">
        {goal.status === 'active' ? (
          <LoaderCircle className="goal-icon spin" size={14} />
        ) : goal.status === 'completed' ? (
          <Check className="goal-icon" size={14} />
        ) : goal.status === 'blocked' ? (
          <CircleAlert className="goal-icon" size={14} />
        ) : (
          <Pause className="goal-icon" size={14} />
        )}
        <strong>Goal{goal.status === 'completed' ? ' 已完成' : ''}</strong>
        <span className="goal-objective" title={goal.objective}>
          {goal.objective.split(/\r?\n/)[0]}
        </span>
        {goal.status === 'active' ? (
          <>
            <span className="goal-progress">
              第 {goal.continuations} / {goal.maxContinuations} 次续跑
            </span>
            {goal.tokenBudget !== undefined && (
              <span className="goal-budget">
                <progress max={goal.tokenBudget} value={goal.tokensUsed} />
                {compactGoalTokens(goal.tokensUsed)} / {compactGoalTokens(goal.tokenBudget)}
              </span>
            )}
            <button disabled={locked} onClick={() => void run({ action: 'pause', goalId: goal.id })}>
              暂停
            </button>
          </>
        ) : goal.status === 'completed' ? (
          <>
            <span className="goal-progress">
              用时 {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
            </span>
            <button onClick={() => view.setOpen(!view.open)}>查看结果</button>
          </>
        ) : (
          <>
            <span className="goal-reason" title={goal.reason}>
              {exhausted ? '已达到预算' : goal.reason || (goal.status === 'blocked' ? '遇到阻碍' : '已暂停')}
            </span>
            <button
              disabled={locked}
              onClick={() =>
                exhausted ? setBudgetDialog(true) : void run({ action: 'resume', goalId: goal.id })
              }
            >
              {exhausted ? '调整上限并继续' : '继续'}
            </button>
          </>
        )}
        <button
          aria-label={view.open ? '收起 Goal 详情' : '展开 Goal 详情'}
          aria-expanded={view.open}
          onClick={() => view.setOpen(!view.open)}
        >
          {view.open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        <button
          aria-label="清除 Goal"
          disabled={locked}
          onClick={() => void run({ action: 'clear', goalId: goal.id })}
        >
          <X size={14} />
        </button>
      </div>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      {view.open && (
        <div className="goal-details">
          <p className="goal-full-objective">{goal.objective}</p>
          {goal.summary && <RichText text={goal.summary} />}
          {goal.evidence && (
            <>
              <div className={`goal-evidence${allEvidence ? '' : ' clipped'}`}>
                <RichText text={goal.evidence} />
              </div>
              <button onClick={() => setAllEvidence(!allEvidence)}>
                {allEvidence ? '收起证据' : '展开全部证据'}
              </button>
            </>
          )}
          <p
            className="goal-usage"
            title={`${goal.tokensUsed.toLocaleString()} tokens · ${cost === undefined ? '估算费用未知' : `按会话平均单价估算 $${cost.toFixed(4)}`}`}
          >
            已用 {compactGoalTokens(goal.tokensUsed)}{' '}
            tokens（含每次请求重复发送的上下文与缓存，与底部累计口径一致）
          </p>
          {goal.status === 'completed' && (
            <button
              onClick={() => window.dispatchEvent(new CustomEvent('pi:goal-result', { detail: goal.id }))}
            >
              跳到结果
            </button>
          )}
        </div>
      )}
      {budgetDialog && (
        <GoalDialog
          runtime={{ ...runtime, messages }}
          budgetOnly
          initialBudget={goal.tokenBudget}
          used={goal.tokensUsed}
          close={() => setBudgetDialog(false)}
          submit={async (_objective, tokenBudget) => {
            await action({ action: 'budget', goalId: goal.id, tokenBudget });
            setBudgetDialog(false);
          }}
        />
      )}
    </section>
  );
}
