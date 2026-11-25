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
  Layers,
  MessagesSquare,
  Check,
} from 'lucide-react';
import { busy, type Session, type SessionMoveOptions, type SidebarSection } from '../../shared/types';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { teamMemberActive } from '../../shared/team';
import '../styles/management.css';
import { platform, shortcut } from '../lib/platform';
import { IconButton } from './IconButton';
import { useLayer } from '../hooks/useLayer';
import { useSessionDrag } from '../hooks/useSessionDrag';
import { MoveSessionDialog } from './MoveSessionDialog';
import { SidebarSessionRow } from './SidebarSessionRow';
import { SidebarViewMenu } from './SidebarViewMenu';
import { SidebarViewGroup } from './SidebarViewGroup';
import { focusMenuItem, handleMenuKeyDown, Submenu, useSubmenus } from './Submenu';
import {
  buildSidebarGroups,
  getSidebarRowActivity,
  type SidebarActiveDeferral,
  type SidebarGroup,
  type SidebarRow,
  type SidebarSectionGroup,
} from '../lib/sidebar-groups';
const api = window.desktop;
import type { Workbench } from '../hooks/useWorkbench';
import type { ReactNode } from 'react';
import type { AppState } from '../../shared/types';

const noSections: SidebarSection[] = [];
const noActivities = {};

function toggleKey(keys: Set<string>, key: string) {
  const next = new Set(keys);
  if (!next.delete(key)) next.add(key);
  return next;
}

