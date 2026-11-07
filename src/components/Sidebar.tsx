import {
  Plus,
  FolderOpen,
  ChevronDown,
  Settings2,
  Search,
  LoaderCircle,
  Download,
  MoreHorizontal,
  Pencil,
  Trash2,
  Import,
  Pin,
  PinOff,
} from 'lucide-react';
import { busy, type Session } from '../../shared/types';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { isOlderSession } from '../../shared/usage';
import { teamMemberActive } from '../../shared/team';
import '../styles/management.css';
import { platform, shortcut } from '../lib/platform';
import { IconButton } from './IconButton';
import { useLayer } from '../hooks/useLayer';
import { useSessionDrag } from '../hooks/useSessionDrag';
import { MoveSessionDialog } from './MoveSessionDialog';
const api = window.desktop;
import type { Workbench } from '../hooks/useWorkbench';
import type { ReactNode } from 'react';
import type { AppState } from '../../shared/types';

export function Sidebar(
  props: Pick<
    Workbench,
    | 'state'
    | 'storage'
    | 'activities'
    | 'environment'
    | 'setNotice'
    | 'sidebar'
    | 'compact'
    | 'inspector'
    | 'setSearchOpen'
    | 'setRename'
    | 'menuId'
    | 'setMenuId'
    | 'selected'
    | 'project'
    | 'attempt'
    | 'addProject'
    | 'selectSession'
    | 'createSession'
    | 'openSettings'
  > & { state: AppState; updateBadge: ReactNode },
) {
  const {
    state,
    activities,
    environment,
    setNotice,
    sidebar,
    compact,
    inspector,
    setSearchOpen,
    setRename,
    menuId,
    setMenuId,
    selected,
    project,
    attempt,
    addProject,
    selectSession,
    createSession,
    openSettings,
  } = props;
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('pi-desktop-expanded-projects') ?? 'null');
      if (Array.isArray(saved)) return new Set(saved.filter((id): id is string => typeof id === 'string'));
    } catch {
      /* An unavailable browser preference does not prevent navigation. */
    }
    return new Set(project ? [project.id] : []);
  });
  // Explicit choices win; without one a group opens while it needs attention.
  const [teamOpen, setTeamOpen] = useState<Map<string, boolean>>(new Map());
  const [moving, setMoving] = useState<Set<string>>(new Set());
  const [moveId, setMoveId] = useState<string>();
  const [moveStatuses, setMoveStatuses] = useState<Record<string, string>>({});
  const preflight = async (id: string) => {
    try {
      const status = await api.invoke('sessionMoveStatus', id);
      setMoveStatuses((current) =>
        current[id] === status.reason ? current : { ...current, [id]: status.reason },
      );
      return status.reason;
    } catch {
      return '无法检查会话状态，请稍后重试';
    }
  };
  useEffect(() => {
    if (!menuId || !state.sessions.some((session) => session.id === menuId)) return;
    void preflight(menuId);
    const timer = setInterval(() => void preflight(menuId), 1000);
    return () => clearInterval(timer);
  }, [menuId, state.sessions, activities]);
  const moveSession = async (id: string, target: string | null, token?: string) => {
    setMoving((current) => new Set([...current, id]));
    try {
      const result = await api.invoke('moveSession', id, target, token);
      if (!result) return;
      if (target) setExpandedProjects((current) => new Set([...current, target]));
      setOlderOpen((current) => new Set([...current, target ?? 'standalone']));
      setNotice(
        result.warning ??
          (target ? '已移到 ' + state.projects.find((p) => p.id === target)?.name : '已移到对话'),
      );
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          const row = document.querySelector<HTMLElement>(`[data-session-id="${CSS.escape(id)}"]`);
          row?.scrollIntoView({ block: 'nearest' });
          row?.classList.add('session-moved');
          setTimeout(() => row?.classList.remove('session-moved'), 1200);
        }),
      );
    } finally {
      setMoving((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }
  };
  const moveReason = (id: string) => {
    const session = state.sessions.find((s) => s.id === id);
    if (session?.team || state.sessions.some((s) => s.team?.leadId === id)) return '团队会话暂不支持移动';
    if (moving.has(id)) return '会话正在移动，请稍候';
    if (!props.storage.writable) return '本地数据只读，暂时不能移动';
    if (activities[id]?.pending) return '有待处理的确认，处理后才能移动';
    if (session && busy(activities[id]?.status ?? session.lastStatus)) return '任务进行中，结束后才能移动';
    return moveStatuses[id] ?? '';
  };
  const drag = useSessionDrag({
    preflight,
    reason: moveReason,
    exists: (id) => state.sessions.some((s) => s.id === id),
    expand: (id) => setExpandedProjects((current) => (current.has(id) ? current : new Set([...current, id]))),
    move: (id, target) => void attempt(() => moveSession(id, target)),
    closeMenu: () => setMenuId(''),
  });
  const [olderOpen, setOlderOpen] = useState<Set<string>>(new Set());
  const menuRef = useRef<HTMLDivElement>(null);
  useLayer(menuRef, Boolean(menuId), () => setMenuId(''), { kind: 'menu' });
  const previousProject = useRef(project?.id);
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    // Fixed positioning keeps the menu outside the project list's overflow clipping.
    const anchor = menu.parentElement!.getBoundingClientRect();
    const { clientWidth, clientHeight } = document.documentElement;
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    const below = anchor.bottom + 4;
    const top = below + height <= clientHeight - 8 ? below : anchor.top - height - 4;
    menu.style.left = `${Math.max(8, Math.min(anchor.right - width, clientWidth - width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(top, clientHeight - height - 8))}px`;

    const close = () => setMenuId('');
    const list = menu.closest('.project-list')!;
    const { scrollTop, scrollLeft } = list;
    const closeOnScroll = () => {
      // Revealing the trigger can leave a scroll event queued before the menu opens.
      if (list.scrollTop !== scrollTop || list.scrollLeft !== scrollLeft) close();
    };
    list.addEventListener('scroll', closeOnScroll);
    window.addEventListener('resize', close);
    return () => {
      list.removeEventListener('scroll', closeOnScroll);
      window.removeEventListener('resize', close);
    };
  }, [menuId, setMenuId]);
  useEffect(() => {
    try {
      localStorage.setItem('pi-desktop-expanded-projects', JSON.stringify([...expandedProjects]));
    } catch {
      /* Browser preference only. */
    }
  }, [expandedProjects]);
  useEffect(() => {
    if (project?.id && project.id !== previousProject.current)
      setExpandedProjects((current) => new Set([...current, project.id]));
    previousProject.current = project?.id;
    if (selected && isOlderSession(selected))
      setOlderOpen((current) => new Set([...current, selected.projectId ?? 'standalone']));
  }, [project?.id, selected?.id]);
  const toggleProject = (id: string) =>
    setExpandedProjects((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const projectStatus = (projectId: string) => {
    const sessions = state.sessions.filter((session) => session.projectId === projectId);
    const pending = sessions.reduce((total, session) => total + (activities[session.id]?.pending ?? 0), 0);
    if (sessions.some((session) => session.unread && ['error', 'interrupted'].includes(session.lastStatus)))
      return (
        <>
          <i className="unread error" aria-label="出错，未查看" />
          {pending > 0 && (
            <em className="project-waiting" aria-label={`待确认 ${pending} 项`}>
              待确认 {pending}
            </em>
          )}
        </>
      );
    if (pending)
      return (
        <em className="project-waiting" aria-label={`待确认 ${pending} 项`}>
          待确认 {pending}
        </em>
      );
    if (sessions.some((session) => busy(activities[session.id]?.status ?? session.lastStatus)))
      return <LoaderCircle size={13} className="spin project-running" aria-label="正在运行" />;
    const unread = sessions
      .filter((session) => session.unread)
      .sort(
        (a, b) =>
          Number(['error', 'interrupted'].includes(b.lastStatus)) -
          Number(['error', 'interrupted'].includes(a.lastStatus)),
      )[0];
    if (unread)
      return (
        <i
          className={'unread ' + unread.lastStatus}
          aria-label={
            ['error', 'interrupted'].includes(unread.lastStatus)
              ? '出错，未查看'
              : unread.lastStatus === 'stopped'
                ? '已停止，未查看'
                : '已完成，未查看'
          }
        />
      );
    return null;
  };
  const pendingFor = (s: Session) =>
    (activities[s.id]?.pending ?? 0) +
    state.sessions
      .filter((member) => member.team?.leadId === s.id)
      .reduce((sum, member) => sum + (activities[member.id]?.pending ?? 0), 0);
  const renderSession = (s: Session) => (
    <div
      className={
        'session-row ' + (s.id === selected?.id ? 'active' : '') + (menuId === s.id ? ' menu-open' : '')
      }
      key={s.id}
      data-session-id={s.id}
      onContextMenu={(e) => {
        e.preventDefault();
        if (moving.has(s.id)) return;
        setMenuId(s.id);
      }}
    >
      <button
        title={s.title}
        aria-current={s.id === selected?.id ? 'page' : undefined}
        onPointerDown={(event) => drag.start(event, s.id, s.projectId ?? null, s.title, s.pinned)}
        onClick={() => {
          if (!drag.suppressClick()) void selectSession(s);
        }}
      >
        {moving.has(s.id) && <LoaderCircle size={12} className="spin" aria-label="正在移动" />}
        {s.pinned && <Pin size={14} className="pin-icon" />}
        <span>{s.title}</span>
        {s.unread && (
          <i
            className={'unread ' + s.lastStatus}
            aria-label={
              ['error', 'interrupted'].includes(s.lastStatus)
                ? '出错，未查看'
                : s.lastStatus === 'stopped'
                  ? '已停止，未查看'
                  : '已完成，未查看'
            }
          />
        )}
        {!!pendingFor(s) && (
          <span className="project-waiting" aria-label={`待确认 ${pendingFor(s)} 项`}>
            待确认
          </span>
        )}
        {!pendingFor(s) && busy(activities[s.id]?.status ?? s.lastStatus) && (
          <LoaderCircle size={12} className="spin" />
        )}
      </button>
      <IconButton
        disabled={moving.has(s.id)}
        title={`${s.title} 会话操作`}
        expanded={menuId === s.id}
        onClick={() => setMenuId(menuId === s.id ? '' : s.id)}
      >
        <MoreHorizontal size={14} />
      </IconButton>
      {menuId === s.id && (
        <div ref={menuRef} className="context-menu" role="menu">
          <button
            role="menuitem"
            onClick={() => {
              setMenuId('');
              void attempt(() => api.invoke('pinSession', s.id, !s.pinned));
            }}
          >
            {s.pinned ? <PinOff size={14} /> : <Pin size={14} />}
            {s.pinned ? '取消置顶' : '置顶'}
          </button>
          <button
            role="menuitem"
            onClick={() => {
              setMenuId('');
              setRename({ kind: 'session', id: s.id, name: s.title });
            }}
          >
            <Pencil size={14} />
            重命名
          </button>
          <button
            role="menuitem"
            disabled={!!moveReason(s.id)}
            title={moveReason(s.id) || undefined}
            onClick={() => {
              setMenuId('');
              setMoveId(s.id);
            }}
          >
            <FolderOpen size={14} />
            移动到…
          </button>
          {s.file && (
            <button
              role="menuitem"
              onClick={() => {
                setMenuId('');
                void attempt(async () => {
                  const file = await api.invoke('exportSession', s.id, 'html');
                  if (file) setNotice('已导出到 ' + file);
                });
              }}
            >
              <Download size={14} />
              导出 HTML
            </button>
          )}
          <button
            role="menuitem"
            className="danger"
            onClick={() => {
              setMenuId('');
              void attempt(async () => {
                const removed = await api.invoke('deleteSession', s.id);
                if (removed)
                  setNotice(
                    removed.trashed
                      ? `会话已移到${platform.trash}`
                      : s.file
                        ? '会话记录已删除（会话文件已不存在）'
                        : '已删除这个还没有内容的会话',
                  );
              });
            }}
          >
            <Trash2 size={14} />
            删除
          </button>
        </div>
      )}
    </div>
  );
  const bySidebarOrder = (a: Session, b: Session) =>
    Number(!!b.pinned) - Number(!!a.pinned) || b.updatedAt - a.updatedAt;
  const renderSessionList = (projectId?: string) => {
    const sessions = state.sessions
      .filter(
        (session) =>
          session.projectId === projectId &&
          (!session.team || !state.sessions.some((s) => s.id === session.team!.leadId)),
      )
      .sort(bySidebarOrder);
    const renderGroup = (session: Session) => {
      // New sessions are inserted first; reverse to list members in dispatch order.
      const members = state.sessions.filter((s) => s.team?.leadId === session.id).reverse();
      const active = members.filter((s) => busy(activities[s.id]?.status ?? s.lastStatus)).length;
      // Saved failures stay in the index after the dispatch, so they only open
      // the group while one of its members is still running.
      const dispatching = members.some((s) => teamMemberActive(s.team!.status));
      const open =
        teamOpen.get(session.id) ??
        members.some(
          (s) =>
            activities[s.id]?.pending ||
            (dispatching && ['failed', 'waiting'].includes(s.team!.status)) ||
            s.id === selected?.id,
        );
      return (
        <div key={session.id}>
          {renderSession(session)}
          {members.length > 0 && (
            <>
              <button
                className="team-sidebar-toggle"
                aria-expanded={open}
                onClick={() => setTeamOpen((before) => new Map(before).set(session.id, !open))}
              >
                <ChevronDown size={12} />
                {active ? `成员 · ${active}/${members.length} 运行中` : `${members.length} 个成员`}
              </button>
              {open && <div className="team-sidebar-members">{members.map(renderSession)}</div>}
            </>
          )}
        </div>
      );
    };
    const now = Date.now();
    const old = sessions.filter((session) => isOlderSession(session, now));
    const key = projectId ?? 'standalone';
    return (
      <>
        {sessions.filter((session) => !isOlderSession(session, now)).map(renderGroup)}
        {old.length > 0 && (
          <div className="older-sessions">
            <button
              className="older-sessions-toggle"
              aria-expanded={olderOpen.has(key)}
              onClick={() =>
                setOlderOpen((current) => {
                  const next = new Set(current);
                  if (next.has(key)) next.delete(key);
                  else next.add(key);
                  return next;
                })
              }
            >
              <ChevronDown size={13} />
              更早的会话 ({old.length})
            </button>
            {olderOpen.has(key) && old.map(renderGroup)}
          </div>
        )}
      </>
    );
  };
  return (
    <aside
      className="sidebar"
      id="project-sidebar"
      aria-label="项目与会话"
      hidden={!sidebar}
      inert={inspector && compact}
    >
      <div className="brand">
        <span className="brand-mark">π</span>
        <div>Pi Desktop</div>
        <IconButton title={`搜索项目与会话 ${shortcut('K')}`} onClick={() => setSearchOpen(true)}>
          <Search size={17} />
        </IconButton>
      </div>
      <button className="new-session" onClick={() => void createSession()}>
        <Plus size={17} />
        新建会话<kbd>{shortcut('N')}</kbd>
      </button>
      <div className="project-list">
        <div data-drop-target="standalone" className="standalone-group">
          <div className="section-heading">
            对话<span className="session-drop-label">移到这里</span>
          </div>
          <div className="session-list standalone-sessions" aria-label="独立对话">
            {renderSessionList()}
            {!state.sessions.some((s) => !s.projectId) && (
              <p className="sidebar-empty">随时开始，无需打开项目。</p>
            )}
          </div>
        </div>
        <div className="section-heading">
          项目
          <IconButton title="添加项目" onClick={addProject}>
            <Plus size={15} />
          </IconButton>
        </div>
        {state.projects.map((p) => (
          <div
            data-drop-target={p.id}
            className={'project-group ' + (p.id === project?.id ? 'selected' : '')}
            key={p.id}
          >
            <div className="project-header">
              <button
                className="project-row"
                aria-expanded={expandedProjects.has(p.id)}
                onClick={() => toggleProject(p.id)}
              >
                <FolderOpen size={16} />
                <span title={p.path}>{p.name}</span>
                <span className="session-drop-label">移到这里</span>
                {!expandedProjects.has(p.id) && projectStatus(p.id)}
                <ChevronDown size={13} className="project-chevron" />
              </button>
              <div className="project-actions">
                <IconButton title={`在 ${p.name} 中新建会话`} onClick={() => void createSession(p.id)}>
                  <Plus size={15} />
                </IconButton>
                <IconButton
                  title={`${p.name} 项目操作`}
                  expanded={menuId === p.id}
                  onClick={() => setMenuId(menuId === p.id ? '' : p.id)}
                >
                  <MoreHorizontal size={15} />
                </IconButton>
              </div>
              {menuId === p.id && (
                <div ref={menuRef} className="context-menu">
                  <button
                    onClick={() => {
                      setRename({ kind: 'project', id: p.id, name: p.name });
                      setMenuId('');
                    }}
                  >
                    <Pencil size={14} />
                    重命名
                  </button>
                  <button
                    onClick={() => {
                      void attempt(() => api.invoke('importSession', p.id));
                      setMenuId('');
                    }}
                  >
                    <Import size={14} />
                    导入 Pi 会话
                  </button>
                  <button
                    className="danger"
                    onClick={() => {
                      void attempt(() => api.invoke('removeProject', p.id));
                      setMenuId('');
                    }}
                  >
                    <Trash2 size={14} />
                    移除项目入口
                  </button>
                </div>
              )}
            </div>
            {expandedProjects.has(p.id) && (
              <div className="session-list" aria-label={`${p.name} 的会话`}>
                {renderSessionList(p.id)}
                {!state.sessions.some((session) => session.projectId === p.id) && (
                  <button className="sidebar-project-empty" onClick={() => void createSession(p.id)}>
                    <Plus size={14} />
                    新建项目会话
                  </button>
                )}
              </div>
            )}
          </div>
        ))}
        {!state.projects.length && <p className="sidebar-empty">需要处理本地文件时，打开项目。</p>}
      </div>
      {moveId && state.sessions.find((s) => s.id === moveId) && (
        <MoveSessionDialog
          session={state.sessions.find((s) => s.id === moveId)!}
          projects={state.projects}
          close={() => setMoveId(undefined)}
          move={(target, token) => moveSession(moveId, target, token)}
        />
      )}
      <div className="sidebar-footer">
        {state.sessions.some((session) => busy(session.lastStatus)) && (
          <button onClick={() => void attempt(() => api.invoke('stopAll'))}>停止所有会话</button>
        )}
        <button onClick={() => openSettings()}>
          <Settings2 size={16} />
          设置
          <span className={'connection-dot ' + (environment?.supported ? 'ready' : '')} />
        </button>
        <div className="sidebar-version">
          Pi Desktop <span>v{__APP_VERSION__}</span>
        </div>
        {props.updateBadge}
      </div>
    </aside>
  );
}
