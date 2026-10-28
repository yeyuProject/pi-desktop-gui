import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { TurnItem } from '../../lib/conversation-layout';
import { topLayer } from '../../hooks/useLayer';
import { Copy } from 'lucide-react';

const rowHeight = 26;
type Filter = 'all' | 'modified' | 'failed';
export const TurnOutline = memo(function TurnOutline({
  turns,
  active,
  running,
  jump,
  focusConversation,
  copyReply,
}: {
  turns: TurnItem[];
  active: number;
  running: boolean;
  jump: (index: number) => void;
  focusConversation: () => void;
  copyReply: (index: number) => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const suppressHover = useRef(false);
  const [expanded, setExpanded] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const [offset, setOffset] = useState(0);
  const [focus, setFocus] = useState<number>();
  const [hovered, setHovered] = useState<number>();
  const [focused, setFocused] = useState<number>();
  const counts = useMemo(
    () => ({
      modified: turns.filter((turn) => turn.modified).length,
      failed: turns.filter((turn) => turn.failed).length,
    }),
    [turns],
  );
  const filtered = useMemo(
    () => (filter === 'all' ? turns : turns.filter((turn) => turn[filter])),
    [turns, filter],
  );
  const hasSummary = turns.length >= 10;
  // Reserve two copy buttons for the hovered and keyboard-focused rows.
  const windowSize = hasSummary ? 56 : 58;
  const start = Math.max(0, Math.min(filtered.length - windowSize, Math.floor(offset / rowHeight) - 4));
  const end = Math.min(filtered.length, start + windowSize);
  const cancelTimers = () => {
    clearTimeout(openTimer.current);
    clearTimeout(closeTimer.current);
  };
  const close = () => {
    cancelTimers();
    setExpanded(false);
    setHovered(undefined);
  };
  useEffect(() => cancelTimers, []);
  useEffect(() => {
    if (filter !== 'all' && (!hasSummary || !counts[filter])) setFilter('all');
  }, [filter, hasSummary, counts]);
  useLayoutEffect(() => {
    const element = list.current;
    if (!element || expanded) return;
    const followCurrent = () => {
      const index = filtered.findIndex((turn) => turn.turn === active);
      if (index < 0) return;
      element.scrollTop = Math.max(0, (index + 0.5) * rowHeight - element.clientHeight / 2);
      setOffset(element.scrollTop);
    };
    // Center while collapsed: opening never changes a tick's screen position.
    followCurrent();
    const observer = new ResizeObserver(followCurrent);
    observer.observe(element);
    return () => observer.disconnect();
  }, [active, filtered, expanded]);
  useLayoutEffect(() => {
    if (focus === undefined) return;
    const button = list.current?.querySelector<HTMLButtonElement>(`[data-outline-index="${focus}"]`);
    if (button) {
      button.focus({ preventScroll: true });
      setFocus(undefined);
    }
  }, [focus, start, end]);
  useEffect(() => {
    if (!expanded) return;
    const escape = (event: KeyboardEvent) => {
      const layer = topLayer();
      if (
        event.key !== 'Escape' ||
        event.isComposing ||
        event.defaultPrevented ||
        (layer && (layer.kind !== 'panel' || layer.trap))
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      suppressHover.current = true;
      close();
      focusConversation();
    };
    document.addEventListener('keydown', escape, true);
    return () => document.removeEventListener('keydown', escape, true);
  }, [expanded, focusConversation]);
  const toggleFilter = (value: Exclude<Filter, 'all'>) => {
    setFilter((current) => (current === value ? 'all' : value));
    setOffset(0);
    if (list.current) list.current.scrollTop = 0;
  };
  return (
    <nav
      className={`turn-outline${expanded ? ' expanded' : ''}`}
      aria-label="对话轮次"
      onPointerEnter={() => {
        clearTimeout(closeTimer.current);
        if (!expanded && !suppressHover.current) {
          clearTimeout(openTimer.current);
          openTimer.current = setTimeout(() => setExpanded(true), 120);
        }
      }}
      onPointerLeave={() => {
        clearTimeout(openTimer.current);
        suppressHover.current = false;
        setHovered(undefined);
        closeTimer.current = setTimeout(close, 250);
      }}
      onFocusCapture={() => {
        cancelTimers();
        suppressHover.current = false;
        setExpanded(true);
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget) && !event.currentTarget.matches(':hover'))
          closeTimer.current = setTimeout(close, 250);
      }}
      onKeyDown={(event) => {
        if (event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing) return;
        const current = Number(
          (event.target as HTMLElement)
            .closest('.turn-outline-item')
            ?.querySelector<HTMLElement>('[data-outline-index]')?.dataset.outlineIndex,
        );
        if (!Number.isFinite(current)) return;
        if (event.key.toLowerCase() === 'c') {
          event.preventDefault();
          const reply = filtered[current]?.replyIndex;
          if (reply !== undefined) copyReply(reply);
          return;
        }
        const target =
          event.key === 'ArrowDown'
            ? current + 1
            : event.key === 'ArrowUp'
              ? current - 1
              : event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? filtered.length - 1
                  : undefined;
        if (target === undefined || !list.current) return;
        event.preventDefault();
        setExpanded(true);
        const index = Math.max(0, Math.min(filtered.length - 1, target));
        list.current.scrollTop = Math.max(0, (index + 0.5) * rowHeight - list.current.clientHeight / 2);
        setOffset(list.current.scrollTop);
        setFocus(index);
      }}
    >
      {hasSummary && (
        <div className="turn-outline-summary">
          <span>{turns.length} 轮</span>
          <span aria-hidden="true">·</span>
          <button
            aria-pressed={filter === 'modified'}
            disabled={!counts.modified}
            onClick={() => toggleFilter('modified')}
          >
            修改 {counts.modified}
          </button>
          <span aria-hidden="true">·</span>
          <button
            aria-pressed={filter === 'failed'}
            disabled={!counts.failed}
            onClick={() => toggleFilter('failed')}
          >
            失败 {counts.failed}
          </button>
        </div>
      )}
      <div
        className="turn-outline-list"
        ref={list}
        onScroll={(event) => setOffset(event.currentTarget.scrollTop)}
      >
        <div aria-hidden="true" style={{ height: start * rowHeight, flexShrink: 0 }} />
        {filtered.slice(start, end).map((turn, i) => (
          <div
            className="turn-outline-item"
            key={turn.turn}
            onPointerEnter={() => setHovered(turn.turn)}
            onPointerLeave={() => setHovered(undefined)}
            onFocusCapture={() => setFocused(turn.turn)}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) setFocused(undefined);
            }}
          >
            <button
              data-outline-index={start + i}
              data-turn-number={turn.turn}
              title={turn.tooltip}
              className={[
                'turn-outline-row',
                turn.failed ? 'failed' : turn.modified ? 'modified' : '',
                active === turn.turn ? 'current' : '',
                running && turn.turn === turns.at(-1)?.turn ? 'running' : '',
              ].join(' ')}
              aria-label={[
                `第 ${turn.turn} 轮：${turn.title}`,
                ...(turn.added ? [`新增 ${turn.added} 行`] : []),
                ...(turn.removed ? [`删除 ${turn.removed} 行`] : []),
                ...(turn.failed ? ['有失败'] : []),
              ].join('，')}
              aria-current={active === turn.turn ? 'step' : undefined}
              onClick={() => jump(turn.index)}
            >
              <span className="turn-number">#{turn.turn}</span>
              <span className="turn-title">
                {turn.skillName && <span className="turn-skill">{turn.skillName}</span>}
                <span className="turn-title-text">{turn.title}</span>
              </span>
              {(turn.added > 0 || turn.removed > 0 || turn.failed) && (
                <span className="turn-statistics">
                  {turn.added > 0 && <span className="turn-added">+{turn.added}</span>}
                  {turn.removed > 0 && <span className="turn-removed">−{turn.removed}</span>}
                  {turn.failed && <span className="turn-failed-label">失败</span>}
                </span>
              )}
              <span className="turn-tick-column" aria-hidden="true">
                <i className="turn-tick" />
              </span>
            </button>
            {expanded && (hovered === turn.turn || focused === turn.turn) && (
              <button
                className="turn-copy"
                aria-label={`复制第 ${turn.turn} 轮回复`}
                title={turn.replyIndex === undefined ? '本轮没有可复制的回复' : '复制本轮回复（C）'}
                disabled={turn.replyIndex === undefined}
                onClick={() => turn.replyIndex !== undefined && copyReply(turn.replyIndex)}
              >
                <Copy size={13} />
              </button>
            )}
          </div>
        ))}
        <div aria-hidden="true" style={{ height: (filtered.length - end) * rowHeight, flexShrink: 0 }} />
      </div>
    </nav>
  );
});
