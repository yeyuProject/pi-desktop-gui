export const MAX_GOAL_OBJECTIVE_LENGTH = 4000;
export const GOAL_BUDGET_PRESETS = ['', '500k', '2m', '5m'] as const;
export type GoalStatus = 'active' | 'paused' | 'blocked' | 'budget_limited' | 'usage_limited' | 'completed';
export interface GoalStep {
  text: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface GoalSnapshot {
  id: string;
  revision: number;
  status: GoalStatus;
  objective: string;
  references?: string[];
  tokensUsed: number;
  tokenBudget?: number;
  continuations: number;
  timeUsedMs: number | null;
  billedTokensUsed: number;
  costUsed: number;
  legacyUsage?: boolean;
  plan?: GoalStep[];
  createdAt: number;
  updatedAt: number;
  reason?: string;
  summary?: string;
}

export type GoalAction =
  | { action: 'start'; objective: string; tokenBudget?: number }
  | { action: 'edit'; goalId: string; revision: number; objective: string }
  | { action: 'pause' | 'resume' | 'clear'; goalId: string }
  | { action: 'budget'; goalId: string; tokenBudget?: number };

export function parseGoalBudget(value: string): number | undefined {
  if (!value.trim()) return undefined;
  const match = /^(\d+)([km]?)$/i.exec(value.trim());
  const amount = match && Number(match[1]) * (match[2].toLowerCase() === 'k' ? 1000 : match[2] ? 1000000 : 1);
  if (!amount || !Number.isSafeInteger(amount))
    throw new Error('用量上限请输入正整数，可加 k 或 m，例如 500k；选择“不限”则不设上限。');
  return amount;
}

export function validateGoalAction(value: unknown): asserts value is GoalAction {
  const action = value as GoalAction;
  if (!action || !['start', 'edit', 'pause', 'resume', 'clear', 'budget'].includes(action.action))
    throw new Error('Goal 操作无效，请重新打开 Goal。');
  if (action.action === 'start' || action.action === 'edit') validateGoalObjective(action.objective);
  if (action.action !== 'start' && (typeof action.goalId !== 'string' || !action.goalId))
    throw new Error('Goal 已变化，请重新打开 Goal。');
  if (action.action === 'edit' && (!Number.isSafeInteger(action.revision) || action.revision < 1))
    throw new Error('Goal 版本无效，请重新打开编辑目标。');
  if (
    'tokenBudget' in action &&
    action.tokenBudget !== undefined &&
    (!Number.isSafeInteger(action.tokenBudget) || action.tokenBudget <= 0)
  )
    throw new Error('用量上限必须是有效的正整数。');
}

export function compactGoalTokens(value: number) {
  if (value >= 1000000) return `${Number((value / 1000000).toFixed(1))}m`;
  if (value >= 1000) return `${Number((value / 1000).toFixed(1))}k`;
  return String(value);
}

export function validateGoalObjective(objective: unknown): asserts objective is string {
  if (typeof objective !== 'string' || !objective.trim()) throw new Error('请输入需要完成的目标。');
  if (objective.length > MAX_GOAL_OBJECTIVE_LENGTH)
    throw new Error('目标不能超过 4000 字；请把详细要求写进项目文件，并在目标里引用文件路径。');
}

export function validateGoalPlan(steps: unknown): asserts steps is GoalStep[] {
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

/** Pi input already excludes cache reads. Use this basis for Goal and its request estimate. */
export function goalRequestTokens(usage: unknown): number | undefined {
  if (!usage || typeof usage !== 'object') return undefined;
  const values = usage as Record<string, unknown>;
  const tokens = ['input', 'output', 'cacheWrite'].map((key) => values[key]);
  if (!tokens.every((value) => Number.isSafeInteger(value) && Number(value) >= 0)) return undefined;
  const total = tokens.reduce<number>((sum, value) => sum + Number(value), 0);
  return Number.isSafeInteger(total) ? total : undefined;
}

export function goalNotificationTitle(status: GoalStatus) {
  return (
    {
      completed: 'Goal 已完成',
      blocked: 'Goal 遇到阻碍',
      budget_limited: 'Goal 达到用量上限',
      usage_limited: 'Goal 服务商额度不足',
    } as Partial<Record<GoalStatus, string>>
  )[status];
}
