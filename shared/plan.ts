export interface PlanStep {
  text: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface PlanSnapshot {
  turnId: number;
  steps: PlanStep[];
}

export function validatePlanSteps(steps: unknown): asserts steps is PlanStep[] {
  if (
    !Array.isArray(steps) ||
    steps.length > 12 ||
    steps.some(
      (step) =>
        !step ||
        typeof step.text !== 'string' ||
        !step.text.trim() ||
        step.text.length > 4000 ||
        !['pending', 'in_progress', 'completed'].includes(step.status),
    ) ||
    steps.filter((step) => step.status === 'in_progress').length > 1
  )
    throw new Error('计划最多 12 项，每项需要文字和有效状态，同时只能有一项正在执行。');
}
