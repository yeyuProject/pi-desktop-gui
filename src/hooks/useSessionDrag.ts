import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';

type DropAction =
  | { kind: 'section'; sectionId: string | null }
  | { kind: 'project'; projectId: string | null; sectionId?: string };
type DropDecision = DropAction | { reason: string } | undefined;

export function useSessionDrag(options: {
  decide: (id: string, target: string) => DropDecision;
  preflight: (id: string) => Promise<string>;
  exists: (id: string) => boolean;
  expand: (id: string) => void;
  drop: (id: string, action: DropAction) => void;
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
    start: (event: ReactPointerEvent<HTMLElement>, id: string, title: string, pinned?: boolean) => {
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
      let ended = false;
      let projectCheck:
        { key: string; pending?: Promise<string>; reason?: string; checkedAt: number } | undefined;
      const dropAt = (x: number, y: number) => {
        const hit = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-drop-target]');
        return hit && list.contains(hit) ? hit : undefined;
      };
      const refresh = (key: string) => {
        if (projectCheck?.key !== key) projectCheck = { key, checkedAt: 0 };
        const check = projectCheck;
        if (check.pending || (check.reason !== undefined && performance.now() - check.checkedAt < 500))
          return check;
        check.pending = latest.current.preflight(id).then((result) => {
          check.reason = result;
          check.checkedAt = performance.now();
          check.pending = undefined;
          return result;
        });
        return check;
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
        if (!latest.current.exists(id)) finish();
      };
      /**
       * 1. 找到指针下的分区或项目。
       * 2. 只有跨项目移动才检查 Pi 会话状态。
       * 3. 根据检查结果更新提示和高亮。
       */
      const tick = () => {
        if (!ghost) return;
        // 1. 先滚动，再取指针下的目标，避免沿用上一帧的行。
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
        const hit = dropAt(x, y);
        const key = hit?.dataset.dropTarget;
        const decision = key ? latest.current.decide(id, key) : undefined;
        // 2. 目标换成分区后，尚未返回的项目检查不能影响它。
        const check =
          key && decision && 'kind' in decision && decision.kind === 'project' ? refresh(key) : undefined;
        if (!check) projectCheck = undefined;
        const reason = decision && 'reason' in decision ? decision.reason : check?.reason;
        // 3. 项目通过预检前不高亮，分区可以立刻高亮。
        const next = hit && decision && 'kind' in decision && (!check || check.reason === '') ? hit : null;
        const previousNote = ghost.querySelector('small');
        if (reason && previousNote?.textContent !== reason) {
          const note = previousNote ?? document.createElement('small');
          note.textContent = reason;
          if (!previousNote) ghost.append(note);
        }
        if (!reason) previousNote?.remove();
        row.style.cursor = reason ? 'not-allowed' : '';
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
          document.body.append(ghost);
          frame = requestAnimationFrame(tick);
        }
      };
      const up = (e: PointerEvent) => {
        if (e.pointerId !== pointerId) return;
        const key = active ? dropAt(e.clientX, e.clientY)?.dataset.dropTarget : undefined;
        const decision = key ? latest.current.decide(id, key) : undefined;
        finish();
        if (!key || !decision || 'reason' in decision) return;
        if (decision.kind === 'section') {
          latest.current.drop(id, decision);
          return;
        }
        const check = refresh(key);
        void Promise.resolve(check.pending ?? check.reason).then((reason) => {
          const current = latest.current.decide(id, key);
          if (
            reason === '' &&
            current &&
            'kind' in current &&
            current.kind === 'project' &&
            current.sectionId === decision.sectionId
          )
            latest.current.drop(id, current);
        });
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
    },
  };
}
