import { useEffect, useRef, useState } from 'react';
import type { AppMenuId } from '../../shared/app-dialogs';
import { topLayer } from '../hooks/useLayer';

const menus: { id: AppMenuId; label: string; key: string }[] = [
  { id: 'file', label: '文件', key: 'f' },
  { id: 'edit', label: '编辑', key: 'e' },
  { id: 'view', label: '视图', key: 'v' },
];

/** Electron draws the window buttons; the renderer only supplies themed chrome. */
export function TitleBar() {
  const bar = useRef<HTMLElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const [active, setActive] = useState<AppMenuId>();
  const [error, setError] = useState('');
  const nonMac = window.desktop.platform !== 'darwin';
  const buttons = () => [...(bar.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
  const restoreFocus = () => {
    previousFocus.current?.focus();
    previousFocus.current = null;
  };
  const open = async (index: number, keyboard = false) => {
    if (topLayer()?.trap) return;
    const button = buttons()[index];
    if (!button) return;
    // Keep the editor focused while the native Edit menu dispatches its role action.
    if (keyboard) previousFocus.current?.focus();
    const rect = button.getBoundingClientRect();
    setActive(menus[index].id);
    setError('');
    try {
      await window.desktop.invoke('showAppMenu', menus[index].id, rect.left, rect.bottom);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setActive(undefined);
      if (keyboard) restoreFocus();
    }
  };
  useEffect(() => {
    if (!nonMac) return;
    let altOnly = false;
    const focusMenu = (index = 0) => {
      if (!bar.current?.contains(document.activeElement))
        previousFocus.current = document.activeElement as HTMLElement;
      buttons()[index]?.focus();
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.isComposing || topLayer()?.trap) return;
      if (event.key === 'Alt') {
        altOnly = !event.ctrlKey && !event.metaKey;
        return;
      }
      altOnly = false;
      if (event.key === 'F10' && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
        event.preventDefault();
        if (event.repeat) return;
        if (bar.current?.contains(document.activeElement)) restoreFocus();
        else focusMenu();
        return;
      }
      const index = menus.findIndex((menu) => menu.key === event.key.toLowerCase());
      if (event.altKey && !event.ctrlKey && !event.metaKey && index >= 0) {
        event.preventDefault();
        if (event.repeat) return;
        focusMenu(index);
        void open(index, true);
        return;
      }
      if (!bar.current?.contains(document.activeElement)) return;
      const selected = buttons().indexOf(document.activeElement as HTMLButtonElement);
      if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        focusMenu(
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? menus.length - 1
              : (selected + (event.key === 'ArrowLeft' ? -1 : 1) + menus.length) % menus.length,
        );
      } else if (['ArrowDown', 'Enter', ' '].includes(event.key)) {
        event.preventDefault();
        void open(Math.max(0, selected), true);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        restoreFocus();
      }
    };
    const keyup = (event: KeyboardEvent) => {
      if (event.key === 'Alt' && altOnly && !topLayer()?.trap) {
        event.preventDefault();
        if (bar.current?.contains(document.activeElement)) restoreFocus();
        else focusMenu();
      }
      altOnly = false;
    };
    window.addEventListener('keydown', keydown);
    window.addEventListener('keyup', keyup);
    return () => {
      window.removeEventListener('keydown', keydown);
      window.removeEventListener('keyup', keyup);
    };
  }, [nonMac]);
  if (!nonMac) return null;
  return (
    <header className="native-titlebar">
      <nav ref={bar} className="native-titlebar-safe" aria-label="应用菜单">
        <span className="native-titlebar-brand" aria-hidden="true">
          π
        </span>
        {menus.map((menu, index) => (
          <button
            key={menu.id}
            aria-haspopup="menu"
            aria-expanded={active === menu.id}
            aria-keyshortcuts={`Alt+${menu.key.toUpperCase()}`}
            title={`${menu.label} (Alt+${menu.key.toUpperCase()})`}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => void open(index)}
          >
            {menu.label}
          </button>
        ))}
        <span className="native-titlebar-title">Pi Desktop</span>
        {error && (
          <span className="native-titlebar-error" role="alert">
            {error}
          </span>
        )}
      </nav>
    </header>
  );
}
