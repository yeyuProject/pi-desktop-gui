import { useState, type ReactNode } from 'react';
import type { Message } from '../../../shared/types';

/** Presentation only: every failed attempt keeps its original message index and actions. */
export function RetryErrorGroup({
  messages,
  indices,
  visibleIndices,
  activeIndex,
  renderMessage,
}: {
  messages: Message[];
  indices: number[];
  visibleIndices: number[];
  activeIndex?: number;
  renderMessage: (index: number) => ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const latest = visibleIndices.at(-1)!;
  const previous = visibleIndices.slice(0, -1);
  const searchExpanded = previous.includes(activeIndex ?? -1);
  const open = expanded || searchExpanded;
  const identical = indices.every((index) => messages[index].errorMessage === messages[latest].errorMessage);
  return (
    <div className="retry-error-group">
      {renderMessage(latest)}
      <details
        className="retry-error-history"
        open={open}
        onToggle={(event) => {
          if (!searchExpanded) setExpanded(event.currentTarget.open);
        }}
      >
        <summary
          title={searchExpanded ? '查找已展开此记录，关闭查找后可收起' : undefined}
          onClick={(event) => {
            // Native details toggling must not hide the active search result while open stays true.
            if (searchExpanded) event.preventDefault();
          }}
        >
          {identical ? `相同错误 ×${indices.length}` : `请求失败记录 · ${indices.length} 次`}
          <span>
            {visibleIndices.length < indices.length
              ? ` · 本页 ${visibleIndices.length} 条`
              : ` · 前 ${previous.length} 条`}
          </span>
        </summary>
        {open && <div className="retry-error-history-content">{previous.map(renderMessage)}</div>}
      </details>
    </div>
  );
}