export function Sidebar(
  props: Pick<
    Workbench,
    | 'state'
    | 'storage'
    | 'sidebarActivities'
    | 'sidebarView'
    | 'changeSidebarView'
    | 'environment'
    | 'piUpdate'
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
    sidebarActivities: activities,
    sidebarView,
    changeSidebarView,
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
  const piUpdating = props.piUpdate?.status === 'updating';
  const piUpdateUnseen =
    props.piUpdate?.status === 'available' && props.piUpdate.latest !== props.piUpdate.seenVersion;
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('pi-desktop-expanded-projects') ?? 'null');
      if (Array.isArray(saved)) return new Set(saved.filter((id): id is string => typeof id === 'string'));
    } catch {
      /* An unavailable browser preference does not prevent navigation. */
    }
    return new Set(project ? [project.id] : []);
  });
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem('pi-desktop-collapsed-groups') ?? 'null');
      if (Array.isArray(saved)) return new Set(saved.filter((id): id is string => typeof id === 'string'));
    } catch {
      /* 部分浏览器环境不提供本地偏好，侧栏仍可使用。 */
    }
    return new Set();
  });
  const [olderOpen, setOlderOpen] = useState<Set<string>>(new Set());
  const [now, setNow] = useState(() => new Date().setHours(0, 0, 0, 0));
  useLayoutEffect(() => {
    if (sidebarView.groupBy !== 'time') return;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = () => {
      const now = new Date();
      setNow(new Date(now).setHours(0, 0, 0, 0));
      const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      timer = setTimeout(refresh, midnight.getTime() - now.getTime());
    };
    refresh();
    return () => clearTimeout(timer);
  }, [sidebarView.groupBy]);
  const sections = state.sections ?? noSections;
  const sessionsById = useMemo(
    () => new Map(state.sessions.map((session) => [session.id, session])),
    [state.sessions],
  );
  const projectsById = useMemo(() => new Map(state.projects.map((p) => [p.id, p])), [state.projects]);
  const sessionsByProject = useMemo(() => {
    const index = new Map<string | undefined, Session[]>();
    for (const session of state.sessions) {
      const sessions = index.get(session.projectId) ?? [];
      sessions.push(session);
      index.set(session.projectId, sessions);
    }
    return index;
  }, [state.sessions]);
  const groupingActivities = sidebarView.groupBy === 'status' ? activities : noActivities;
  const timeGroupNow = sidebarView.groupBy === 'time' ? now : undefined;
  const naturalGroups = useMemo(
    () =>
      buildSidebarGroups(
        state.sessions,
        groupingActivities,
        sidebarView,
        sections,
        timeGroupNow ?? Date.now(),
      ),
    [state.sessions, groupingActivities, sidebarView, sections, timeGroupNow],
  );
  const previousStatus = useRef<{
    selectedId?: string;
    groups: SidebarGroup[];
    activities: typeof activities;
    deferral?: SidebarActiveDeferral;
  }>(undefined);
  const naturalStatusGroups = sidebarView.groupBy === 'status' ? naturalGroups.groups : undefined;
  /**
   * 1. 选中会话时，记住它清除未读前的位置。
   * 2. 用户停在该会话期间，只要运行和待确认状态没变就保留这个位置。
   * 3. 切走或状态变化后，恢复正常分组。
   */
  const deferral = useMemo(() => {
    const previous = previousStatus.current;
    if (!naturalStatusGroups || !previous || !selected || selected.unread) return;
    // 1. 从上次实际展示的数据找未读位置，搜索选中也经过这里。
    const beforeGroup = previous.groups.find(
      (group) =>
        group.rows.some((row) => row.sessionId === selected.id) ||
        group.olderRows.some((row) => row.sessionId === selected.id),
    );
    const key = previous.selectedId === selected.id ? previous.deferral?.groupKey : beforeGroup?.key;
    if (key !== 'status:pending' && key !== 'status:unread') return;
    const before = beforeGroup?.rows
      .concat(beforeGroup.olderRows)
      .find((row) => row.sessionId === selected.id);
    const after = naturalStatusGroups
      .flatMap((group) => group.rows.concat(group.olderRows))
      .find((row) => row.sessionId === selected.id);
    if (!before || !after || (!before.session.unread && previous.selectedId !== selected.id)) return;
    // 2. 已经有待确认的会话会按实时状态移动，只有清除未读导致的移动才延后。
    const oldActivity = getSidebarRowActivity(before, previous.activities);
    const newActivity = getSidebarRowActivity(after, activities);
    if (
      oldActivity.pending ||
      newActivity.pending ||
      before.session.lastStatus !== after.session.lastStatus ||
      oldActivity.status !== newActivity.status ||
      oldActivity.activeMembers !== newActivity.activeMembers
    )
      return;
    // 3. 没有命中保留条件时，直接使用正常分组。
    return { sessionId: selected.id, groupKey: key };
  }, [naturalStatusGroups, selected, activities]);
  useLayoutEffect(() => {
    previousStatus.current = naturalStatusGroups
      ? { selectedId: selected?.id, groups: naturalStatusGroups, activities, deferral }
      : undefined;
  }, [naturalStatusGroups, selected?.id, activities, deferral]);
  const groups = useMemo(
    () =>
      deferral
        ? buildSidebarGroups(state.sessions, groupingActivities, sidebarView, sections, Date.now(), deferral)
        : naturalGroups,
    [naturalGroups, deferral, state.sessions, groupingActivities, sidebarView, sections],
  );
  const projectMode = sidebarView.groupBy === 'project';
  const placementGroups = useMemo(() => [...groups.sections, ...groups.groups], [groups]);
  const selectedLeadId =
    selected?.team && sessionsById.has(selected.team.leadId) ? selected.team.leadId : selected?.id;
  const selectedGroup = placementGroups.find(
    (group) =>
      group.rows.some((row) => row.sessionId === selectedLeadId) ||
      group.olderRows.some((row) => row.sessionId === selectedLeadId),
  );
  const selectedGroupKey = selectedGroup?.key;
  const selectedProjectId = selectedGroup?.projectId;
  const selectedIsOlder = selectedGroup?.olderRows.some((row) => row.sessionId === selectedLeadId);
  useLayoutEffect(() => {
    if (selectedProjectId)
      setExpandedProjects((current) =>
        current.has(selectedProjectId) ? current : new Set([...current, selectedProjectId]),
      );
    if (selectedGroupKey)
      setCollapsedGroups((current) =>
        current.has(selectedGroupKey) ? toggleKey(current, selectedGroupKey) : current,
      );
    if (selectedGroupKey && selectedIsOlder)
      setOlderOpen((current) =>
        current.has(selectedGroupKey) ? current : new Set([...current, selectedGroupKey]),
      );
  }, [selected?.id, selectedGroupKey, selectedProjectId, selectedIsOlder]);
  // 选中成员时先展开，用户之后仍可手动收起。
  const [teamOpen, setTeamOpen] = useState<Map<string, boolean>>(new Map());
  useLayoutEffect(() => {
    if (!selectedLeadId || selectedLeadId === selected?.id) return;
    setTeamOpen((current) =>
      current.get(selectedLeadId) ? current : new Map(current).set(selectedLeadId, true),
    );
  }, [selected?.id, selectedLeadId]);
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
  const moveSession = async (
    id: string,
    target: string | null,
    token?: string,
    dragOptions?: SessionMoveOptions,
  ) => {
    setMoving((current) => new Set([...current, id]));
    try {
      const result = await api.invoke('moveSession', id, target, token, dragOptions);
      if (!result) return;
      if (target) setExpandedProjects((current) => new Set([...current, target]));
      setOlderOpen((current) => new Set([...current, `project:${target ?? 'standalone'}`]));
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
  const placementReason = (id: string) => {
    if (moving.has(id)) return '会话正在移动，请稍候';
    if (!props.storage.writable) return '本地数据只读，暂时不能移动';
    return '';
  };
  const projectMoveReason = (id: string) => {
    const session = sessionsById.get(id);
    if (session?.team || state.sessions.some((s) => s.team?.leadId === id)) return '团队会话暂不支持移动';
    const blocked = placementReason(id);
    if (blocked) return blocked;
    if (activities[id]?.pending) return '有待处理的确认，处理后才能移动';
    if (session && busy(activities[id]?.status ?? session.lastStatus)) return '任务进行中，结束后才能移动';
    return '';
  };
  const changeSection = async (session: Session, sectionId: string | null) => {
    const section = sections.find((item) => item.id === (sectionId ?? session.sectionId));
    await api.invoke('setSessionSection', session.id, sectionId);
    if (sectionId && !(sidebarView.pinnedGroup && session.pinned)) {
      const key = `section:${sectionId}`;
      setCollapsedGroups((current) => (current.has(key) ? toggleKey(current, key) : current));
    }
    if (section && !sectionId) setNotice(`已移出分区“${section.name}”`);
    if (section && sectionId && sidebarView.pinnedGroup && session.pinned)
      setNotice(`已放进分区“${section.name}”，置顶期间显示在置顶组`);
  };
  const drag = useSessionDrag({
    preflight,
    decide: (id, target) => {
      const session = sessionsById.get(id);
      if (!session) return;
      if (target.startsWith('section:')) {
        const sectionId = target.slice('section:'.length);
        if (session.sectionId === sectionId || !sections.some((section) => section.id === sectionId)) return;
        const reason = session.team ? '团队成员跟随负责人显示' : placementReason(id);
        return reason ? { reason } : { kind: 'section', sectionId };
      }
      const projectId = target === 'standalone' ? null : target;
      if (projectId && !projectsById.has(projectId)) return;
      if (projectId === (session.projectId ?? null)) {
        if (!session.sectionId) return;
        const reason = placementReason(id);
        return reason ? { reason } : { kind: 'section', sectionId: null };
      }
      const reason = projectMoveReason(id);
      return reason ? { reason } : { kind: 'project', projectId, sectionId: session.sectionId };
    },
    exists: (id) => sessionsById.has(id),
    expand: (id) => {
      if (id.startsWith('section:')) {
        setCollapsedGroups((current) =>
          current.has(id) ? new Set([...current].filter((key) => key !== id)) : current,
        );
        return;
      }
      if (sidebarView.groupBy === 'project')
        setExpandedProjects((current) => (current.has(id) ? current : new Set([...current, id])));
    },
    drop: (id, action) => {
      if (action.kind === 'section') {
        const session = sessionsById.get(id)!;
        void attempt(async () => {
          await changeSection(session, action.sectionId);
          if (action.sectionId || !projectMode || (sidebarView.pinnedGroup && session.pinned)) return;
          const projectId = session.projectId;
          if (projectId) setExpandedProjects((current) => new Set([...current, projectId]));
          setOlderOpen((current) => new Set([...current, `project:${projectId ?? 'standalone'}`]));
        });
        return;
      }
      void attempt(() =>
        moveSession(id, action.projectId, undefined, {
          requireConfirmation: sidebarView.groupBy !== 'project' || Boolean(action.sectionId),
          sectionId: action.sectionId,
        }),
      );
    },
    closeMenu: () => setMenuId(''),
  });
  const menuRef = useRef<HTMLDivElement>(null);
  const contextTrigger = useRef<HTMLElement>(null);
  const submenus = useSubmenus();
  useLayer(
    menuRef,
    Boolean(menuId),
    () => {
      if (submenus.dismiss()) return;
      contextTrigger.current?.focus({ preventScroll: true });
      setMenuId('');
    },
    { kind: 'menu' },
  );
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    contextTrigger.current = document.activeElement as HTMLElement;
    // Fixed positioning keeps the menu outside the project list's overflow clipping.
    const anchor = menu.parentElement!.getBoundingClientRect();
    const { clientWidth, clientHeight } = document.documentElement;
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    const below = anchor.bottom + 4;
    const top = below + height <= clientHeight - 8 ? below : anchor.top - height - 4;
    menu.style.left = `${Math.max(8, Math.min(anchor.right - width, clientWidth - width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(top, clientHeight - height - 8))}px`;
    if (sessionsById.has(menuId) || menuId.startsWith('section:')) focusMenuItem(menu);

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
  useEffect(() => submenus.reset(), [menuId]);
  useEffect(() => {
    try {
      localStorage.setItem('pi-desktop-expanded-projects', JSON.stringify([...expandedProjects]));
    } catch {
      /* Browser preference only. */
    }
  }, [expandedProjects]);
  useEffect(() => {
    try {
      localStorage.setItem('pi-desktop-collapsed-groups', JSON.stringify([...collapsedGroups]));
    } catch {
      /* Browser preference only. */
    }
  }, [collapsedGroups]);
  const projectStatus = (projectId: string) => {
    const sessions = sessionsByProject.get(projectId) ?? [];
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
  const renderSession = (s: Session, pending: number, running: boolean, showProject: boolean) => (
    <SidebarSessionRow
      key={s.id}
      session={s}
      active={s.id === selected?.id}
      moving={moving.has(s.id)}
      menuOpen={menuId === s.id}
      pending={pending}
      running={running}
      projectName={showProject && s.projectId ? projectsById.get(s.projectId)?.name : undefined}
      openMenu={() => setMenuId(s.id)}
      toggleMenu={() => setMenuId(menuId === s.id ? '' : s.id)}
      startDrag={(event) => drag.start(event, s.id, s.title, s.pinned)}
      select={() => {
        if (!drag.suppressClick()) void selectSession(s);
      }}
    >
      {menuId === s.id && (
        <div ref={menuRef} className="context-menu" role="menu" onKeyDown={handleMenuKeyDown}>
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
          {!s.team && (
            <>
              <Submenu submenus={submenus} label="放入分区">
                {sections.map((section) => (
                  <button
                    key={section.id}
                    role="menuitemradio"
                    aria-checked={s.sectionId === section.id}
                    tabIndex={-1}
                    onClick={() => {
                      contextTrigger.current?.focus({ preventScroll: true });
                      setMenuId('');
                      if (s.sectionId !== section.id) void attempt(() => changeSection(s, section.id));
                    }}
                  >
                    <span className="sidebar-menu-label">{section.name}</span>
                    {s.sectionId === section.id && (
                      <Check className="sidebar-menu-check" size={14} aria-hidden="true" />
                    )}
                  </button>
                ))}
                {sections.length > 0 && <div className="sidebar-menu-separator" role="separator" />}
                <button
                  role="menuitem"
                  tabIndex={-1}
                  onClick={() => {
                    contextTrigger.current?.focus({ preventScroll: true });
                    newSection(s.id);
                  }}
                >
                  新建分区…
                </button>
              </Submenu>
              {s.sectionId && (
                <button
                  role="menuitem"
                  onClick={() => {
                    setMenuId('');
                    void attempt(() => changeSection(s, null));
                  }}
                >
                  <Layers size={14} />
                  移出分区
                </button>
              )}
            </>
          )}
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
            disabled={Boolean(projectMoveReason(s.id) || moveStatuses[s.id])}
            title={projectMoveReason(s.id) || moveStatuses[s.id] || undefined}
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
    </SidebarSessionRow>
  );
  /**
   * 1. 负责人汇总成员的待确认；隐藏成员时也汇总运行提示。
   * 2. 保留团队原有折叠设置，当前打开的成员始终可见。
   * 3. 成员按派发顺序跟在负责人后面。
   */
  const renderRow = (row: SidebarRow, showProject: boolean) => {
    const { session, members } = row;
    // 1. 把成员藏起来后，仍能从负责人行发现成员在运行或等确认。
    const activity = getSidebarRowActivity(row, activities);
    const selectedMember = members.some((member) => member.id === selected?.id);
    const showMembers = members.length > 0 && (sidebarView.teamMembers || selectedMember);
    // 2. 已结束的失败记录留在索引里，只用仍在派发中的失败和等待自动展开。
    const dispatching = members.some((member) => teamMemberActive(member.team!.status));
    const open =
      (!sidebarView.teamMembers && selectedMember) ||
      (teamOpen.get(session.id) ??
        members.some(
          (member) =>
            activities[member.id]?.pending ||
            (dispatching && ['failed', 'waiting'].includes(member.team!.status)),
        ));
    return (
      <div key={session.id}>
        {renderSession(
          session,
          activity.pending,
          sidebarView.teamMembers ? busy(activity.status) : activity.running,
          showProject,
        )}
        {showMembers && (
          <>
            {sidebarView.teamMembers && (
              <button
                className="team-sidebar-toggle"
                aria-expanded={open}
                onClick={() => setTeamOpen((before) => new Map(before).set(session.id, !open))}
              >
                <ChevronDown size={12} />
                {activity.activeMembers
                  ? `成员 · ${activity.activeMembers}/${members.length} 运行中`
                  : `${members.length} 个成员`}
              </button>
            )}
            {/* 3. 成员没有独立的分组位置。 */}
            {open && (
              <div className="team-sidebar-members">
                {members.map((member) =>
                  renderSession(
                    member,
                    activities[member.id]?.pending ?? 0,
                    busy(activities[member.id]?.status ?? member.lastStatus),
                    showProject,
                  ),
                )}
              </div>
            )}
          </>
        )}
      </div>
    );
  };
  const renderSessionList = (group: SidebarGroup | undefined, showProject = false) =>
    group && (
      <>
        {group.rows.map((row) => renderRow(row, showProject))}
        {group.olderRows.length > 0 && (
          <div className="older-sessions">
            <button
              className="older-sessions-toggle"
              aria-expanded={olderOpen.has(group.key)}
              onClick={() => setOlderOpen((current) => toggleKey(current, group.key))}
            >
              <ChevronDown size={13} />
              更早的会话 ({group.olderRows.length})
            </button>
            {olderOpen.has(group.key) && group.olderRows.map((row) => renderRow(row, showProject))}
          </div>
        )}
      </>
    );
  const mainGroups = new Map(groups.groups.map((group) => [group.key, group]));
  // 会话都显示在分区或置顶组时，原位置按空列表处理，仍给出新建入口。
  const hasMainRows = (key: string) => {
    const group = mainGroups.get(key);
    return Boolean(group && (group.rows.length || group.olderRows.length));
  };
  const collapsibleGroups = [
    ...groups.sections,
    ...(!projectMode && sidebarView.groupBy !== 'none' ? groups.groups : []),
  ];
  const collapsibleProjects = projectMode ? state.projects.map((item) => item.id) : [];
  const collapsibleOlder = groups.groups
    .filter((group) => group.olderRows.length > 0)
    .map((group) => group.key);
  const hasCollapsible = Boolean(
    collapsibleGroups.length || collapsibleProjects.length || collapsibleOlder.length,
  );
  const allExpanded =
    collapsibleGroups.every((group) => !collapsedGroups.has(group.key)) &&
    collapsibleProjects.every((id) => expandedProjects.has(id)) &&
    collapsibleOlder.every((key) => olderOpen.has(key));
  const toggleAll = (expanded: boolean) => {
    const replace = (before: Set<string>, keys: string[], include: boolean) => {
      const next = new Set(before);
      for (const key of keys) {
        if (include) {
          next.add(key);
          continue;
        }
        next.delete(key);
      }
      return next;
    };
    setCollapsedGroups((before) =>
      replace(
        before,
        collapsibleGroups.map((group) => group.key),
        !expanded,
      ),
    );
    setExpandedProjects((before) => replace(before, collapsibleProjects, expanded));
    setOlderOpen((before) => replace(before, collapsibleOlder, expanded));
  };
  const newSection = (sessionId?: string) => {
    setMenuId('');
    setRename({ kind: 'new-section', sessionId, name: '' });
  };
  const renderViewGroup = (group: SidebarGroup, section?: SidebarSectionGroup) => {
    const collapsible = Boolean(section) || (group.key !== 'pinned' && sidebarView.groupBy !== 'none');
    const expanded = !collapsible || !collapsedGroups.has(group.key);
    const menuOpen = menuId === group.key;
    const sectionMenu = section && menuOpen && (
      <div ref={menuRef} className="context-menu" role="menu" onKeyDown={handleMenuKeyDown}>
        <button
          role="menuitem"
          onClick={() => {
            setMenuId('');
            setRename({ kind: 'section', id: section.section.id, name: group.label });
          }}
        >
          <Pencil size={14} />
          重命名
        </button>
        <button
          role="menuitem"
          className="danger"
          onClick={() => {
            setMenuId('');
            void attempt(async () => {
              const result = await api.invoke('deleteSection', section.section.id);
              setNotice(`已删除分区“${result.name}”，${result.sessionCount} 个会话回到原来的分组`);
            });
          }}
        >
          <Trash2 size={14} />
          删除分区
        </button>
      </div>
    );
    return (
      <SidebarViewGroup
        key={group.key}
        group={group}
        expanded={expanded}
        onToggle={
          collapsible ? () => setCollapsedGroups((current) => toggleKey(current, group.key)) : undefined
        }
        section={
          section && {
            data: section,
            menuOpen,
            toggleMenu: () => setMenuId(menuOpen ? '' : group.key),
            menu: sectionMenu,
          }
        }
      >
        {expanded && renderSessionList(group, true)}
      </SidebarViewGroup>
    );
  };
  const ProjectRow = projectMode ? 'button' : 'div';
  return (
    <aside
      className="sidebar"
      id="project-sidebar"
      aria-label="项目与会话"
      hidden={!sidebar}
      inert={inspector && compact}
    >
      <div className="brand">
        <div className="sidebar-brand-title">
          <span className="brand-mark">π</span>
          <div className="sidebar-brand-label">Pi Desktop</div>
        </div>
        <div className="sidebar-brand-actions">
          <SidebarViewMenu
            view={sidebarView}
            onViewChange={changeSidebarView}
            onNewSection={() => newSection()}
            onToggleAll={toggleAll}
            allExpanded={allExpanded}
            canToggleAll={hasCollapsible}
          />
          <IconButton title={`搜索项目与会话 ${shortcut('K')}`} onClick={() => setSearchOpen(true)}>
            <Search size={17} />
          </IconButton>
        </div>
      </div>
      <button
        className="new-session"
        disabled={piUpdating}
        title={piUpdating ? 'Pi 正在更新' : `新建会话 ${shortcut('N')}`}
        onClick={() => void createSession()}
      >
        <Plus size={17} />
        <span className="new-session-label">新建会话</span>
        <kbd>{shortcut('N')}</kbd>
      </button>
      <div className="project-list">
        {groups.pinned && renderViewGroup(groups.pinned)}
        {groups.sections.map((section) => renderViewGroup(section, section))}
        {!projectMode && groups.groups.map((group) => renderViewGroup(group))}
        {projectMode && (
          <div data-drop-target="standalone" className="standalone-group">
            <div className="section-heading">
              对话<span className="session-drop-label">移到这里</span>
            </div>
            <div className="session-list standalone-sessions" aria-label="独立对话">
              {renderSessionList(mainGroups.get('project:standalone'))}
              {!hasMainRows('project:standalone') && (
                <p className="sidebar-empty">随时开始，无需打开项目。</p>
              )}
            </div>
          </div>
        )}
        <div className="section-heading">
          项目
          <IconButton
            title={piUpdating ? 'Pi 正在更新' : '添加项目'}
            disabled={piUpdating}
            onClick={addProject}
          >
            <Plus size={15} />
          </IconButton>
        </div>
        {!projectMode && (
          <div data-drop-target="standalone" className="project-group">
            <div className="project-header">
              <div className="project-header-main">
                <div className="project-row sidebar-project-directory-row">
                  <MessagesSquare size={16} />
                  <span>对话</span>
                  <span className="session-drop-label">移到这里</span>
                </div>
                <div className="project-actions">
                  <IconButton
                    disabled={piUpdating}
                    title={piUpdating ? 'Pi 正在更新' : '在对话中新建会话'}
                    onClick={() => void createSession()}
                  >
                    <Plus size={15} />
                  </IconButton>
                  <IconButton
                    title="对话操作"
                    expanded={menuId === 'standalone'}
                    onClick={() => setMenuId(menuId === 'standalone' ? '' : 'standalone')}
                  >
                    <MoreHorizontal size={15} />
                  </IconButton>
                </div>
              </div>
              {menuId === 'standalone' && (
                <div ref={menuRef} className="context-menu" role="menu">
                  <button
                    role="menuitem"
                    onClick={() => {
                      setMenuId('');
                      void attempt(() => api.invoke('importSession'));
                    }}
                  >
                    <Import size={14} />
                    导入 Pi 会话
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
        {state.projects.map((p) => (
          <div
            data-drop-target={p.id}
            className={'project-group ' + (p.id === project?.id ? 'selected' : '')}
            key={p.id}
          >
            <div className="project-header">
              <div className="project-header-main">
                <ProjectRow
                  className={'project-row' + (projectMode ? '' : ' sidebar-project-directory-row')}
                  aria-expanded={projectMode ? expandedProjects.has(p.id) : undefined}
                  onClick={
                    projectMode ? () => setExpandedProjects((current) => toggleKey(current, p.id)) : undefined
                  }
                >
                  <FolderOpen size={16} />
                  <span title={p.path}>{p.name}</span>
                  <span className="session-drop-label">移到这里</span>
                  {projectMode && !expandedProjects.has(p.id) && projectStatus(p.id)}
                  {projectMode && <ChevronDown size={13} className="project-chevron" />}
                </ProjectRow>
                <div className="project-actions">
                  <IconButton
                    disabled={piUpdating}
                    title={piUpdating ? 'Pi 正在更新' : `在 ${p.name} 中新建会话`}
                    onClick={() => void createSession(p.id)}
                  >
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
            {projectMode && expandedProjects.has(p.id) && (
              <div className="session-list" aria-label={`${p.name} 的会话`}>
                {renderSessionList(mainGroups.get(`project:${p.id}`))}
                {!hasMainRows(`project:${p.id}`) && (
                  <button
                    className="sidebar-project-empty"
                    disabled={piUpdating}
                    title={piUpdating ? 'Pi 正在更新' : undefined}
                    onClick={() => void createSession(p.id)}
                  >
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
      {moveId && sessionsById.has(moveId) && (
        <MoveSessionDialog
          session={sessionsById.get(moveId)!}
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
          {piUpdateUnseen && (
            <span className="pi-update-badge" aria-label="Pi 有新版本" title="Pi 有新版本" />
          )}
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
