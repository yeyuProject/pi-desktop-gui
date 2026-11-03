import { X, CheckCircle2, AlertCircle, Info, TriangleAlert } from 'lucide-react';
import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react';
import { IconButton } from './IconButton';
import { notices } from '../lib/notice-store';
import { readableError } from '../lib/format';

interface Placement {
  top: number;
  right: number;
  width: number;
  height: number;
}
function usePlacement(active: boolean) {
  const [placement, setPlacement] = useState<Placement>();
  useLayoutEffect(() => {
    if (!active) return;
    let frame = 0;
    const observed = new Set<Element>();
    const measure = () => {
      frame = 0;
      const thread = document.querySelector<HTMLElement>('.thread');
      const modal = document.querySelector('[aria-modal="true"]') || thread?.closest('[inert]');
      const bounds = thread?.getBoundingClientRect();
      const titlebar = document.querySelector('.native-titlebar')?.getBoundingClientRect();
      const rightEdge = modal || !bounds ? innerWidth : bounds.right;
      const top = modal || !bounds ? (titlebar?.bottom ?? 0) + 12 : bounds.top + 12;
      const width = Math.min(420, (modal || !bounds ? innerWidth : bounds.width) - 24);
      let bottom = modal ? innerHeight - 12 : Math.min(innerHeight - 12, bounds?.bottom ?? innerHeight - 12);
      const approvals = modal ? [] : [...document.querySelectorAll('.approval-card')];
      for (const card of approvals) {
        const box = card.getBoundingClientRect();
        if (box.bottom > top && box.left < rightEdge - 12 && box.right > rightEdge - 12 - width)
          bottom = Math.min(bottom, Math.max(top, box.top - 8));
      }
      const next = {
        top,
        right: innerWidth - rightEdge + 12,
        width: Math.max(0, width),
        height: Math.max(0, bottom - top - 12),
      };
      setPlacement((before) =>
        before &&
        Object.keys(next).every((key) => before[key as keyof Placement] === next[key as keyof Placement])
          ? before
          : next,
      );
      const targets = new Set<Element>([...(thread ? [thread] : []), ...approvals]);
      for (const item of observed)
        if (!targets.has(item)) {
          resize.unobserve(item);
          observed.delete(item);
        }
      for (const item of targets)
        if (!observed.has(item)) {
          resize.observe(item);
          observed.add(item);
        }
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    const resize = new ResizeObserver(schedule);
    const mutations = new MutationObserver((records) => {
      if (
        records.some(
          (record) =>
            record.type === 'attributes' ||
            [...record.addedNodes, ...record.removedNodes].some(
              (node) =>
                node instanceof Element &&
                (node.matches('.thread, [aria-modal="true"], .approval-card') ||
                  node.querySelector('.thread, [aria-modal="true"], .approval-card')),
            ),
        )
      )
        schedule();
    });
    mutations.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['inert', 'aria-modal'],
    });
    window.addEventListener('resize', schedule);
    document.addEventListener('scroll', schedule, true);
    measure();
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      mutations.disconnect();
      window.removeEventListener('resize', schedule);
      document.removeEventListener('scroll', schedule, true);
    };
  }, [active]);
  return placement;
}

export function Toasts() {
  const items = useSyncExternalStore(notices.subscribe, notices.get);
  const placement = usePlacement(items.length > 0);
  const available = Boolean(placement && placement.height >= 48);
  useLayoutEffect(() => {
    for (const item of items) {
      if (available) notices.resume(item.id, 'placement');
      else notices.pause(item.id, 'placement');
    }
  }, [items, available]);
  // Closing the last toast under the pointer unmounts the stack without a mouseleave.
  useEffect(() => {
    if (items.length) return;
    notices.release('pointer');
    notices.release('focus');
  }, [items.length]);
  if (!items.length) return null;
  return (
    <div
      className="toast-stack"
      aria-live="polite"
      onMouseEnter={() => notices.hold('pointer')}
      onMouseLeave={() => notices.release('pointer')}
      onFocusCapture={() => notices.hold('focus')}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) notices.release('focus');
      }}
      style={{
        top: placement?.top,
        right: placement?.right,
        width: placement?.width,
        maxHeight: placement?.height,
        visibility: available ? undefined : 'hidden',
        ...(available ? {} : { display: 'none', height: 0, padding: 0 }),
      }}
    >
      {items.map((item) => (
        <div
          className={'toast ' + item.level}
          role={item.level === 'error' ? 'alert' : 'status'}
          key={item.id}
          data-notice-id={item.id}
          data-entering={item.entering || undefined}
          data-leaving={item.leaving || undefined}
        >
          {item.level === 'error' ? (
            <AlertCircle size={16} />
          ) : item.level === 'warning' ? (
            <TriangleAlert size={16} />
          ) : item.level === 'info' ? (
            <Info size={16} />
          ) : (
            <CheckCircle2 size={16} />
          )}
          <span>{item.text}</span>
          {item.action && (
            <button
              disabled={item.leaving}
              onClick={async () => {
                notices.pause(item.id, 'action');
                try {
                  if ((await item.action!.run()) !== false) notices.dismiss(item.id);
                } catch (error) {
                  notices.notice(readableError(error), { level: 'error' });
                } finally {
                  notices.resume(item.id, 'action');
                }
              }}
            >
              {item.action.label}
            </button>
          )}
          <IconButton title="关闭通知" disabled={item.leaving} onClick={() => notices.dismiss(item.id)}>
            <X size={13} />
          </IconButton>
        </div>
      ))}
    </div>
  );
}
