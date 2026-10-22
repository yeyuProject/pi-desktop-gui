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
import '../styles/management.css';
import { platform, shortcut } from '../lib/platform';
import { IconButton } from './IconButton';
const api = window.desktop;
import type { Workbench } from '../hooks/useWorkbench';
import type { ReactNode } from 'react';
import type { AppState } from '../../shared/types';

export function Sidebar(
  props: Pick<
    Workbench,
    | 'state'
    | 'runtime'
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
    | 'running'
    | 'attempt'
    | 'addProject'
    | 'selectSession'
    | 'createSession'
    | 'openSettings'
  > & { state: AppState; updateBadge: ReactNode },
) {
  const {
    state,
    runtime,
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
    running,
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
  const [olderOpen, setOlderOpen] = useState<Set<string>>(new Set());
  const menuRef = useRef<HTMLDivElement>(null);
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
    const active = sessions.some((session) => session.id === runtime.sessionId);
    if (active && runtime.dialogs.length)
      return (
        <em className="project-waiting" aria-label={`待确认 ${runtime.dialogs.length} 项`}>
          待确认 {runtime.dialogs.length}
        </em>
      );
    if ((active && running) || sessions.some((session) => busy(session.lastStatus)))
      return <LoaderCircle size={13} className="spin project-running" aria-label="正在运行" />;
    if (sessions.some((session) => session.unread))
      return <i className="unread" aria-label="有未读完成会话" />;
    return null;
  };
  const renderSession = (s: Session) => (
    <div
      className={
        'session-row ' + (s.id === selected?.id ? 'active' : '') + (menuId === s.id ? ' menu-open' : '')
      }
      key={s.id}
      data-session-id={s.id}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenuId(s.id);
      }}
    >
      <button
        title={s.title}
        aria-current={s.id === selected?.id ? 'page' : undefined}
        onClick={() => void selectSession(s)}
      >
        {s.pinned && <Pin size={14} className="pin-icon" />}
        <span>{s.title}</span>
        {s.unread && <i className="unread" />}
        {busy(s.id === runtime.sessionId ? runtime.status : s.lastStatus) && (
          <LoaderCircle size={12} className="spin" />
        )}
      </button>
      <IconButton
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
    const sessions = state.sessions.filter((session) => session.projectId === projectId).sort(bySidebarOrder);
    const now = Date.now();
    const old = sessions.filter((session) => isOlderSession(session, now));
    const key = projectId ?? 'standalone';
    return (
      <>
        {sessions.filter((session) => !isOlderSession(session, now)).map(renderSession)}
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
            {olderOpen.has(key) && old.map(renderSession)}
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
        新建对话<kbd>{shortcut('N')}</kbd>
      </button>
      <div className="project-list">
        <div className="section-heading">对话</div>
        <div className="session-list standalone-sessions" aria-label="独立对话">
          {renderSessionList()}
          {!state.sessions.some((s) => !s.projectId) && (
            <p className="sidebar-empty">随时开始，无需打开项目。</p>
          )}
        </div>
        <div className="section-heading">
          项目
          <IconButton title="添加项目" onClick={addProject}>
            <Plus size={15} />
          </IconButton>
        </div>
        {state.projects.map((p) => (
          <div className={'project-group ' + (p.id === project?.id ? 'selected' : '')} key={p.id}>
            <div className="project-header">
              <button
                className="project-row"
                aria-expanded={expandedProjects.has(p.id)}
                onClick={() => toggleProject(p.id)}
              >
                <FolderOpen size={16} />
                <span title={p.path}>{p.name}</span>
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
