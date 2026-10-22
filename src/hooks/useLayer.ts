import { useEffect, useRef, type RefObject } from 'react';

type Layer = { element: HTMLElement; kind: 'dialog' | 'menu' | 'panel'; close: () => void; trap: boolean };
const layers: Layer[] = [];
const focusable =
  'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],summary';
export const topLayer = () => layers.at(-1);
export const allowsWorkbenchAction = (action: string) => {
  const layer = topLayer();
  return !layer || layer.kind === 'panel';
};
function onKey(event: KeyboardEvent) {
  const layer = topLayer();
  if (!layer || event.defaultPrevented || event.isComposing) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopImmediatePropagation();
    layer.close();
  } else if (event.key === 'Tab' && layer.trap) {
    const items = [...layer.element.querySelectorAll<HTMLElement>(focusable)].filter(
      (item) => item.getClientRects().length,
    );
    if (!items.length) return;
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (event.shiftKey && index <= 0) {
      event.preventDefault();
      items.at(-1)?.focus();
    } else if (!event.shiftKey && (index < 0 || index === items.length - 1)) {
      event.preventDefault();
      items[0].focus();
    }
  }
}
export function useLayer(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  close: () => void,
  options: { kind?: Layer['kind']; trapFocus?: boolean } = {},
) {
  const latest = useRef(close);
  latest.current = close;
  const kind = options.kind ?? 'dialog',
    trap = options.trapFocus ?? kind === 'dialog';
  useEffect(() => {
    const element = ref.current;
    if (!active || !element) return;
    const old = document.activeElement as HTMLElement;
    const layer: Layer = { element, kind, trap, close: () => latest.current() };
    if (kind === 'panel') layers.unshift(layer);
    else layers.push(layer);
    if (layers.length === 1) document.addEventListener('keydown', onKey);
    const backdrop = element.closest<HTMLElement>('.modal-backdrop');
    const oldZ = backdrop?.style.zIndex;
    if (backdrop) backdrop.style.zIndex = String(1000 + layers.length);
    if (trap && topLayer() === layer)
      (
        element.querySelector<HTMLElement>('[data-autofocus],input:not(:disabled),textarea:not(:disabled)') ??
        element.querySelector<HTMLElement>(focusable)
      )?.focus();
    return () => {
      const wasTop = topLayer() === layer;
      const index = layers.indexOf(layer);
      if (index >= 0) layers.splice(index, 1);
      if (!layers.length) document.removeEventListener('keydown', onKey);
      if (backdrop) backdrop.style.zIndex = oldZ ?? '';
      if (wasTop && old?.isConnected) old.focus();
    };
  }, [ref, active, kind, trap]);
}
