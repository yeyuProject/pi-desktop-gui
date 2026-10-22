import { memo, useEffect, useRef, useState } from 'react';
import type { TurnItem } from '../../lib/conversation-layout';

const rowHeight = 24;
const windowSize = 60;
export const TurnOutline = memo(function TurnOutline({
  turns,
  active,
  jump,
}: {
  turns: TurnItem[];
  active: number;
  jump: (index: number) => void;
}) {
  const list = useRef<HTMLElement>(null);
  const [offset, setOffset] = useState(0);
  const [focus, setFocus] = useState<number>();
  const start = Math.max(0, Math.min(turns.length - windowSize, Math.floor(offset / rowHeight) - 4));
  const end = Math.min(turns.length, start + windowSize);
  useEffect(() => {
    if (focus !== undefined) {
      const button = list.current?.querySelector<HTMLButtonElement>(`[data-outline-index="${focus}"]`);
      if (button) {
        button.focus({ preventScroll: true });
        setFocus(undefined);
      }
    }
  }, [focus, start]);
  return (
    <nav
      className="turn-outline"
      aria-label="对话轮次"
      ref={list}
      onScroll={(event) => setOffset(event.currentTarget.scrollTop)}
      onKeyDown={(event) => {
        const current = Number(
          (event.target as HTMLElement).closest<HTMLElement>('[data-outline-index]')?.dataset.outlineIndex,
        );
        if (!Number.isFinite(current)) return;
        const target =
          event.key === 'ArrowDown'
            ? current + 1
            : event.key === 'ArrowUp'
              ? current - 1
              : event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? turns.length - 1
                  : undefined;
        if (target === undefined) return;
        event.preventDefault();
        const index = Math.max(0, Math.min(turns.length - 1, target));
        event.currentTarget.scrollTop = index * rowHeight;
        setOffset(event.currentTarget.scrollTop);
        setFocus(index);
      }}
    >
      <div aria-hidden="true" style={{ height: start * rowHeight, flexShrink: 0 }} />
      {turns.slice(start, end).map((turn, i) => (
        <button
          key={turn.turn}
          data-outline-index={start + i}
          style={{ height: rowHeight, minHeight: rowHeight, flexShrink: 0 }}
          title={`第 ${turn.turn} 轮：${turn.title}`}
          className={[
            turn.failed ? 'failed' : turn.modified ? 'modified' : '',
            active === turn.turn ? 'current' : '',
          ].join(' ')}
          aria-current={active === turn.turn ? 'step' : undefined}
          onClick={() => jump(turn.index)}
        >
          <i />
          <span>
            #{turn.turn} {turn.title}
            <small>
              +{turn.added} / −{turn.removed}
            </small>
          </span>
        </button>
      ))}
      <div aria-hidden="true" style={{ height: (turns.length - end) * rowHeight, flexShrink: 0 }} />
    </nav>
  );
});
