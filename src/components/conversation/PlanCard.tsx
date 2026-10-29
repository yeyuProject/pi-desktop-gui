import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, LoaderCircle, X } from 'lucide-react';
import type { PlanSnapshot } from '../../../shared/plan';
import { planProgress } from '../../lib/plan-progress';
import { topLayer } from '../../hooks/useLayer';
import '../../styles/goal.css';

export function PlanCard({
  plan,
  running,
  updateRequest = 0,
  expanded,
  toggle,
  composing,
}: {
  plan: PlanSnapshot;
  running: boolean;
  updateRequest?: number;
  expanded: string[];
  toggle: (id: string, open: boolean) => void;
  composing: boolean;
}) {
  const key = `${plan.turnId}:${updateRequest}`;
  const expansion = `plan:${plan.turnId}`;
  const open = expanded.includes(expansion);
  const [dismissed, setDismissed] = useState<string>();
  const [minimized, setMinimized] = useState<string>();
  const [hovered, setHovered] = useState(false);
  const progress = planProgress(plan.steps);
  const visible = progress.total > 0 && dismissed !== key;
  const dot = minimized === key && !open && progress.done && !running;
  useEffect(() => {
    if (!visible || !progress.done || running || open || hovered || dot) return;
    const timer = setTimeout(() => setMinimized(key), 8000);
    return () => clearTimeout(timer);
  }, [visible, progress.done, running, open, hovered, dot, key]);
  useEffect(() => {
    if (!visible || !open || composing) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented || topLayer()) return;
      event.preventDefault();
      event.stopPropagation();
      toggle(expansion, false);
    };
    document.addEventListener('keydown', escape, true);
    return () => document.removeEventListener('keydown', escape, true);
  }, [visible, open, composing, expansion, toggle]);
  if (!visible) return null;
  if (dot)
    return (
      <button
        className="plan-completed"
        title="查看已完成的任务计划"
        aria-label="查看已完成的任务计划"
        onClick={() => {
          setMinimized(undefined);
          toggle(expansion, true);
        }}
      >
        <span className="goal-completed-dot" aria-hidden="true" />
      </button>
    );
  const remaining = plan.steps.filter((step) => step.status !== 'completed').length;
  const text = `步骤 ${progress.index} / ${progress.total} · ${progress.text}`;
  return (
    <section
      className="goal-card plan-card"
      aria-label="任务计划"
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
    >
      <div className="goal-bar">
        {running ? (
          <LoaderCircle className="plan-icon spin" size={14} aria-hidden="true" />
        ) : (
          <span className="plan-icon" aria-hidden="true">
            ●
          </span>
        )}
        <span className="plan-summary" title={text} aria-live="polite">
          {text}
        </span>
        {!running && !progress.done && (
          <span className="plan-remaining">本轮已结束 · 剩余 {remaining} 步</span>
        )}
        <button
          title={open ? '收起任务计划' : '展开任务计划'}
          aria-label={open ? '收起任务计划' : '展开任务计划'}
          aria-expanded={open}
          onClick={() => toggle(expansion, !open)}
        >
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        <button title="关闭任务计划" aria-label="关闭任务计划" onClick={() => setDismissed(key)}>
          <X size={14} />
        </button>
      </div>
      {open && (
        <div className="goal-details">
          <ol className="goal-plan" aria-label="计划步骤">
            {plan.steps.map((step, index) => {
              const label =
                step.status === 'completed'
                  ? '已完成'
                  : step.status === 'in_progress'
                    ? running
                      ? '进行中'
                      : '未完成'
                    : '待开始';
              const symbol = step.status === 'completed' ? '✓' : step.status === 'in_progress' ? '●' : '○';
              return (
                <li key={index} data-status={step.status}>
                  <span className="plan-step-status">
                    <span aria-hidden="true">{symbol} </span>
                    {label}
                  </span>{' '}
                  {step.text}
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </section>
  );
}
