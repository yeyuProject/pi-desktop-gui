import type { Runtime } from '../../shared/types';

type Stats = NonNullable<Runtime['stats']>;
const count = (value: number | undefined) => value?.toLocaleString() ?? '未知';
const compactCount = (value: number | undefined) => {
  if (value === undefined) return '未知';
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(1))}M`;
  if (value >= 1_000) return `${Number((value / 1_000).toFixed(1))}k`;
  return value.toLocaleString();
};

export function contextUsageLabel(stats: Stats, compact = false) {
  const format = compact ? compactCount : count;
  const capacity =
    stats.contextTokens !== undefined || stats.contextWindow !== undefined
      ? `${format(stats.contextTokens)} / ${format(stats.contextWindow)}${compact ? '' : ' tokens'}`
      : '未知';
  const percent = stats.contextPercent;
  if (percent === undefined) return capacity;
  return compact ? `${Math.round(percent)}% (${capacity})` : `${capacity} (${percent.toFixed(1)}%)`;
}

/** Project the active request from Pi's last context estimate and received output. */
export function liveContextUsage(stats: Stats, live: NonNullable<Runtime['liveUsage']>): Stats | undefined {
  const input = live.inputTokens ?? stats.contextTokens;
  if (input === undefined) return undefined;
  const contextTokens = input + live.outputTokens;
  return {
    ...stats,
    contextTokens,
    contextPercent: stats.contextWindow ? (contextTokens / stats.contextWindow) * 100 : undefined,
    tokens: stats.tokens === undefined ? undefined : stats.tokens + contextTokens,
  };
}

/** Pi normalizes uncached input, cache reads and cache writes as separate token categories. */
export function cacheReadPercent(stats: Stats) {
  const { inputTokens, cacheReadTokens, cacheWriteTokens } = stats;
  if (inputTokens === undefined || cacheReadTokens === undefined || cacheWriteTokens === undefined)
    return undefined;
  const inputTotal = inputTokens + cacheReadTokens + cacheWriteTokens;
  return inputTotal > 0 ? (cacheReadTokens / inputTotal) * 100 : undefined;
}

export function sessionUsageRows(stats: Stats): { label: string; value: string; title?: string }[] {
  const remaining =
    stats.contextTokens !== undefined && stats.contextWindow !== undefined
      ? Math.max(0, stats.contextWindow - stats.contextTokens)
      : undefined;
  const cachePercent = cacheReadPercent(stats);
  return [
    { label: '当前上下文（估算）', value: contextUsageLabel(stats) },
    {
      label: '窗口剩余',
      value: `${count(remaining)} tokens`,
      title: '按模型上下文窗口估算的剩余容量；自动压缩可能提前触发。',
    },
    { label: '会话累计', value: `${count(stats.tokens)} tokens` },
    { label: '累计输入（不含缓存）', value: `${count(stats.inputTokens)} tokens` },
    { label: '累计输出', value: `${count(stats.outputTokens)} tokens` },
    { label: '累计缓存读取', value: `${count(stats.cacheReadTokens)} tokens` },
    { label: '累计缓存写入', value: `${count(stats.cacheWriteTokens)} tokens` },
    {
      label: '缓存读取占输入',
      value: cachePercent === undefined ? '未知' : `${cachePercent.toFixed(1)}%`,
      title: '累计缓存读取 ÷（累计输入 + 累计缓存读取 + 累计缓存写入）；按 Token 计算，不是请求命中率。',
    },
    { label: '估算费用', value: stats.cost === undefined ? '未知' : `$${stats.cost.toFixed(4)}` },
  ];
}
