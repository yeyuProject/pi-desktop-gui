import type { SessionEntry } from '@earendil-works/pi-coding-agent';

export const DESKTOP_GOAL_ENTRY_TYPE = 'desktop-goal';
export const MAX_GOAL_CONTINUATIONS = 25;
export const MAX_GOAL_NO_TOOL_RUNS = 3;

export interface DesktopGoalState {
  version: 1;
  id: string;
  objective: string;
  status: 'active' | 'paused' | 'blocked' | 'completed';
  tokenBudget?: number;
  tokensUsed: number;
  continuations: number;
  noToolRuns: number;
  createdAt: number;
  updatedAt: number;
  reason?: string;
  summary?: string;
  evidence?: string;
}

export type GoalCommand =
  | { action: 'menu' | 'status' | 'pause' | 'resume' | 'clear' }
  | { action: 'start'; objective: string; tokenBudget?: number };

export function parseGoalCommand(input: string): GoalCommand {
  const text = input.trim();
  if (!text) return { action: 'menu' };
  if (text === 'status' || text === 'pause' || text === 'resume' || text === 'clear') return { action: text };
  let objective = text;
  let tokenBudget: number | undefined;
  if (/^--tokens(?:\s|$)/.test(text)) {
    const match = /^--tokens\s+(\d+)([km]?)\s+([\s\S]+)$/i.exec(text);
    if (!match) throw new Error('用法：/goal --tokens 正整数 目标。预算可使用 k 或 m，例如 20k。');
    tokenBudget = Number(match[1]) * (match[2].toLowerCase() === 'k' ? 1000 : match[2] ? 1000000 : 1);
    if (!Number.isSafeInteger(tokenBudget) || tokenBudget <= 0)
      throw new Error('Goal 的 token 预算必须是有效的正整数。');
    objective = match[3].trim();
  } else if (text.startsWith('--')) {
    throw new Error('Goal 只支持前置预算参数：/goal [--tokens N] <目标>。');
  }
  return { action: 'start', objective, ...(tokenBudget === undefined ? {} : { tokenBudget }) };
}

export function readGoalState(entries: readonly SessionEntry[]): DesktopGoalState | undefined {
  const entry = entries.findLast(
    (candidate) => candidate.type === 'custom' && candidate.customType === DESKTOP_GOAL_ENTRY_TYPE,
  );
  if (!entry || entry.type !== 'custom' || entry.data === null) return undefined;
  const value = entry.data;
  if (!value || typeof value !== 'object') throw new Error('Goal 状态损坏，请先使用 /goal clear 清除。');
  const goal = value as Record<string, unknown>;
  const integer = (key: string) => Number.isSafeInteger(goal[key]) && Number(goal[key]) >= 0;
  if (
    goal.version !== 1 ||
    typeof goal.id !== 'string' ||
    !goal.id.trim() ||
    typeof goal.objective !== 'string' ||
    !goal.objective.trim() ||
    !['active', 'paused', 'blocked', 'completed'].includes(String(goal.status)) ||
    !['tokensUsed', 'continuations', 'noToolRuns', 'createdAt', 'updatedAt'].every(integer) ||
    (goal.tokenBudget !== undefined && (!integer('tokenBudget') || Number(goal.tokenBudget) <= 0)) ||
    ['reason', 'summary', 'evidence'].some((key) => goal[key] !== undefined && typeof goal[key] !== 'string')
  )
    throw new Error('Goal 状态格式无效，请先使用 /goal clear 清除。');
  return { ...(value as DesktopGoalState) };
}

export function nextGoalBoundary(goal: DesktopGoalState, usedTools: boolean, now: number) {
  const next = { ...goal, noToolRuns: usedTools ? 0 : goal.noToolRuns + 1, updatedAt: now };
  let reason: string | undefined;
  if (next.tokenBudget !== undefined && next.tokensUsed >= next.tokenBudget)
    reason = `已达到 token 预算 ${next.tokenBudget}，Goal 已暂停。`;
  else if (next.noToolRuns >= MAX_GOAL_NO_TOOL_RUNS)
    reason = `连续 ${MAX_GOAL_NO_TOOL_RUNS} 次结束未调用工具，Goal 已暂停，请检查结果后决定是否继续。`;
  else if (next.continuations >= MAX_GOAL_CONTINUATIONS)
    reason = `已自动续跑 ${MAX_GOAL_CONTINUATIONS} 次，Goal 已暂停，请检查结果后决定是否继续。`;
  if (reason) return { state: { ...next, status: 'paused' as const, reason }, continue: false };
  return { state: { ...next, continuations: next.continuations + 1 }, continue: true };
}
