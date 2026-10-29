import type { PlanStep } from '../../shared/plan';

/** index is one-based for display; an empty plan has index/total 0 and is not done. */
export function planProgress(steps: readonly PlanStep[] = []) {
  const active = steps.findIndex((step) => step.status === 'in_progress');
  const current = active < 0 ? steps.findIndex((step) => step.status === 'pending') : active;
  const done = steps.length > 0 && current < 0;
  return {
    index: current < 0 ? steps.length : current + 1,
    total: steps.length,
    text: done ? '全部完成' : (steps[current]?.text ?? ''),
    done,
  };
}
