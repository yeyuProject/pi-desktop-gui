import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { validateGoalObjective, validateGoalPlan, type GoalSnapshot } from '../shared/goal';

export const DESKTOP_GOAL_ENTRY_TYPE = 'desktop-goal';
export const MAX_GOAL_NO_PROGRESS_RUNS = 3;
export interface DesktopGoalState extends GoalSnapshot {
  version: 2;
  noProgressRuns: number;
  failedRuns: number;
}
export function goalSnapshot(goal: DesktopGoalState | undefined): GoalSnapshot | null {
  if (!goal) return null;
  const { version: _version, noProgressRuns: _noProgressRuns, failedRuns: _failedRuns, ...view } = goal;
  return view;
}
/** A damaged Goal must not hide the conversation history. */
export function readGoalView(entries: readonly SessionEntry[]): { goal?: GoalSnapshot; warning?: string } {
  try {
    const goal = goalSnapshot(readGoalState(entries));
    return goal ? { goal } : {};
  } catch (error) {
    return { warning: error instanceof Error ? error.message : String(error) };
  }
}
export type GoalCommand =
  | { action: 'menu' | 'status' | 'pause' | 'resume' | 'clear' }
  | { action: 'edit'; objective?: string }
  | { action: 'start'; objective: string; tokenBudget?: number };
export function parseGoalCommand(input: string): GoalCommand {
  const text = input.trim();
  if (!text) return { action: 'menu' };
  if (text === 'status' || text === 'pause' || text === 'resume' || text === 'clear') return { action: text };
  if (/^edit(?:\s|$)/.test(text)) {
    const objective = text.slice(4).trim();
    if (objective) validateGoalObjective(objective);
    return { action: 'edit', ...(objective ? { objective } : {}) };
  }
  let objective = text;
  let tokenBudget: number | undefined;
  if (/^--tokens(?:\s|$)/.test(text)) {
    const match = /^--tokens\s+(\d+)([km]?)\s+([\s\S]+)$/i.exec(text);
    if (!match) throw new Error('用法：/goal --tokens 正整数 目标。预算可使用 k 或 m，例如 20k。');
    tokenBudget = Number(match[1]) * (match[2].toLowerCase() === 'k' ? 1000 : match[2] ? 1000000 : 1);
    if (!Number.isSafeInteger(tokenBudget) || tokenBudget <= 0)
      throw new Error('Goal 的 token 预算必须是有效的正整数。');
    objective = match[3].trim();
  } else if (text.startsWith('--')) throw new Error('Goal 只支持前置预算参数：/goal [--tokens N] <目标>。');
  validateGoalObjective(objective);
  return { action: 'start', objective, ...(tokenBudget === undefined ? {} : { tokenBudget }) };
}
export function readGoalState(entries: readonly SessionEntry[]): DesktopGoalState | undefined {
  const entry = entries.findLast(
    (item) => item.type === 'custom' && item.customType === DESKTOP_GOAL_ENTRY_TYPE,
  );
  if (!entry || entry.type !== 'custom' || entry.data === null) return undefined;
  const goal = entry.data as Record<string, unknown>;
  const invalid = () => new Error('Goal 状态格式无效，请先使用 /goal clear 清除。');
  if (!goal || typeof goal !== 'object') throw invalid();
  const integer = (key: string) => Number.isSafeInteger(goal[key]) && Number(goal[key]) >= 0;
  if (
    ![1, 2].includes(Number(goal.version)) ||
    typeof goal.id !== 'string' ||
    !goal.id.trim() ||
    typeof goal.objective !== 'string' ||
    !goal.objective.trim() ||
    !['active', 'paused', 'blocked', 'budget_limited', 'usage_limited', 'completed'].includes(
      String(goal.status),
    ) ||
    !['tokensUsed', 'continuations', 'createdAt', 'updatedAt'].every(integer) ||
    (goal.tokenBudget !== undefined && (!integer('tokenBudget') || Number(goal.tokenBudget) <= 0)) ||
    ['reason', 'summary', 'evidence'].some((key) => goal[key] !== undefined && typeof goal[key] !== 'string')
  )
    throw invalid();
  if (goal.version === 1) {
    if (!integer('noToolRuns') || !['active', 'paused', 'blocked', 'completed'].includes(String(goal.status)))
      throw invalid();
    const { evidence, noToolRuns, plan: _oldPlan, ...previous } = goal;
    return {
      ...previous,
      version: 2,
      revision: 1,
      timeUsedMs: null,
      legacyUsage: true,
      billedTokensUsed: goal.tokensUsed,
      costUsed: 0,
      noProgressRuns: noToolRuns,
      failedRuns: 0,
      ...(goal.status === 'active' ? { status: 'paused', reason: '旧版 Goal 已暂停，点击继续后恢复。' } : {}),
      summary: [goal.summary, evidence].filter(Boolean).join('\n\n') || undefined,
    } as DesktopGoalState;
  }
  if (
    goal.version !== 2 ||
    !['revision', 'noProgressRuns', 'failedRuns', 'billedTokensUsed'].every(integer) ||
    Number(goal.revision) < 1 ||
    (goal.timeUsedMs !== null && !integer('timeUsedMs')) ||
    typeof goal.costUsed !== 'number' ||
    !Number.isFinite(goal.costUsed) ||
    goal.costUsed < 0 ||
    (goal.legacyUsage !== undefined && typeof goal.legacyUsage !== 'boolean')
  )
    throw invalid();
  if (goal.plan !== undefined) validateGoalPlan(goal.plan);
  return structuredClone(goal) as unknown as DesktopGoalState;
}
export interface GoalRunActivity {
  usedTools: boolean;
  failedCommand: boolean;
  successfulTool: boolean;
}
export function nextGoalBoundary(goal: DesktopGoalState, activity: GoalRunActivity, now: number) {
  if (goal.status !== 'active') return { state: goal, continue: false };
  const automatic = goal.continuations > 0;
  const next = {
    ...goal,
    noProgressRuns: automatic && !activity.usedTools ? goal.noProgressRuns + 1 : 0,
    failedRuns: automatic && activity.failedCommand && !activity.successfulTool ? goal.failedRuns + 1 : 0,
    updatedAt: now,
  };
  if (next.tokenBudget !== undefined && next.tokensUsed >= next.tokenBudget)
    return {
      state: { ...next, status: 'budget_limited' as const, reason: `已达到用量上限 ${next.tokenBudget}` },
      continue: false,
    };
  const reason =
    next.noProgressRuns >= MAX_GOAL_NO_PROGRESS_RUNS
      ? '连续 3 轮没有进展'
      : next.failedRuns >= MAX_GOAL_NO_PROGRESS_RUNS
        ? '连续 3 轮命令失败'
        : undefined;
  if (reason) return { state: { ...next, status: 'blocked' as const, reason }, continue: false };
  return { state: { ...next, continuations: next.continuations + 1 }, continue: true };
}
