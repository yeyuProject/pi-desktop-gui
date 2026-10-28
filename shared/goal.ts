export const GOAL_DIALOG_TITLE = '[Pi Desktop] 新建 Goal';
export const GOAL_BUDGET_PRESETS = ['', '500k', '2m', '5m'] as const;

export interface GoalSnapshot {
  id: string;
  status: 'active' | 'paused' | 'blocked' | 'completed';
  objective: string;
  tokensUsed: number;
  tokenBudget?: number;
  continuations: number;
  maxContinuations: number;
  createdAt: number;
  updatedAt: number;
  reason?: string;
  summary?: string;
  evidence?: string;
}

export type GoalAction =
  | { action: 'start'; objective: string; tokenBudget?: number }
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
  if (!action || !['start', 'pause', 'resume', 'clear', 'budget'].includes(action.action))
    throw new Error('Goal 操作无效，请重新打开 Goal。');
  if (action.action === 'start') {
    if (typeof action.objective !== 'string' || !action.objective.trim() || action.objective.length > 100000)
      throw new Error('请输入目标，目标长度不能超过 100000 字。');
  } else if (typeof action.goalId !== 'string' || !action.goalId)
    throw new Error('Goal 已变化，请重新打开 Goal。');
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
