import type { ReactNode } from 'react';
import type { ToolActivity } from '../../../shared/types';
export function ToolGroupCard({
  tools,
  visibleCount,
  expanded,
  onToggle,
  children,
}: {
  tools: ToolActivity[];
  visibleCount: number;
  expanded: boolean;
  onToggle: (open: boolean) => void;
  children: ReactNode;
}) {
  const reads = tools.filter((tool) => tool.name === 'read').length;
  return (
    <details className="tool-group" open={expanded} onToggle={(event) => onToggle(event.currentTarget.open)}>
      <summary>
        已探索 {tools.length} 项（读取 {reads} 个文件 · 搜索 {tools.length - reads} 次）
        {visibleCount < tools.length && <small>本页 {visibleCount} 项</small>}
        <small>
          合计 {(tools.reduce((sum, tool) => sum + (tool.durationMs ?? 0), 0) / 1000).toFixed(1)}s
        </small>
      </summary>
      {expanded && <div className="tool-group-content">{children}</div>}
    </details>
  );
}
