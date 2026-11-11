import { useLayoutEffect, useRef, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { ExternalLink, FolderOpen } from 'lucide-react';
import { useLayer } from '../hooks/useLayer';
import { notices } from '../lib/notice-store';
import { readableError } from '../lib/format';
const api = window.desktop;

export type FileMenuTarget = { path: string; x: number; y: number };

/** Where a right click, or the keyboard context-menu key, should place the file menu. */
export function fileMenuTarget(event: MouseEvent<HTMLElement>, path: string): FileMenuTarget {
  event.preventDefault();
  if (event.clientX || event.clientY) return { path, x: event.clientX, y: event.clientY };
  const row = event.currentTarget.getBoundingClientRect();
  return { path, x: row.left + 24, y: row.bottom };
}

/** Right-click actions for a project file or folder, kept inside the window. */
export function FileContextMenu({
  projectId,
  target,
  close,
}: {
  projectId: string;
  target: FileMenuTarget;
  close: () => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const latest = useRef(close);
  latest.current = close;
  useLayer(menu, true, close, { kind: 'menu', trapFocus: true });
  useLayoutEffect(() => {
    const node = menu.current!;
    const { clientWidth, clientHeight } = document.documentElement;
    node.style.left = `${Math.max(8, Math.min(target.x, clientWidth - node.offsetWidth - 8))}px`;
    node.style.top = `${Math.max(8, Math.min(target.y, clientHeight - node.offsetHeight - 8))}px`;
    const dismiss = () => latest.current();
    const outside = (event: PointerEvent) => {
      if (!node.contains(event.target as Node)) dismiss();
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('scroll', dismiss, true);
    window.addEventListener('resize', dismiss);
    window.addEventListener('blur', dismiss);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('blur', dismiss);
    };
  }, [target]);
  const run = (action: 'open' | 'reveal') => {
    close();
    void api
      .invoke('openProjectPath', projectId, target.path, action)
      .then((result) => {
        if (action === 'open' && result === 'revealed')
          notices.notice(
            '为避免直接运行程序，已在文件夹中显示该文件。可在设置中指定代码编辑器来打开此类文件。',
          );
      })
      .catch((error) => notices.notice(readableError(error), { level: 'error' }));
  };
  // A portal keeps the fixed menu clear of the inspector's clipping and stacking.
  return createPortal(
    <div
      ref={menu}
      className="context-menu file-context-menu"
      role="menu"
      aria-label={target.path}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
        event.preventDefault();
        const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]')];
        const index = items.indexOf(document.activeElement as HTMLElement);
        items[(index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
      }}
    >
      <button role="menuitem" onClick={() => run('open')}>
        <ExternalLink size={14} />
        用默认程序打开
      </button>
      <button role="menuitem" onClick={() => run('reveal')}>
        <FolderOpen size={14} />
        在文件夹中显示
      </button>
    </div>,
    document.body,
  );
}
