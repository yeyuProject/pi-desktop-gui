import { planProgress } from '../../lib/plan-progress';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronRight, LoaderCircle, Pause, X, CircleAlert } from 'lucide-react';
import type { GoalAction, GoalSnapshot } from '../../../shared/goal';
import { compactGoalTokens } from '../../../shared/goal';
import type { Message } from '../../../shared/types';
import { RichText } from './Markdown';
import { GoalBudgetPicker } from '../GoalBudgetPicker';
import { topLayer } from '../../hooks/useLayer';
import '../../styles/goal.css';

export function useGoalCard(
  goal: GoalSnapshot | null | undefined,
  sessionId: string | undefined,
  expanded: string[],
  toggle: (id: string, open: boolean) => void,
  openRequest?: number,
  composing = false,
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
    if (!open || !visible || composing) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented || topLayer()) return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    };
    document.addEventListener('keydown', escape, true);
    return () => document.removeEventListener('keydown', escape, true);
  }, [open, visible, goal?.id, toggle, composing]);
  const lastRequest = useRef({ key, openRequest });
  useLayoutEffect(() => {
    if (lastRequest.current.key === key && lastRequest.current.openRequest !== openRequest && openRequest) {
      setRevealed(key);
      setOpen(true);
    }
    lastRequest.current = { key, openRequest };
  }, [key, openRequest]);
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
  messages,
  view,
  disabled,
  action,
  openProviders,
  edit,
  replace,
}: {
  goal: GoalSnapshot;
  messages: Message[];
  view: ReturnType<typeof useGoalCard>;
  disabled: boolean;
  action: (action: GoalAction) => Promise<void>;
  openProviders: () => void;
  edit: () => void;
  replace: () => void;
}) {
  const [pending, setPending] = useState(false),
    [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (goal.status !== 'active') return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [goal.status]);
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
  const seconds =
    goal.timeUsedMs === null
      ? null
      : Math.floor(
          (goal.timeUsedMs + (goal.status === 'active' ? Math.max(0, now - goal.updatedAt) : 0)) / 1000,
        );
  const elapsed =
    seconds === null ? '—' : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  const steps = planProgress(goal.plan);
  const progress = steps.total
    ? `步骤 ${steps.index} / ${steps.total} · ${steps.done ? '步骤已完成，等待核验' : steps.text}`
    : `用时 ${elapsed}`;
  const locked = disabled || pending;
  const reason =
    goal.status === 'budget_limited'
      ? `未完成 · 已达到用量上限 ${compactGoalTokens(goal.tokenBudget ?? goal.tokensUsed)}`
      : goal.status === 'usage_limited'
        ? '服务商额度不足'
        : goal.reason || (goal.status === 'blocked' ? '遇到阻碍' : '已暂停');
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
        ) : goal.status === 'paused' ? (
          <Pause className="goal-icon" size={14} />
        ) : (
          <CircleAlert className="goal-icon" size={14} />
        )}
        <strong>Goal{goal.status === 'completed' ? ' 已完成' : ''}</strong>
        <span className="goal-objective" title={goal.objective}>
          {goal.objective.split(/\r?\n/)[0]}
        </span>
        {goal.status === 'active' ? (
          <>
            <span className="goal-progress" title={progress}>
              {progress}
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
            <span className="goal-progress">用时 {elapsed}</span>
            <button onClick={() => view.setOpen(!view.open)}>查看结果</button>
          </>
        ) : (
          <>
            <span className="goal-reason" title={goal.reason || reason}>
              {reason}
            </span>
            {goal.status === 'usage_limited' && <button onClick={openProviders}>打开服务商设置</button>}
            {goal.status === 'budget_limited' ? (
              <GoalBudgetPicker
                messages={messages}
                initialBudget={goal.tokenBudget}
                used={goal.tokensUsed}
                resume
                disabled={locked}
                submit={(tokenBudget) => action({ action: 'budget', goalId: goal.id, tokenBudget })}
              />
            ) : (
              <button disabled={locked} onClick={() => void run({ action: 'resume', goalId: goal.id })}>
                继续
              </button>
            )}
          </>
        )}
        {goal.status !== 'completed' && (
          <button disabled={locked} onClick={edit}>
            编辑目标
          </button>
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
          {!!goal.references?.length && <p className="muted">引用文件：{goal.references.join('、')}</p>}
          {!!goal.plan?.length && (
            <ol className="goal-plan" aria-label="Goal 计划">
              {goal.plan.map((step, index) => (
                <li key={index} data-status={step.status}>
                  <span>
                    {step.status === 'completed'
                      ? '已完成'
                      : step.status === 'in_progress'
                        ? '进行中'
                        : '待开始'}
                  </span>{' '}
                  {step.text}
                </li>
              ))}
            </ol>
          )}
          {goal.summary && (
            <div className="goal-summary">
              <RichText text={goal.summary} />
            </div>
          )}
          <p
            className="goal-usage"
            title={`计费用量（含缓存）${goal.billedTokensUsed.toLocaleString()} tokens（${compactGoalTokens(goal.billedTokensUsed)}） · ${goal.legacyUsage ? '旧记录费用不完整' : `估算费用 $${goal.costUsed.toFixed(4)}`}`}
          >
            Goal 用量 {compactGoalTokens(goal.tokensUsed)} tokens（不含缓存命中） · 用时 {elapsed}
          </p>
          {goal.legacyUsage && <p className="muted">含旧版统计口径，用量可能偏大；旧版执行用时不可用。</p>}
          <button disabled={locked} onClick={edit}>
            编辑目标
          </button>
          <button disabled={locked} onClick={replace}>
            替换目标
          </button>
          {goal.summary && (
            <button
              onClick={() => window.dispatchEvent(new CustomEvent('pi:goal-result', { detail: goal.id }))}
            >
              跳到结果
            </button>
          )}
        </div>
      )}
    </section>
  );
}
