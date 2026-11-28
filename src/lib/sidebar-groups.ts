import { DEFAULT_SIDEBAR_VIEW } from '../../shared/sidebar-view';
import { busy, type Session, type SidebarSection, type SidebarView } from '../../shared/types';
import { isOlderSession } from '../../shared/usage';
import type { SessionActivity } from './runtime-store';

type SidebarActivities = Readonly<Record<string, Pick<SessionActivity, 'status' | 'pending'>>>;

export interface SidebarRow {
  sessionId: string;
  session: Session;
  members: Session[];
}

export interface SidebarGroup {
  key: string;
  label: string;
  projectId?: string;
  rows: SidebarRow[];
  olderRows: SidebarRow[];
}

export interface SidebarSectionGroup extends SidebarGroup {
  section: SidebarSection;
  pinnedCount: number;
}

export interface SidebarGroups {
  pinned: SidebarGroup | undefined;
  sections: SidebarSectionGroup[];
  groups: SidebarGroup[];
}

export interface SidebarActiveDeferral {
  sessionId: string;
  groupKey: string;
}

const TIME_GROUPS = [
  ['time:today', '今天'],
  ['time:yesterday', '昨天'],
  ['time:week', '近 7 天'],
  ['time:month', '近 30 天'],
  ['time:older', '更早'],
] as const;
const STATUS_GROUPS = [
  ['status:pending', '待处理'],
  ['status:running', '运行中'],
  ['status:unread', '未查看'],
  ['status:other', '其他'],
] as const;
const titleCollator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });

function titleSegment(title: string) {
  const start = title.trimStart();
  if (/^[\p{N}\p{P}\p{S}]/u.test(start)) return 0;
  return /^\p{Script=Latin}/u.test(start) ? 1 : 2;
}

function localDay(timestamp: number) {
  const date = new Date(timestamp);
  // 用本地年月日换算日序号，夏令时当天长短不会影响分桶。
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000;
}

function sessionTime(session: Session, sortBy: SidebarView['sortBy']) {
  return sortBy === 'created' ? (session.createdAt ?? session.updatedAt) : session.updatedAt;
}

export function getSidebarRowActivity(row: SidebarRow, activities: SidebarActivities) {
  const status = activities[row.sessionId]?.status ?? row.session.lastStatus;
  let pending = activities[row.sessionId]?.pending ?? 0;
  let activeMembers = 0;
  for (const member of row.members) {
    pending += activities[member.id]?.pending ?? 0;
    activeMembers += Number(busy(activities[member.id]?.status ?? member.lastStatus));
  }
  return { status, pending, activeMembers, running: busy(status) || activeMembers > 0 };
}

function statusGroupKey(row: SidebarRow, activities: SidebarActivities, deferral?: SidebarActiveDeferral) {
  const { pending, running } = getSidebarRowActivity(row, activities);
  const { unread, lastStatus } = row.session;
  if (pending > 0 || (unread && (lastStatus === 'error' || lastStatus === 'interrupted')))
    return 'status:pending';
  if (
    !unread &&
    deferral?.sessionId === row.sessionId &&
    (deferral.groupKey === 'status:pending' || deferral.groupKey === 'status:unread')
  ) {
    return deferral.groupKey;
  }
  if (running) return 'status:running';
  return unread ? 'status:unread' : 'status:other';
}

function createGroup(key: string, label: string, projectId?: string): SidebarGroup {
  return { key, label, projectId, rows: [], olderRows: [] };
}

/**
 * 1. 按负责人索引成员，原负责人已删除时保留成员入口。
 * 2. 依次处理全局置顶、分区、主列表，每个会话只放到一个位置。
 * 3. 按视图给主列表分组，沿用旧会话折叠规则，并对各组排序。
 */
export function buildSidebarGroups(
  sessions: readonly Session[],
  activities: SidebarActivities,
  view: SidebarView = DEFAULT_SIDEBAR_VIEW,
  sections: readonly SidebarSection[] = [],
  now: number,
  activeDeferral?: SidebarActiveDeferral,
): SidebarGroups {
  // 1. 新会话在输入中靠前，反转成员列表才能还原派发顺序。
  const sessionIds = new Set(sessions.map((session) => session.id));
  const membersByLead = new Map<string, Session[]>();
  for (const session of sessions) {
    if (!session.team || !sessionIds.has(session.team.leadId)) continue;
    const members = membersByLead.get(session.team.leadId) ?? [];
    members.push(session);
    membersByLead.set(session.team.leadId, members);
  }

  const pinned = createGroup('pinned', '置顶');
  const sectionGroups = sections.map((section) => ({
    ...createGroup(`section:${section.id}`, section.name),
    section,
    pinnedCount: 0,
  }));
  const bySectionId = new Map(sectionGroups.map((group) => [group.section.id, group]));
  const mainGroups = new Map<string, SidebarGroup>(
    (view.groupBy === 'time'
      ? TIME_GROUPS
      : view.groupBy === 'status'
        ? STATUS_GROUPS
        : view.groupBy === 'project'
          ? [['project:standalone', '对话']]
          : [['none:all', '会话']]
    ).map(([key, label]) => [key, createGroup(key, label)]),
  );
  const today = view.groupBy === 'time' ? localDay(now) : 0;

  for (const session of sessions) {
    if (session.team && sessionIds.has(session.team.leadId)) continue;
    const row = { sessionId: session.id, session, members: membersByLead.get(session.id)?.reverse() ?? [] };
    const section = !session.team && session.sectionId ? bySectionId.get(session.sectionId) : undefined;

    // 2. 置顶优先显示，原分区仍要把这条会话计入标题总数。
    if (view.pinnedGroup && session.pinned) {
      pinned.rows.push(row);
      if (section) section.pinnedCount++;
      continue;
    }
    if (section) {
      section.rows.push(row);
      continue;
    }

    // 3. 「更早的会话」只在仍有必要的组出现，并且始终按更新时间判断。
    const daysAgo = view.groupBy === 'time' ? today - localDay(sessionTime(session, view.sortBy)) : 0;
    const key =
      view.groupBy === 'project'
        ? `project:${session.projectId ?? 'standalone'}`
        : view.groupBy === 'time'
          ? TIME_GROUPS[daysAgo <= 0 ? 0 : daysAgo === 1 ? 1 : daysAgo < 7 ? 2 : daysAgo < 30 ? 3 : 4][0]
          : view.groupBy === 'status'
            ? statusGroupKey(row, activities, activeDeferral)
            : 'none:all';
    const group = mainGroups.get(key) ?? createGroup(key, '', session.projectId);
    mainGroups.set(key, group);
    const foldOlder =
      view.foldOlder && (view.groupBy === 'project' || key === 'none:all' || key === 'status:other');
    (foldOlder && isOlderSession(session, now) ? group.olderRows : group.rows).push(row);
  }

  const groups = [...mainGroups.values()].filter(
    (group) =>
      view.groupBy === 'project' || view.groupBy === 'none' || group.rows.length || group.olderRows.length,
  );
  const compare = ({ session: a }: SidebarRow, { session: b }: SidebarRow) =>
    Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) ||
    (view.sortBy === 'title'
      ? titleSegment(a.title) - titleSegment(b.title) ||
        titleCollator.compare(a.title, b.title) ||
        b.updatedAt - a.updatedAt
      : sessionTime(b, view.sortBy) - sessionTime(a, view.sortBy));
  for (const group of [pinned, ...sectionGroups, ...groups]) {
    group.rows.sort(compare);
    group.olderRows.sort(compare);
  }
  return { pinned: pinned.rows.length ? pinned : undefined, sections: sectionGroups, groups };
}
