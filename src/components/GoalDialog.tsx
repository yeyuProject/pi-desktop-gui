import { useState } from 'react';
import { Modal } from './Modal';
import {
  compactGoalTokens,
  GOAL_BUDGET_PRESETS,
  parseGoalBudget,
  goalRequestTokens,
  validateGoalObjective,
} from '../../shared/goal';
import type { Runtime } from '../../shared/types';

export function GoalDialog({
  runtime,
  budgetOnly = false,
  editing = false,
  initialObjective = '',
  initialBudget,
  used = 0,
  close,
  submit,
}: {
  runtime: Runtime;
  budgetOnly?: boolean;
  editing?: boolean;
  initialObjective?: string;
  initialBudget?: number;
  used?: number;
  close: () => void;
  submit: (objective: string, tokenBudget?: number) => Promise<void>;
}) {
  const [objective, setObjective] = useState(initialObjective);
  const initial = initialBudget === undefined ? '' : String(initialBudget);
  const preset = GOAL_BUDGET_PRESETS.find((value) => parseGoalBudget(value) === initialBudget);
  const [budget, setBudget] = useState<string>(preset ?? 'custom');
  const [custom, setCustom] = useState(initial);
  const [pending, setPending] = useState(false),
    [error, setError] = useState('');
  const usages = runtime.messages
    .filter((message) => message.role === 'assistant')
    .map((message) => goalRequestTokens(message.usage))
    .filter((value): value is number => typeof value === 'number' && value > 0 && Number.isFinite(value));
  const average = usages.length
    ? Math.round(usages.reduce((sum, value) => sum + value, 0) / usages.length)
    : undefined;
  let limit: number | undefined;
  try {
    limit = parseGoalBudget(budget === 'custom' ? custom : budget);
  } catch {
    /* Show the error on submission. */
  }
  const save = async () => {
    setError('');
    try {
      const tokenBudget = parseGoalBudget(budget === 'custom' ? custom : budget);
      if (!budgetOnly) validateGoalObjective(objective);
      if (budgetOnly && tokenBudget !== undefined && tokenBudget <= used)
        throw new Error('请把上限调到高于已用量，或选择“不限”。');
      setPending(true);
      await submit(objective.trim(), tokenBudget);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setPending(false);
    }
  };
  return (
    <Modal
      title={budgetOnly ? '调整上限并继续' : editing ? '编辑 Goal' : '新建 Goal'}
      close={() => !pending && close()}
    >
      <div className="modal-body goal-dialog">
        {!budgetOnly && (
          <label>
            目标
            <textarea
              className="input"
              aria-label="Goal 目标"
              rows={5}
              value={objective}
              onChange={(event) => setObjective(event.target.value)}
              disabled={pending}
            />
          </label>
        )}
        {!editing && (
          <details open={budgetOnly || undefined}>
            <summary>高级：用量上限（可选）</summary>
            {budgetOnly && <p>已用 {compactGoalTokens(used)} tokens</p>}
            <label>
              用量上限
              <select
                className="input"
                aria-label="Goal 用量上限"
                value={budget}
                onChange={(event) => setBudget(event.target.value)}
                disabled={pending}
              >
                {GOAL_BUDGET_PRESETS.map((value) => (
                  <option key={value} value={value}>
                    {value || '不限'}
                  </option>
                ))}
                <option value="custom">自定义</option>
              </select>
            </label>
            {budget === 'custom' && (
              <input
                className="input"
                aria-label="自定义用量上限"
                value={custom}
                placeholder="例如 800k 或 3m"
                onChange={(event) => setCustom(event.target.value)}
                disabled={pending}
              />
            )}
            <p className="muted">
              {average
                ? `按当前会话平均每次请求约 ${compactGoalTokens(average)} tokens 估算，${limit === undefined ? '不限请求次数' : `约可执行 ${Math.max(0, Math.floor((limit - used) / average))} 次请求`}；不含缓存命中。`
                : '上限按输入、输出和缓存写入计算，不含缓存命中。'}
            </p>
          </details>
        )}
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
      </div>
      <footer>
        <button disabled={pending} onClick={close}>
          取消
        </button>
        <button className="primary" disabled={pending} onClick={() => void save()}>
          {pending ? '正在提交…' : budgetOnly ? '调整并继续' : editing ? '保存修改' : '开始 Goal'}
        </button>
      </footer>
    </Modal>
  );
}
