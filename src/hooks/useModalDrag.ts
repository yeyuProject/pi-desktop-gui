import { useEffect, type RefObject } from 'react';

const interactive = 'button,a,input,select,textarea,[role="button"],[data-no-drag]';

/** Keep drag frames outside React so editing and focus remain undisturbed. */
export function useModalDrag(ref: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const modal = ref.current;
    const header = modal?.querySelector('header');
    if (!modal || !header) return;
    let x = 0,
      y = 0,
      frame = 0;
    let drag:
      { id: number; x: number; y: number; originX: number; originY: number; active: boolean } | undefined;
    let selection = '';
    const constrain = () => {
      const width = modal.offsetWidth;
      const height = modal.offsetHeight;
      const vw = document.documentElement.clientWidth;
      const vh = document.documentElement.clientHeight;
      const titlebar =
        parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--titlebar-height')) || 0;
      const top =
        Math.max(titlebar, document.querySelector('.native-titlebar')?.getBoundingClientRect().bottom ?? 0) +
        8;
      const left = (vw - width) / 2;
      const baseTop = (vh - height) / 2;
      x = width > vw ? 0 : Math.max(160 - width - left, Math.min(x, vw - 160 - left));
      y = height > vh - top ? 0 : Math.max(top - baseTop, Math.min(y, vh - header.offsetHeight - baseTop));
      modal.style.setProperty('--modal-x', `${x}px`);
      modal.style.setProperty('--modal-y', `${y}px`);
    };
    const schedule = () => {
      if (!frame)
        frame = requestAnimationFrame(() => {
          frame = 0;
          constrain();
        });
    };
    const stop = () => {
      if (!drag) return;
      const current = drag;
      drag = undefined;
      if (current.active) document.body.style.userSelect = selection;
      modal.classList.remove('modal-dragging');
      if (header.hasPointerCapture(current.id)) header.releasePointerCapture(current.id);
    };
    const down = (event: PointerEvent) => {
      if (!event.isPrimary || event.button !== 0 || (event.target as Element).closest(interactive)) return;
      event.preventDefault();
      modal.classList.remove('modal-resetting');
      drag = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        originX: x,
        originY: y,
        active: false,
      };
    };
    const move = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.id) return;
      if (!drag.active) {
        if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) <= 3) return;
        drag.active = true;
        selection = document.body.style.userSelect;
        document.body.style.userSelect = 'none';
        header.setPointerCapture(event.pointerId);
        modal.classList.add('modal-dragging');
      }
      x = drag.originX + event.clientX - drag.x;
      y = drag.originY + event.clientY - drag.y;
      schedule();
    };
    const reset = (event: MouseEvent) => {
      if ((event.target as Element).closest(interactive)) return;
      stop();
      x = y = 0;
      modal.classList.add('modal-resetting');
      modal.style.setProperty('--modal-x', '0px');
      modal.style.setProperty('--modal-y', '0px');
    };
    const leave = () => {
      if (!drag?.active) stop();
    };
    header.addEventListener('pointerdown', down);
    header.addEventListener('pointermove', move);
    header.addEventListener('pointerup', stop);
    header.addEventListener('pointercancel', stop);
    header.addEventListener('lostpointercapture', stop);
    header.addEventListener('pointerleave', leave);
    header.addEventListener('dblclick', reset);
    window.addEventListener('blur', stop);
    window.addEventListener('resize', schedule);
    const observer = new ResizeObserver(() => {
      if (x || y) schedule();
    });
    observer.observe(modal);
    observer.observe(header);
    return () => {
      stop();
      cancelAnimationFrame(frame);
      observer.disconnect();
      header.removeEventListener('pointerdown', down);
      header.removeEventListener('pointermove', move);
      header.removeEventListener('pointerup', stop);
      header.removeEventListener('pointercancel', stop);
      header.removeEventListener('lostpointercapture', stop);
      header.removeEventListener('pointerleave', leave);
      header.removeEventListener('dblclick', reset);
      window.removeEventListener('blur', stop);
      window.removeEventListener('resize', schedule);
    };
  }, [ref]);
}
