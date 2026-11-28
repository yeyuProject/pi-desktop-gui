import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { LoaderCircle } from 'lucide-react';
import type { TurnItem, VisibleTurns } from '../../lib/conversation-layout';
import { topLayer } from '../../hooks/useLayer';
import { CopyButton } from '../CopyButton';

const rowHeight = 28;
const tickHeight = 8;
const overscan = 8;
const maxTickHeight = (80 - overscan * 2 - 1) * tickHeight;
type Filter = 'all' | 'modified' | 'failed';
export const TurnOutline = memo(function TurnOutline({
  turns,
  active,
  visibleTurns,
  geometry,
  running,
  jump,
  focusConversation,
  copyReply,
  notice,
}: {
  turns: TurnItem[];
  active: number;
  visibleTurns?: VisibleTurns;
  geometry: { center: number; height: number };
  running: boolean;
  jump: (index: number) => void;
  focusConversation: () => void;
  copyReply: (index: number) => Promise<boolean>;
  notice: (text: string) => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  const rail = useRef<HTMLDivElement>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const suppressHover = useRef(false);
  const [expanded, setExpanded] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const [offset, setOffset] = useState(0);
  const [focus, setFocus] = useState<number>();
  const [hovered, setHovered] = useState<number>();
  const [focused, setFocused] = useState<number>();
  const [railHovered, setRailHovered] = useState<number>();
  const [railOffset, setRailOffset] = useState(0);
  const [openingRows, setOpeningRows] = useState<number[]>([]);
  const [newTick, setNewTick] = useState<number>();
  const [settledTick, setSettledTick] = useState<number>();
  const lastTurn = turns.at(-1)?.turn;
  const previousCount = useRef(turns.length);
  const runningTurn = useRef(running ? lastTurn : undefined);
  const heightLimit = Math.floor(geometry.height * 0.6);
  const trackHeight = turns.length * tickHeight;
  const railHeight = Math.min(trackHeight, maxTickHeight, heightLimit);
  const railStart = Math.max(0, Math.floor(railOffset / tickHeight) - overscan);
  const railEnd = Math.min(turns.length, Math.ceil((railOffset + railHeight) / tickHeight) + overscan);
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
  const open = () => {
    if (expanded) return;
    const first = Math.floor((list.current?.scrollTop ?? 0) / rowHeight);
    const limit = Math.min(12, Math.ceil((list.current?.clientHeight ?? 0) / rowHeight));
    setOpeningRows(filtered.slice(first, first + limit).map((turn) => turn.turn));
    setExpanded(true);
  };
  const cancelTimers = () => {
    clearTimeout(openTimer.current);
    clearTimeout(closeTimer.current);
  };
  const close = () => {
    cancelTimers();
    setExpanded(false);
    setHovered(undefined);
    setRailHovered(undefined);
  };
  useEffect(() => cancelTimers, []);
  useEffect(() => {
    if (filter !== 'all' && (!hasSummary || !counts[filter])) setFilter('all');
  }, [filter, hasSummary, counts]);
  const activeIndex = useMemo(() => filtered.findIndex((turn) => turn.turn === active), [filtered, active]);
  useLayoutEffect(() => {
    const element = rail.current;
    if (!element) return;
    // 刻度轨有自己的滚动位置，打开面板或筛选列表都不会挪动刻度。
    element.scrollTop = Math.max(0, (active - 0.5) * tickHeight - railHeight / 2);
    setRailOffset(element.scrollTop);
  }, [active, railHeight, trackHeight]);
  useLayoutEffect(() => {
    const element = list.current;
    if (!element || expanded || activeIndex < 0) return;
    element.scrollTop = Math.max(0, (activeIndex + 0.5) * rowHeight - element.clientHeight / 2);
    setOffset(element.scrollTop);
  }, [activeIndex, filtered.length, expanded, heightLimit]);
  useLayoutEffect(() => {
    const element = list.current;
    if (!element || !expanded || railHovered === undefined) return;
    const index = filtered.findIndex((turn) => turn.turn === railHovered);
    if (index < 0) return;
    const rowTop = index * rowHeight;
    const scrollTop = element.scrollTop;
    if (rowTop < scrollTop) element.scrollTop = rowTop;
    if (rowTop + rowHeight > scrollTop + element.clientHeight)
      element.scrollTop = rowTop + rowHeight - element.clientHeight;
    if (element.scrollTop !== scrollTop) {
      setOpeningRows([]);
      setOffset(element.scrollTop);
    }
  }, [railHovered, expanded, filtered]);
  useLayoutEffect(() => {
    const added = turns.length > previousCount.current;
    previousCount.current = turns.length;
    setNewTick(added ? lastTurn : undefined);
    if (!added) return;
    const timer = setTimeout(() => setNewTick(undefined), 240);
    return () => clearTimeout(timer);
  }, [turns.length, lastTurn]);
  useLayoutEffect(() => {
    const settled = running ? undefined : runningTurn.current;
    runningTurn.current = running ? lastTurn : undefined;
    setSettledTick(settled);
    if (settled === undefined) return;
    const timer = setTimeout(() => setSettledTick(undefined), 400);
    return () => clearTimeout(timer);
  }, [running, lastTurn]);
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
    const timer = setTimeout(() => setOpeningRows([]), 280);
    return () => clearTimeout(timer);
  }, [expanded]);
  useEffect(() => {
    if (!expanded) return;
    const escape = (event: KeyboardEvent) => {
      const layer = topLayer();
      if (
        event.key !== 'Escape' ||
        event.isComposing ||
        event.defaultPrevented ||
        // 选区工具栏在冒泡阶段处理 Esc，目录在捕获阶段须让它先关闭。
        document.querySelector('.selection-menu') ||
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
      style={
        {
          '--turn-number-width': `${String(lastTurn ?? 1).length + 1}ch`,
          '--turn-outline-center': `${geometry.center}px`,
          '--turn-outline-limit': `${heightLimit}px`,
          '--turn-panel-height': `${filtered.length * rowHeight + (hasSummary ? 28 : 0) + 10}px`,
          '--turn-rail-height': `${railHeight}px`,
        } as CSSProperties
      }
      onPointerEnter={() => {
        clearTimeout(closeTimer.current);
        if (!expanded && !suppressHover.current) {
          clearTimeout(openTimer.current);
          openTimer.current = setTimeout(open, 120);
        }
      }}
      onPointerLeave={(event) => {
        clearTimeout(openTimer.current);
        suppressHover.current = false;
        setHovered(undefined);
        if (!event.currentTarget.contains(document.activeElement))
          closeTimer.current = setTimeout(close, 250);
      }}
      onFocusCapture={() => {
        cancelTimers();
        suppressHover.current = false;
        open();
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
          if (reply !== undefined)
            (event.target as HTMLElement)
              .closest('.turn-outline-item')
              ?.querySelector<HTMLButtonElement>('.turn-copy')
              ?.click();
          else notice('本轮没有可复制的回复');
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
        open();
        const index = Math.max(0, Math.min(filtered.length - 1, target));
        list.current.scrollTop = Math.max(0, (index + 0.5) * rowHeight - list.current.clientHeight / 2);
        setOffset(list.current.scrollTop);
        setFocus(index);
      }}
    >
      <div className="turn-panel">
        {hasSummary && (
          <div className="turn-outline-summary">
            <span>{turns.length} 轮</span>
            {counts.modified > 0 && (
              <button
                tabIndex={expanded ? 0 : -1}
                aria-pressed={filter === 'modified'}
                onClick={() => toggleFilter('modified')}
              >
                修改 {counts.modified}
              </button>
            )}
            {counts.failed > 0 && (
              <button
                tabIndex={expanded ? 0 : -1}
                aria-pressed={filter === 'failed'}
                onClick={() => toggleFilter('failed')}
              >
                失败 {counts.failed}
              </button>
            )}
          </div>
        )}
        <div
          className="turn-outline-list"
          ref={list}
          onScroll={(event) => setOffset(event.currentTarget.scrollTop)}
        >
          <div aria-hidden="true" style={{ height: start * rowHeight, flexShrink: 0 }} />
          {filtered.slice(start, end).map((turn, i) => {
            const entering = openingRows.indexOf(turn.turn);
            const selected = active === turn.turn;
            const visible = visibleTurns && turn.turn >= visibleTurns[0] && turn.turn <= visibleTurns[1];
            const live = running && turn.turn === lastTurn;
            return (
              <div
                className={'turn-outline-item' + (expanded && entering >= 0 ? ' entering' : '')}
                style={expanded && entering >= 0 ? { animationDelay: `${entering * 12}ms` } : undefined}
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
                    selected ? 'current' : visible ? 'in-view' : '',
                    railHovered === turn.turn ? 'previewed' : '',
                    live ? 'running' : '',
                  ].join(' ')}
                  tabIndex={expanded || selected || (activeIndex < 0 && start + i === 0) ? 0 : -1}
                  aria-label={[
                    `第 ${turn.turn} 轮：${turn.title}`,
                    ...(turn.added ? [`新增 ${turn.added} 行`] : []),
                    ...(turn.removed ? [`删除 ${turn.removed} 行`] : []),
                    ...(turn.failed ? ['有失败'] : []),
                  ].join('，')}
                  aria-current={selected ? 'step' : undefined}
                  onClick={() => jump(turn.index)}
                >
                  <span className="turn-number">#{turn.turn}</span>
                  <span className="turn-title">
                    {turn.skillName && <span className="turn-skill">{turn.skillName}</span>}
                    <span className="turn-title-text">{turn.title}</span>
                  </span>
                  {(turn.added > 0 || turn.removed > 0 || turn.failed || live) && (
                    <span className="turn-statistics">
                      {turn.added > 0 && <span className="turn-added">+{turn.added}</span>}
                      {turn.removed > 0 && <span className="turn-removed">−{turn.removed}</span>}
                      {turn.failed && <span className="turn-failed-label">失败</span>}
                      {live && (
                        <LoaderCircle size={12} className="spin turn-running-icon" aria-label="运行中" />
                      )}
                    </span>
                  )}
                </button>
                {expanded && (hovered === turn.turn || focused === turn.turn) && (
                  <CopyButton
                    iconOnly
                    className="turn-copy"
                    label={`复制第 ${turn.turn} 轮回复`}
                    title={turn.replyIndex === undefined ? '本轮没有可复制的回复' : '复制本轮回复（C）'}
                    disabled={turn.replyIndex === undefined}
                    copy={() => turn.replyIndex !== undefined && copyReply(turn.replyIndex)}
                  />
                )}
              </div>
            );
          })}
          <div aria-hidden="true" style={{ height: (filtered.length - end) * rowHeight, flexShrink: 0 }} />
        </div>
      </div>
      <div
        className="turn-rail"
        aria-hidden="true"
        tabIndex={-1}
        onMouseDown={(event) => event.preventDefault()}
        ref={rail}
        data-more-above={railOffset > 1 || undefined}
        data-more-below={railOffset + railHeight < trackHeight - 1 || undefined}
        onScroll={(event) => setRailOffset(event.currentTarget.scrollTop)}
        onPointerLeave={() => setRailHovered(undefined)}
      >
        <div className="turn-rail-track" style={{ height: trackHeight }}>
          {visibleTurns && (
            <div
              className="turn-rail-viewport"
              data-first={visibleTurns[0]}
              data-last={visibleTurns[1]}
              style={{
                height: (visibleTurns[1] - visibleTurns[0] + 1) * tickHeight,
                transform: `translateY(${(visibleTurns[0] - 1) * tickHeight}px)`,
              }}
            />
          )}
          <div className="turn-rail-window" style={{ top: railStart * tickHeight }}>
            {turns.slice(railStart, railEnd).map((turn) => (
              <div
                className={[
                  'turn-tick',
                  turn.failed ? 'failed' : turn.modified ? 'modified' : '',
                  active === turn.turn ? 'current' : '',
                  running && turn.turn === lastTurn ? 'running' : '',
                  newTick === turn.turn ? 'new-tick' : '',
                  settledTick === turn.turn ? 'settled-tick' : '',
                ].join(' ')}
                data-rail-turn={turn.turn}
                key={turn.turn}
                onPointerEnter={() => setRailHovered(turn.turn)}
                onClick={() => jump(turn.index)}
              />
            ))}
          </div>
        </div>
      </div>
    </nav>
  );
});
