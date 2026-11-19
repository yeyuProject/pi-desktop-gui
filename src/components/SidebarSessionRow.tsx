import { LoaderCircle, MoreHorizontal, Pin } from 'lucide-react';
import type { PointerEvent, ReactNode } from 'react';
import type { Session } from '../../shared/types';
import { IconButton } from './IconButton';

export function SidebarSessionRow({
  session,
  active,
  moving,
  menuOpen,
  projectName,
  pending,
  running,
  openMenu,
  toggleMenu,
  select,
  startDrag,
  children,
}: {
  session: Session;
  active: boolean;
  moving: boolean;
  menuOpen: boolean;
  projectName?: string;
  pending: number;
  running: boolean;
  openMenu: () => void;
  toggleMenu: () => void;
  select: () => void;
  startDrag: (event: PointerEvent<HTMLElement>) => void;
  children?: ReactNode;
}) {
  return (
    <div
      className={'session-row ' + (active ? 'active' : '') + (menuOpen ? ' menu-open' : '')}
      data-session-id={session.id}
      onContextMenu={(event) => {
        event.preventDefault();
        if (!moving) openMenu();
      }}
    >
      <button
        title={projectName ? `${session.title} · ${projectName}` : session.title}
        aria-current={active ? 'page' : undefined}
        onPointerDown={startDrag}
        onClick={select}
      >
        {moving && <LoaderCircle size={12} className="spin" aria-label="正在移动" />}
        {session.pinned && <Pin size={14} className="pin-icon" />}
        <span>{session.title}</span>
        {projectName && <span className="sidebar-session-project">{projectName}</span>}
        {session.unread && (
          <i
            className={'unread ' + session.lastStatus}
            aria-label={
              ['error', 'interrupted'].includes(session.lastStatus)
                ? '出错，未查看'
                : session.lastStatus === 'stopped'
                  ? '已停止，未查看'
                  : '已完成，未查看'
            }
          />
        )}
        {!!pending && (
          <span className="project-waiting" aria-label={`待确认 ${pending} 项`}>
            待确认
          </span>
        )}
        {!pending && running && <LoaderCircle size={12} className="spin" />}
      </button>
      <IconButton
        disabled={moving}
        title={`${session.title} 会话操作`}
        expanded={menuOpen}
        onClick={toggleMenu}
      >
        <MoreHorizontal size={14} />
      </IconButton>
      {children}
    </div>
  );
}
