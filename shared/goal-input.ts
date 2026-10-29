import { parseGoalBudget, validateGoalAction, validateGoalObjective, type GoalSnapshot } from './goal';
import type { Message } from './types';

export type GoalStartDraft = { kind: 'start'; tokenBudget?: number };
/** The ordinary draft stays in Session; the editor never borrows its attachment buffers. */
export type GoalDraft =
  | GoalStartDraft
  | {
      kind: 'edit';
      goalId: string;
      revision: number;
      objective: string;
      restore?: GoalStartDraft;
    };
export interface GoalStartInput {
  objective: string;
  tokenBudget?: number;
  /** Exact pre-command expansion snapshot, for conditional draft consumption. */
  draftText: string;
  draftGoal?: GoalDraft;
}
export function readGoalDraft(value: unknown): GoalDraft | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const row = value as GoalDraft;
  const start = (v: GoalStartDraft) =>
    v?.kind === 'start' &&
    (v.tokenBudget === undefined || (Number.isSafeInteger(v.tokenBudget) && v.tokenBudget > 0));
  if (row.kind === 'start' && start(row))
    return { kind: 'start', ...(row.tokenBudget === undefined ? {} : { tokenBudget: row.tokenBudget }) };
  if (
    row.kind === 'edit' &&
    typeof row.goalId === 'string' &&
    row.goalId.length > 0 &&
    row.goalId.length <= 100 &&
    Number.isSafeInteger(row.revision) &&
    row.revision > 0 &&
    typeof row.objective === 'string' &&
    row.objective.length <= 1024 * 1024 &&
    (row.restore === undefined || start(row.restore))
  )
    return {
      kind: 'edit',
      goalId: row.goalId,
      revision: row.revision,
      objective: row.objective,
      ...(row.restore ? { restore: readGoalDraft(row.restore) as GoalStartDraft } : {}),
    };
  return undefined;
}
export const sameGoalDraft = (a: GoalDraft | undefined, b: GoalDraft | undefined) =>
  JSON.stringify(readGoalDraft(a)) === JSON.stringify(readGoalDraft(b));
export function editGoalDraft(goal: GoalSnapshot, previous?: GoalDraft): GoalDraft {
  return {
    kind: 'edit',
    goalId: goal.id,
    revision: goal.revision,
    objective: goal.objective,
    restore: previous?.kind === 'start' ? previous : previous?.restore,
  };
}
export function validateGoalStartInput(value: GoalStartInput) {
  validateGoalAction({ action: 'start', objective: value?.objective, tokenBudget: value?.tokenBudget });
  if (
    typeof value.draftText !== 'string' ||
    value.draftText.length > 1024 * 1024 ||
    (value.draftGoal !== undefined && !readGoalDraft(value.draftGoal))
  )
    throw new Error('Goal 草稿格式无效，请重新打开 Goal。');
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
  const preview = goalCommandPreview('/goal ' + text)!;
  if (preview.error) throw new Error(preview.error);
  validateGoalObjective(preview.objective);
  return {
    action: 'start',
    objective: preview.objective,
    ...(preview.tokenBudget === undefined ? {} : { tokenBudget: preview.tokenBudget }),
  };
}
/** Incomplete input can still show the mode bar and retain all editable text. */
export function goalCommandPreview(
  text: string,
): { objective: string; tokenBudget?: number; error?: string } | undefined {
  const match = /^\s*\/goal(?:\s+([\s\S]*))?$/.exec(text);
  if (!match) return undefined;
  const body = (match[1] ?? '').trim();
  if (/^(?:status|pause|resume|clear)$/.test(body) || /^edit(?:\s|$)/.test(body)) return undefined;
  if (/^--tokens(?:\s|$)/.test(body)) {
    const parts = /^--tokens(?:\s+(\S+))?(?:\s+([\s\S]*))?$/.exec(body)!;
    try {
      if (!parts[1]) throw new Error('请输入用量上限，例如 500k。');
      return { objective: parts[2]?.trim() ?? '', tokenBudget: parseGoalBudget(parts[1]) };
    } catch (error) {
      return { objective: parts[2]?.trim() ?? '', error: (error as Error).message };
    }
  }
  return {
    objective: body,
    ...(body.startsWith('--') ? { error: 'Goal 只支持前置预算参数：/goal [--tokens N] <目标>。' } : {}),
  };
}
export function exitGoalCommand(text: string): string {
  const body = text.replace(/^\s*\/goal(?:\s+|$)/, '');
  return body.replace(/^--tokens(?:\s+\S+)?(?:\s+|$)/, '');
}
export function withGoalBudget(text: string, budget?: number): string {
  return `/goal ${budget === undefined ? '' : `--tokens ${budget} `}${exitGoalCommand(text)}`;
}
export function isGoalStartMessage(messages: Message[], index: number): boolean {
  if (messages[index]?.role !== 'user') return false;
  for (let i = index - 1; i >= 0; i--) {
    const prior = messages[i];
    if (prior.role === 'system') continue;
    if (prior.role !== 'custom') return false;
    if (prior.customType === 'desktop-goal-start') return true;
    if (prior.display !== false) return false;
  }
  return false;
}
