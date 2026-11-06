import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';

export function useSessionDrag(options: {
  reason: (id: string) => string;
  preflight: (id: string) => Promise<string>;
  exists: (id: string) => boolean;
  expand: (id: string) => void;
  move: (id: string, target: string | null) => void;
  closeMenu: () => void;
}) {
  const latest = useRef(options);
  latest.current = options;
  const cancel = useRef<() => void>(() => {});
  const suppressed = useRef(false);
  useEffect(() => () => cancel.current(), []);
  useEffect(() => {
    /* State changes must cancel an active drag before a drop. */
    window.dispatchEvent(new Event('session-drag-state'));
  });
  return {
    suppressClick: () => suppressed.current,
    start: (
      event: ReactPointerEvent<HTMLElement>,
      id: string,
      source: string | null,
      title: string,
      pinned?: boolean,
    ) => {
      if (
        event.button !== 0 ||
        !event.isPrimary ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey
      )
        return;
      cancel.current();
      const row = event.currentTarget;
      const list = row.closest('.project-list') as HTMLElement;
      const pointerId = event.pointerId;
      const startX = event.clientX,
        startY = event.clientY;
      let x = startX,
        y = startY,
        active = false,
        frame = 0;
      let ghost: HTMLDivElement | undefined;
      let target: HTMLElement | null = null;
      let hoverTimer: ReturnType<typeof setTimeout> | undefined;
      let reason = latest.current.reason(id);
      let checked = false;
      let ended = false;
      let checking = false;
      const refresh = async () => {
        if (checking) return;
        checking = true;
        const nextReason = await latest.current.preflight(id);
        checking = false;
        if (ended) return;
        if (checked && nextReason !== reason) {
          finish();
          return;
        }
        reason = nextReason;
        checked = true;
        if (ghost && reason) {
          const note = document.createElement('small');
          note.textContent = reason;
          ghost.querySelector('small')?.remove();
          ghost.append(note);
          row.style.cursor = 'not-allowed';
        }
      };
      const selection = document.body.style.userSelect;
      const clearTarget = () => {
        target?.classList.remove('session-drop-target');
        target = null;
        clearTimeout(hoverTimer);
      };
      const finish = () => {
        if (ended) return;
        ended = true;
        clearInterval(polling);
        cancelAnimationFrame(frame);
        clearTarget();
        ghost?.remove();
        row.classList.remove('session-drag-source');
        row.style.cursor = '';
        if (active) document.body.style.userSelect = selection;
        if (row.hasPointerCapture(pointerId)) row.releasePointerCapture(pointerId);
        row.removeEventListener('pointermove', move);
        row.removeEventListener('pointerup', up);
        row.removeEventListener('pointercancel', finish);
        row.removeEventListener('pointerleave', leave);
        row.removeEventListener('lostpointercapture', finish);
        window.removeEventListener('keydown', key);
        window.removeEventListener('blur', finish);
        window.removeEventListener('session-drag-state', changed);
        setTimeout(() => {
          suppressed.current = false;
        }, 0);
        cancel.current = () => {};
      };
      const changed = () => {
        if (!latest.current.exists(id) || (checked && latest.current.reason(id) !== reason)) finish();
      };
      const tick = () => {
        if (!ghost) return;
        ghost.style.transform = `translate(${x + 12}px, ${y + 8}px)`;
        const bounds = list.getBoundingClientRect();
        if (x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom) {
          const speed =
            y < bounds.top + 32
              ? -12 * (1 - (y - bounds.top) / 32)
              : y > bounds.bottom - 32
                ? 12 * (1 - (bounds.bottom - y) / 32)
                : 0;
          list.scrollTop += speed;
        }
        let next = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-drop-target]') ?? null;
        if (
          !checked ||
          reason ||
          next?.dataset.dropTarget === (source ?? 'standalone') ||
          !list.contains(next)
        )
          next = null;
        if (target !== next) {
          clearTarget();
          target = next;
          target?.classList.add('session-drop-target');
          const targetId = target?.dataset.dropTarget;
          if (targetId && targetId !== 'standalone')
            hoverTimer = setTimeout(() => latest.current.expand(targetId), 600);
        }
        frame = requestAnimationFrame(tick);
      };
      const leave = () => {
        if (!active) finish();
      };
      const move = (e: PointerEvent) => {
        if (e.pointerId !== pointerId) return;
        x = e.clientX;
        y = e.clientY;
        if (!active) {
          if (Math.hypot(x - startX, y - startY) <= 4) return;
          active = true;
          suppressed.current = true;
          latest.current.closeMenu();
          row.setPointerCapture(pointerId);
          row.classList.add('session-drag-source');
          document.body.style.userSelect = 'none';
          ghost = document.createElement('div');
          ghost.className = 'session-drag-ghost';
          const heading = document.createElement('div');
          heading.textContent = (pinned ? '📌 ' : '') + title;
          ghost.append(heading);
          if (reason) {
            const note = document.createElement('small');
            note.textContent = reason;
            ghost.append(note);
            row.style.cursor = 'not-allowed';
          }
          document.body.append(ghost);
          frame = requestAnimationFrame(tick);
        }
      };
      const up = (e: PointerEvent) => {
        if (e.pointerId !== pointerId) return;
        const hit = document
          .elementFromPoint(e.clientX, e.clientY)
          ?.closest<HTMLElement>('[data-drop-target]');
        const targetId = hit && list.contains(hit) ? hit.dataset.dropTarget : undefined;
        const allowed =
          active &&
          checked &&
          !reason &&
          targetId &&
          targetId !== (source ?? 'standalone') &&
          !latest.current.reason(id);
        finish();
        row.style.cursor = '';
        if (allowed) latest.current.move(id, targetId === 'standalone' ? null : targetId!);
      };
      const key = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          finish();
        }
      };
      row.addEventListener('pointermove', move);
      row.addEventListener('pointerup', up);
      row.addEventListener('pointercancel', finish);
      row.addEventListener('pointerleave', leave);
      row.addEventListener('lostpointercapture', finish);
      window.addEventListener('keydown', key);
      window.addEventListener('blur', finish);
      window.addEventListener('session-drag-state', changed);
      cancel.current = finish;
      void refresh();
      const polling = setInterval(() => void refresh(), 500);
    },
  };
}
