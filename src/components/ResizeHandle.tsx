import { useEffect, useRef, type PointerEvent } from 'react';

interface Props {
  label: string;
  variable: '--sidebar-width' | '--inspector-width' | '--side-chat-width';
  value: number;
  min: number;
  max: number;
  defaultValue: number;
  direction: 1 | -1;
  save: (value: number) => void;
}

/** Dragging updates only a CSS variable; the store is written once on release. */
export function ResizeHandle({ label, variable, value, min, max, defaultValue, direction, save }: Props) {
  const drag = useRef<{ x: number; start: number; current: number } | null>(null);
  const width = useRef(value);
  const previousValue = useRef(value);
  if (value !== previousValue.current) {
    previousValue.current = value;
    if (!drag.current) width.current = value;
  }
  const clamp = (width: number) => Math.round(Math.min(max, Math.max(min, width)));
  const preview = (width: number) => document.documentElement.style.setProperty(variable, width + 'px');
  const commit = (next: number) => {
    width.current = next;
    preview(next);
    save(next);
  };
  useEffect(() => () => document.body.classList.remove('resizing-columns'), []);
  const finish = (event: PointerEvent<HTMLDivElement>, cancelled = false) => {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    document.body.classList.remove('resizing-columns');
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    if (cancelled) preview(current.start);
    else commit(current.current);
  };
  return (
    <div
      className="column-resize-handle"
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      tabIndex={0}
      title={`${label} · 拖动调整，双击恢复默认宽度`}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { x: event.clientX, start: width.current, current: width.current };
        document.body.classList.add('resizing-columns');
      }}
      onPointerMove={(event) => {
        if (!drag.current) return;
        drag.current.current = clamp(drag.current.start + direction * (event.clientX - drag.current.x));
        preview(drag.current.current);
      }}
      onPointerUp={(event) => finish(event)}
      onPointerCancel={(event) => finish(event, true)}
      onLostPointerCapture={(event) => finish(event, true)}
      onDoubleClick={() => commit(defaultValue)}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault();
          commit(clamp(width.current + direction * (event.key === 'ArrowRight' ? 10 : -10)));
        } else if (event.key === 'Home') {
          event.preventDefault();
          commit(defaultValue);
        }
      }}
    />
  );
}
