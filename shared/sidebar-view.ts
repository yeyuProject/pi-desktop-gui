import type { SidebarView } from './types';

export const DEFAULT_SIDEBAR_VIEW: Readonly<SidebarView> = {
  groupBy: 'project',
  sortBy: 'updated',
  pinnedGroup: false,
  foldOlder: true,
  teamMembers: true,
};

export function parseSidebarView(value: unknown, strict = false): SidebarView {
  const view =
    value && typeof value === 'object' && !Array.isArray(value) ? (value as Partial<SidebarView>) : {};
  const groupBy = ['project', 'time', 'status', 'none'].includes(view.groupBy ?? '')
    ? view.groupBy
    : undefined;
  const sortBy = ['updated', 'created', 'title'].includes(view.sortBy ?? '') ? view.sortBy : undefined;
  const pinnedGroup = typeof view.pinnedGroup === 'boolean' ? view.pinnedGroup : undefined;
  const foldOlder = typeof view.foldOlder === 'boolean' ? view.foldOlder : undefined;
  const teamMembers = typeof view.teamMembers === 'boolean' ? view.teamMembers : undefined;
  if (strict && [groupBy, sortBy, pinnedGroup, foldOlder, teamMembers].includes(undefined))
    throw new Error('侧栏显示方式无效，请重新选择');
  return {
    groupBy: groupBy ?? DEFAULT_SIDEBAR_VIEW.groupBy,
    sortBy: sortBy ?? DEFAULT_SIDEBAR_VIEW.sortBy,
    pinnedGroup: pinnedGroup ?? DEFAULT_SIDEBAR_VIEW.pinnedGroup,
    foldOlder: foldOlder ?? DEFAULT_SIDEBAR_VIEW.foldOlder,
    teamMembers: teamMembers ?? DEFAULT_SIDEBAR_VIEW.teamMembers,
  };
}

export function sidebarSectionName(value: unknown) {
  if (typeof value !== 'string') return;
  const name = value.trim();
  if (name && name.length <= 80 && [...name].length <= 40 && !name.includes('\0')) return name;
}

export function sessionCreatedAtFromFile(file?: string) {
  const timestamp = file?.match(
    /(?:^|[/\\])(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3})Z_[^/\\]+\.jsonl$/,
  );
  if (!timestamp) return;
  const iso = `${timestamp[1]}:${timestamp[2]}:${timestamp[3]}.${timestamp[4]}Z`;
  const time = Date.parse(iso);
  // Date.parse can normalize dates such as February 30 instead of rejecting them.
  if (time >= 0 && new Date(time).toISOString() === iso) return time;
}
