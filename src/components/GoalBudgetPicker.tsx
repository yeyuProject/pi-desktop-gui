import { useEffect, useId, useRef, useState } from 'react';
import { Info } from 'lucide-react';
import { useLayer } from '../hooks/useLayer';
import {
  compactGoalTokens,
  GOAL_BUDGET_PRESETS,
  parseGoalBudget,
  goalRequestTokens,
} from '../../shared/goal';
import type { Message } from '../../shared/types';

export function GoalBudgetPicker({
  messages,
  initialBudget,
  used = 0,
  disabled = false,
  resume = false,
  submit,
}: {
  messages: Message[];
  initialBudget?: number;
  used?: number;
  disabled?: boolean;
  resume?: boolean;
  submit: (tokenBudget?: number) => void | Promise<void>;
}) {
  const budgetId = useId();
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLSpanElement>(null),
    popup = useRef<HTMLDivElement>(null);
  useLayer(popup, open, () => setOpen(false), { kind: 'menu', trapFocus: true });
  useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent) => {
      if (!wrapper.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', outside);
    return () => document.removeEventListener('mousedown', outside);
  }, [open]);
  const [budget, setBudget] = useState<string>('');
  const [custom, setCustom] = useState('');
  const [pending, setPending] = useState(false),
    [error, setError] = useState('');
  const usages = messages
    .filter((m) => m.role === 'assistant')
    .map((m) => goalRequestTokens(m.usage))
    .filter((value): value is number => typeof value === 'number' && value > 0);
  const average = usages.length
    ? Math.round(usages.reduce((sum, value) => sum + value, 0) / usages.length)
    : undefined;
  const estimateHelp = `${average ? `当前会话平均每次请求约 ${compactGoalTokens(average)} tokens。` : ''}用量包含输入、输出和缓存写入，不含缓存命中。实际请求次数会随任务变化。`;
  let limit: number | undefined;
  try {
    limit = parseGoalBudget(budget === 'custom' ? custom : budget);
  } catch {
    /* Show validation on submit. */
  }
  const save = async () => {
    setError('');
    try {
      if (budget === 'custom' && !custom.trim()) throw new Error('请输入上限，或选择“不限”。');
      const tokenBudget = parseGoalBudget(budget === 'custom' ? custom : budget);
      if (resume && tokenBudget !== undefined && tokenBudget <= used)
        throw new Error('请把上限调到高于已用量，或选择“不限”。');
      setPending(true);
      await submit(tokenBudget);
      setOpen(false);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setPending(false);
    }
  };
  return (
    <span className="goal-budget-picker" ref={wrapper}>
      <button
        disabled={disabled}
        aria-expanded={open}
        aria-label={resume ? '调整上限并继续' : 'Goal 上限'}
        onClick={() => {
          setBudget(GOAL_BUDGET_PRESETS.find((v) => parseGoalBudget(v) === initialBudget) ?? 'custom');
          setCustom(initialBudget === undefined ? '' : String(initialBudget));
          setError('');
          setOpen(!open);
        }}
      >
        {resume
          ? '调整上限并继续'
          : `上限：${initialBudget === undefined ? '不限' : compactGoalTokens(initialBudget)} ▾`}
      </button>
      {open && (
        <div className="goal-budget-popover" role="group" aria-label="Goal 上限选择" ref={popup}>
          <div className="goal-budget-heading">
            <label htmlFor={budgetId}>用量上限</label>
            <span className="goal-budget-help" role="img" title={estimateHelp} aria-label={estimateHelp}>
              <Info size={14} aria-hidden="true" />
            </span>
          </div>
          {resume && (
            <div className="goal-budget-used">
              <span>已用</span>
              <strong>{compactGoalTokens(used)} tokens</strong>
            </div>
          )}
          <div className="goal-budget-fields">
            <select
              id={budgetId}
              className="input"
              aria-label="Goal 用量上限"
              aria-description={estimateHelp}
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
          </div>
          {limit !== undefined && average !== undefined && (
            <div className="goal-budget-estimate">
              <span>预计可执行</span>
              <strong>约 {Math.max(0, Math.floor((limit - used) / average)).toLocaleString()} 次请求</strong>
            </div>
          )}
          {error && (
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}
          <div className="goal-budget-actions">
            <button disabled={pending} onClick={() => setOpen(false)}>
              取消
            </button>
            <button className="primary" disabled={pending} onClick={() => void save()}>
              {pending ? '正在提交…' : resume ? '调整并继续' : '确定上限'}
            </button>
          </div>
        </div>
      )}
    </span>
  );
}
