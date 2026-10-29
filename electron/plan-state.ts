import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { validatePlanSteps, type PlanSnapshot } from '../shared/plan';

export const DESKTOP_PLAN_ENTRY_TYPE = 'desktop-plan';

export function readPlanState(entries: readonly SessionEntry[]): PlanSnapshot | null {
  const entry = entries.findLast(
    (item) => item.type === 'custom' && item.customType === DESKTOP_PLAN_ENTRY_TYPE,
  );
  if (!entry || entry.type !== 'custom' || entry.data === null) return null;
  const plan = entry.data as PlanSnapshot;
  if (!plan || !Number.isSafeInteger(plan.turnId) || plan.turnId < 0)
    throw new Error('任务计划状态格式无效，发送新任务后可重新创建。');
  validatePlanSteps(plan.steps);
  return structuredClone({ turnId: plan.turnId, steps: plan.steps });
}

/** Corrupt plan metadata must not prevent offline browsing of the conversation. */
export function readPlanView(entries: readonly SessionEntry[]): {
  plan: PlanSnapshot | null;
  warning?: string;
} {
  try {
    return { plan: readPlanState(entries) };
  } catch (error) {
    return { plan: null, warning: error instanceof Error ? error.message : String(error) };
  }
}
