import { type Runtime, type Message } from '../../../shared/types';
import { useEffect, useRef, useState } from 'react';
import { contextUsageLabel, liveContextUsage, sessionUsageRows } from '../../lib/context-usage';
import { useLayer } from '../../hooks/useLayer';

export function SessionUsageDetails({ stats }: { stats: NonNullable<Runtime['stats']> }) {
  return sessionUsageRows(stats).map(({ label, value, title }) => (
    <span key={label} title={title}>
      {label} <strong>{value}</strong>
    </span>
  ));
}

export function ReplyMeta({ message }: { message: Message }) {
  const usage = message.usage as
    | { input?: number; output?: number; cacheRead?: number; totalTokens?: number; cost?: { total?: number } }
    | undefined;
  const model = String(message.responseModel ?? message.model ?? '');
  if (!usage?.totalTokens && !model) return null;
  const cost = usage?.cost?.total;
  return (
    <span
      className="reply-meta"
      title={[
        model && `模型：${message.provider ? message.provider + ' / ' : ''}${model}`,
        message.thinkingLevel && `推理：${String(message.thinkingLevel)}`,
        usage?.input !== undefined && `输入 ${usage.input.toLocaleString()} tokens`,
        usage?.cacheRead ? `缓存命中 ${usage.cacheRead.toLocaleString()}` : '',
        usage?.output !== undefined && `输出 ${usage.output.toLocaleString()} tokens`,
        cost ? `费用 $${cost.toFixed(4)}` : '',
      ]
        .filter(Boolean)
        .join('\n')}
    >
      {model && <span>{model}</span>}
      {!!usage?.totalTokens && <span>{usage.totalTokens.toLocaleString()} tokens</span>}
      {!!cost && <span>${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2)}</span>}
    </span>
  );
}

export function ReplySpeed({ message }: { message: Message }) {
  const output = (message.usage as { output?: number } | undefined)?.output;
  const duration = message.durationMs;
  if (
    message.role !== 'assistant' ||
    typeof output !== 'number' ||
    !Number.isFinite(output) ||
    output <= 0 ||
    typeof duration !== 'number' ||
    !Number.isFinite(duration) ||
    duration <= 0
  )
    return null;
  const tps = output / (duration / 1000);
  if (!Number.isFinite(tps)) return null;
  return (
    <div
      className="reply-speed"
      title={`平均输出速度：${output.toLocaleString()} tokens ÷ ${(duration / 1000).toFixed(2)} 秒（含等待模型响应时间，不含工具执行时间）`}
    >
      平均输出速度 <strong>{tps.toFixed(1)} TPS</strong>
    </div>
  );
}

export function ContextMeter({
  stats,
  liveUsage,
  open,
  compact,
  branch,
  disabled,
  branchDisabled,
}: {
  stats: NonNullable<Runtime['stats']>;
  liveUsage?: Runtime['liveUsage'];
  open: () => void;
  compact?: () => void;
  branch?: () => void;
  disabled?: boolean;
  branchDisabled?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const panel = useRef<HTMLSpanElement>(null);
  useLayer(panel, expanded, () => setExpanded(false), { kind: 'menu' });
  useEffect(() => {
    if (!expanded) return;
    const outside = (event: MouseEvent) => {
      if (!panel.current?.contains(event.target as Node)) setExpanded(false);
    };
    document.addEventListener('mousedown', outside);
    return () => {
      document.removeEventListener('mousedown', outside);
    };
  }, [expanded]);
  const projected = liveUsage ? liveContextUsage(stats, liveUsage) : undefined;
  const display = projected ?? stats;
  const percent = display.contextPercent;
  const level = percent === undefined ? '' : percent >= 90 ? 'high' : percent >= 75 ? 'mid' : '';
  const liveHelp = liveUsage
    ? '\n进行中的数字是估算：当前请求的输入优先使用服务商已上报值，否则参考当前上下文；输出根据已接收的文字和工具参数估算。系统提示、隐藏推理等可能造成偏差。回复结束后以 Pi 上报为准，本次费用尚未计入。'
    : '';
  return (
    <span className="context-actions" ref={panel}>
      <button
        className={'context-meter ' + level}
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        title={`当前上下文（估算）${contextUsageLabel(display)}\n累计 ${display.tokens?.toLocaleString() ?? '未知'} tokens${stats.cost === undefined ? '' : ` · 已计估算费用 $${stats.cost.toFixed(4)}`}${liveHelp}\n点击查看会话与上下文`}
      >
        {percent !== undefined && (
          <span className="meter" aria-hidden="true">
            <i style={{ width: Math.min(100, percent) + '%' }} />
          </span>
        )}
        <span>
          上下文{projected ? '约' : ''} {contextUsageLabel(display, true)}
        </span>
        {liveUsage && (!projected || projected.tokens === undefined) ? (
          <span>
            累计 {stats.tokens?.toLocaleString() ?? '未知'} + 输出约 {liveUsage.outputTokens.toLocaleString()}{' '}
            tokens
          </span>
        ) : (
          <span>
            累计{projected ? '约' : ''} {display.tokens?.toLocaleString() ?? '未知'} tokens
          </span>
        )}
        {stats.cost !== undefined && (
          <span>
            {liveUsage ? '已计约' : '估算'} $
            {stats.cost < 0.01 ? stats.cost.toFixed(4) : stats.cost.toFixed(2)}
          </span>
        )}
      </button>
      {expanded && (
        <span className="context-popover">
          {liveUsage && <span>以下为 Pi 最近返回的会话统计；本次请求仍在进行中。</span>}
          <SessionUsageDetails stats={stats} />
          <button
            disabled={disabled || !compact}
            title={disabled ? '本会话正在执行任务或暂时无法修改历史，请停止相关任务后压缩' : ''}
            onClick={() => {
              setExpanded(false);
              compact?.();
            }}
          >
            立即压缩上下文
          </button>
          <button
            disabled={branchDisabled || !branch}
            onClick={() => {
              setExpanded(false);
              branch?.();
            }}
          >
            从当前节点分支新会话
          </button>
          <button
            onClick={() => {
              setExpanded(false);
              open();
            }}
          >
            查看会话与本地用量
          </button>
        </span>
      )}
    </span>
  );
}
