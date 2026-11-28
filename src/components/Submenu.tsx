import { ChevronRight } from 'lucide-react';
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import '../styles/sidebar-view-menu.css';

const EDGE = 8;
const GAP = 4;
const HOVER_DELAY = 120;
const LEAVE_DELAY = 180;

function menuItems(menu: HTMLElement) {
  return [...menu.querySelectorAll<HTMLButtonElement>(':scope > button[role^="menuitem"]:not(:disabled)')];
}

export function focusMenuItem(menu: HTMLElement, position: 'first' | 'last' = 'first') {
  menuItems(menu)
    .at(position === 'first' ? 0 : -1)
    ?.focus();
}

export function handleMenuKeyDown(event: KeyboardEvent<HTMLElement>) {
  if (event.defaultPrevented || event.nativeEvent.isComposing) return false;
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return false;
  event.preventDefault();
  event.stopPropagation();
  const items = menuItems(event.currentTarget);
  const index = items.findIndex((item) => item === document.activeElement);
  const offset = event.key === 'ArrowDown' ? 1 : -1;
  const next =
    event.key === 'Home' || (event.key === 'ArrowDown' && index < 0)
      ? 0
      : event.key === 'End' || index < 0
        ? items.length - 1
        : (index + offset + items.length) % items.length;
  items[next]?.focus();
  return true;
}

export function fitMenuToWindow(menu: HTMLElement, left: number, top: number) {
  const { clientWidth, clientHeight } = document.documentElement;
  menu.style.left = `${Math.max(EDGE, Math.min(left, clientWidth - menu.offsetWidth - EDGE))}px`;
  menu.style.top = `${Math.max(EDGE, Math.min(top, clientHeight - menu.offsetHeight - EDGE))}px`;
}

export function useSubmenus() {
  const [activeId, setActiveId] = useState<string>();
  const activeTrigger = useRef<HTMLButtonElement | null>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const contains = (target: Node | null) => Boolean(popupRef.current?.contains(target));

  function reset() {
    activeTrigger.current = null;
    setActiveId(undefined);
  }

  function dismiss() {
    const trigger = activeTrigger.current;
    if (!trigger?.isConnected) return false;
    reset();
    trigger.focus({ preventScroll: true });
    return true;
  }

  function show(trigger: HTMLButtonElement) {
    if (activeTrigger.current !== trigger && contains(document.activeElement)) trigger.focus();
    activeTrigger.current = trigger;
    setActiveId(trigger.id);
  }

  function leave(trigger: HTMLButtonElement) {
    if (activeTrigger.current !== trigger) return;
    if (contains(document.activeElement)) return void dismiss();
    reset();
  }

  return { activeId, popupRef, contains, dismiss, reset, show, leave };
}

/**
 * 1. 用同一套状态处理悬停和键盘，只展开一个子菜单。
 * 2. 把子菜单放到父菜单外，按入口位置摆放。
 * 3. 子菜单自己的方向键只在本层处理，Esc 交给父菜单统一关闭。
 */
export function Submenu({
  submenus,
  label,
  value,
  children,
}: {
  submenus: ReturnType<typeof useSubmenus>;
  label: string;
  value?: string;
  children: ReactNode;
}) {
  const id = useId();
  const popupId = `${id}-menu`;
  const open = submenus.activeId === id;
  const { popupRef } = submenus;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const timer = useRef<number>(undefined);
  const focusOnOpen = useRef(false);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  // 1. 鼠标经过入口时不抢键盘焦点，点击或按键进入时才聚焦首项。
  function enter(trigger: HTMLButtonElement) {
    window.clearTimeout(timer.current);
    if (open) return focusMenuItem(popupRef.current!);
    focusOnOpen.current = true;
    submenus.show(trigger);
  }

  function scheduleLeave() {
    window.clearTimeout(timer.current);
    const trigger = triggerRef.current!;
    // 给指针留出跨过两个菜单间隙的时间。
    timer.current = window.setTimeout(() => submenus.leave(trigger), LEAVE_DELAY);
  }

  // 2. 固定定位避开父菜单的滚动裁剪，右边放不下时往左展开。
  useLayoutEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current!;
    const menu = popupRef.current!;
    const parent = trigger.parentElement!;
    function position() {
      const bounds = parent.getBoundingClientRect();
      const right = bounds.right + GAP;
      const left = bounds.left - GAP - menu.offsetWidth;
      const availableRight = document.documentElement.clientWidth - EDGE - right;
      const availableLeft = bounds.left - GAP - EDGE;
      const useRight = menu.offsetWidth <= availableRight || (left < EDGE && availableRight >= availableLeft);
      fitMenuToWindow(menu, useRight ? right : left, trigger.getBoundingClientRect().top);
    }
    position();
    if (focusOnOpen.current) {
      focusOnOpen.current = false;
      focusMenuItem(menu);
    }
    const observer = new ResizeObserver(position);
    observer.observe(menu);
    parent.addEventListener('scroll', position);
    window.addEventListener('resize', position);
    return () => {
      observer.disconnect();
      parent.removeEventListener('scroll', position);
      window.removeEventListener('resize', position);
    };
  }, [open, popupRef]);

  return (
    <>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        role="menuitem"
        tabIndex={-1}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? popupId : undefined}
        onClick={(event) => enter(event.currentTarget)}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowRight' || event.nativeEvent.isComposing) return;
          event.preventDefault();
          event.stopPropagation();
          enter(event.currentTarget);
        }}
        onPointerEnter={(event) => {
          if (event.pointerType !== 'mouse') return;
          window.clearTimeout(timer.current);
          if (open) return;
          const trigger = event.currentTarget;
          timer.current = window.setTimeout(() => submenus.show(trigger), HOVER_DELAY);
        }}
        onPointerLeave={(event) => {
          if (event.pointerType === 'mouse') scheduleLeave();
        }}
      >
        <span className="sidebar-menu-label">{label}</span>
        {value && <span className="sidebar-menu-value">{value}</span>}
        <ChevronRight size={14} aria-hidden="true" />
      </button>
      {open &&
        createPortal(
          <div
            ref={popupRef}
            id={popupId}
            className="context-menu sidebar-submenu"
            role="menu"
            aria-labelledby={id}
            onPointerEnter={() => window.clearTimeout(timer.current)}
            onPointerLeave={(event) => {
              if (event.pointerType === 'mouse') scheduleLeave();
            }}
            onKeyDown={(event) => {
              // 3. 左键回到入口，上下键留在子菜单。Esc 由父菜单的层处理。
              if (event.key === 'ArrowLeft' && !event.nativeEvent.isComposing) {
                event.preventDefault();
                event.stopPropagation();
                window.clearTimeout(timer.current);
                submenus.dismiss();
                return;
              }
              handleMenuKeyDown(event);
            }}
          >
            {children}
          </div>,
          document.body,
        )}
    </>
  );
}
